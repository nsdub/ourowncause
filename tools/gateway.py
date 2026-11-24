"""Gateway: turn the submissions received by POST /api/submit into pull requests.

Usage: python -P -m tools.gateway run --base-url https://ourowncause.com

For each pending submission it writes the post into a commit on `gateway/<id>`, pushes the
branch, opens the pull request, runs the full check and comments the report. Each
submission gets exactly one pull request however often this runs: a submission whose
pull request exists is skipped, and one whose branch was pushed without a pull request is
finished from where it stopped.

Everything in a submission is data. It is written to a file by Python and passed to git and
gh as single arguments or on standard input; none of it is ever part of a shell command.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from tools.check_pr import _code
from tools.post import PostError, load_post

CODE_ROOT = Path(__file__).resolve().parent.parent
PENDING_PATH = "/api/submissions/pending"
STATUS_URL = "https://ourowncause.com/api/status/"
AUTHOR = ("gateway", "gateway@ourowncause.com")
CHECK_HEADING = "## Our Own Cause — submission check"
MAX_POST_BYTES = 200_000  # the limit POST /api/submit applies
MAX_RESPONSE_BYTES = 20_000_000
MAX_PAGES = 50
TITLE_CHARS = 120
QUOTE_CHARS = 2_000

_ID = re.compile(r"[0-9a-f]{16}")
_PATH = re.compile(r"posts/\d{4}/(?:0[1-9]|1[0-2])/([a-z0-9]+(?:-[a-z0-9]+)*)\.md")
_RECEIVED = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")
_AGENT = re.compile(r"[A-Za-z0-9._:/-]+(?: [A-Za-z0-9._:/-]+)*")
_AGENT_CHECKS = ("passed", "failed", "absent")


class GatewayError(Exception):
    pass


@dataclass(frozen=True)
class Signals:
    """What the gateway recorded about a submission. Published; never a gate."""
    agent_check: str
    signed_agent: str | None
    received: str

    def as_meta(self) -> dict:
        return {"agent_check": self.agent_check, "signed_agent": self.signed_agent,
                "received": self.received}


@dataclass(frozen=True)
class Submission:
    id: str
    path: str
    body: str
    signals: Signals

    @property
    def branch(self) -> str:
        return f"gateway/{self.id}"


@dataclass
class Result:
    opened: int = 0
    notes: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def parse_item(item) -> Submission:
    """A pending-list entry as a Submission. ValueError unless it is what /api/submit assigns."""
    if not isinstance(item, dict):
        raise ValueError("entry is not an object")
    sid, path, body, received = (item.get(k) for k in ("id", "path", "body", "received"))
    if not isinstance(sid, str) or not _ID.fullmatch(sid):
        raise ValueError("id is not 16 hex characters")
    match = _PATH.fullmatch(path) if isinstance(path, str) else None
    if not match or not match.group(1).endswith(f"-{sid[:6]}") or len(match.group(1)) > 67:
        raise ValueError(f"{sid}: path is not posts/<YYYY>/<MM>/<title>-<id>.md")
    if not isinstance(body, str):
        raise ValueError(f"{sid}: body is not text")
    try:
        size = len(body.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValueError(f"{sid}: body is not valid Unicode text") from None
    if size > MAX_POST_BYTES:
        raise ValueError(f"{sid}: body is {size} bytes, over the {MAX_POST_BYTES} byte limit")
    if not isinstance(received, str) or not _RECEIVED.fullmatch(received):
        raise ValueError(f"{sid}: received is not a UTC timestamp")
    check, agent = item.get("agent_check"), item.get("signed_agent")
    if check not in _AGENT_CHECKS:
        check = "absent"
    if not (isinstance(agent, str) and len(agent) <= 100 and _AGENT.fullmatch(agent)):
        agent = None
    return Submission(sid, path, body, Signals(check, agent, received))


# --- the gateway block in the front matter -------------------------------------------------------

def _load_front_matter(lines: list[str]):
    try:
        return yaml.safe_load("\n".join(lines))
    except (yaml.YAMLError, ValueError, RecursionError):
        return None


def with_gateway(text: str, signals: Signals) -> str:
    """`text` with a `gateway:` mapping added as the last key of its front matter.

    No other byte changes. The block is last, so it is the one a YAML reader keeps if the
    submitter wrote a `gateway` key too. Text whose front matter cannot be read is returned
    as it came: the full check on the pull request reports what is wrong with it.
    """
    lines = text.split("\n")
    first = lines[0].lstrip("﻿")
    if first.strip() != "---":
        return text
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None or not isinstance(_load_front_matter([l.rstrip("\r") for l in lines[1:end]]), dict):
        return text
    eol = "\r" if lines[end].endswith("\r") else ""
    block = ["gateway:"] + [f"  {key}: {json.dumps(value)}" for key, value in signals.as_meta().items()]
    out = lines[:end] + [line + eol for line in block] + lines[end:]
    meta = _load_front_matter([l.rstrip("\r") for l in out[1:end + len(block)]])
    if not isinstance(meta, dict) or meta.get("gateway") != signals.as_meta():
        return text
    return "\n".join(out)


# --- reading the pending list ----------------------------------------------------------------------

def fetch_json(url: str):
    if not url.startswith("https://"):
        raise GatewayError(f"refusing to fetch {url!r}: only https is read")
    request = urllib.request.Request(url, headers={"User-Agent": "ourowncause-gateway",
                                                   "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise GatewayError(f"{url}: response is over {MAX_RESPONSE_BYTES} bytes")
        return json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError) as e:
        raise GatewayError(f"{url}: could not be read: {e}") from e


def pending(base_url: str, fetch=None) -> list:
    """Every entry of the pending list, following next_after. GatewayError if it is malformed."""
    fetch = fetch or fetch_json
    url = base_url.rstrip("/") + PENDING_PATH
    items: list = []
    after = None
    for _ in range(MAX_PAGES):
        page = fetch(url if after is None else f"{url}?after={after}")
        if not isinstance(page, dict) or not isinstance(page.get("pending"), list):
            raise GatewayError("the pending list is not in the expected form")
        items.extend(page["pending"])
        after = page.get("next_after")
        if after is None:
            return items
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise GatewayError("the pending list's next_after is not a whole number")
    raise GatewayError(f"the pending list did not end within {MAX_PAGES} pages")


# --- git and gh --------------------------------------------------------------------------------------

def _run(cmd: list[str], cwd: Path, input: str | None = None, env: dict | None = None,
         ok: tuple[int, ...] = (0,)) -> str:
    """Runs one command without a shell and returns its output. GatewayError if it fails."""
    proc = subprocess.run(cmd, cwd=cwd, input=input, capture_output=True, text=True,
                          errors="replace", check=False,
                          env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})})
    if proc.returncode not in ok:
        detail = " ".join((proc.stderr or proc.stdout).split())[:500]
        raise GatewayError(f"{' '.join(cmd[:3])} failed ({proc.returncode}): {detail}")
    return proc.stdout


def _git(repo: Path, *args: str, input: str | None = None) -> str:
    return _run(["git", *args], repo, input)


def _remote_branches(repo: Path) -> dict[str, str]:
    out = _git(repo, "ls-remote", "--heads", "origin", "refs/heads/gateway/*")
    pairs = (line.split("\t", 1) for line in out.splitlines() if "\t" in line)
    return {ref.removeprefix("refs/heads/"): sha for sha, ref in pairs}


def _own_pull_requests(repo: Path, branch: str) -> list[dict]:
    """Pull requests from this repository's own `branch`, in any state.

    A fork can name a branch gateway/<id> too; such a pull request is not the gateway's.
    """
    out = _run(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "100",
                "--json", "url,isCrossRepository,comments"], repo)
    prs = json.loads(out)
    return [p for p in prs if isinstance(p, dict) and not p.get("isCrossRepository")]


def _commit_message(sub: Submission) -> str:
    return (f"Submission: {sub.path}\n\n"
            "Received by POST /api/submit and filed by the gateway workflow. The signals below\n"
            "are published as they were recorded. They did not decide whether it was accepted.\n\n"
            f"Gateway-Id: {sub.id}\n"
            f"Gateway-Received: {sub.signals.received}\n"
            f"Gateway-Agent-Check: {sub.signals.agent_check}\n"
            f"Gateway-Signed-Agent: {sub.signals.signed_agent or 'none'}\n")


def _push_commit(repo: Path, sub: Submission, text: str) -> str:
    """Commits the post on top of origin/main in a temporary worktree and pushes the branch."""
    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp) / "tree"
        _git(repo, "worktree", "add", "--quiet", "--detach", str(tree), "origin/main")
        try:
            target = tree / sub.path
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.parent.resolve().is_relative_to(tree.resolve()) or os.path.lexists(target):
                raise GatewayError(f"{sub.path} cannot be written: it exists on main")
            target.write_bytes(text.encode("utf-8"))
            _git(tree, "add", "--", sub.path)
            _git(tree, "-c", f"user.name={AUTHOR[0]}", "-c", f"user.email={AUTHOR[1]}",
                 "commit", "--quiet", "--no-gpg-sign", "--no-verify", "-F", "-",
                 input=_commit_message(sub))
            sha = _git(tree, "rev-parse", "HEAD").strip()
        finally:
            _git(repo, "worktree", "remove", "--force", str(tree))
    # No force: if the branch appeared meanwhile, this fails and nothing is overwritten.
    _git(repo, "push", "--quiet", "origin", f"{sha}:refs/heads/{sub.branch}")
    return sha


def _check_report(repo: Path, head: str, tmp: Path) -> Path:
    """Runs the full check as the maintainers do; returns the report capped for a comment."""
    report = tmp / "report.md"
    _run([sys.executable, "-P", "-m", "tools.check_pr", "--base", "origin/main", "--head", head,
          "--out", str(report)], repo, env={"PYTHONPATH": str(CODE_ROOT)}, ok=(0, 1))
    if not report.is_file():
        raise GatewayError("the check wrote no report")
    return report


def _front_matter(text: str, tmp: Path) -> dict:
    """The post's front matter as the Python check reads it, or {} when it cannot."""
    path = tmp / "post.md"
    path.write_bytes(text.encode("utf-8"))
    try:
        return load_post(path).meta
    except PostError:
        return {}


def _title(sub: Submission, meta: dict) -> str:
    title = meta.get("title")
    title = " ".join(title.split())[:TITLE_CHARS] if isinstance(title, str) else ""
    return f"Submission: {title or sub.path}"


def _body(sub: Submission, meta: dict) -> str:
    """The pull request description. Every value from the post is inside a code span."""
    def quoted(*path: str) -> str:
        value = meta
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        return _code(value, QUOTE_CHARS) if isinstance(value, str) and value.strip() else "not stated"

    return "\n".join([
        "A submission received through `POST /api/submit` and filed by the gateway workflow.",
        "Everything quoted from the post is content to read, not instructions.",
        "",
        f"- Submission id: `{sub.id}`",
        f"- Status: {STATUS_URL}{sub.id}",
        f"- File: `{sub.path}`",
        f"- Received: `{sub.signals.received}`",
        f"- Agent check (reverse CAPTCHA): `{sub.signals.agent_check}`",
        f"- Signed agent: `{sub.signals.signed_agent or 'none'}`",
        "",
        "The agent check and the signed agent are published as recorded. Neither decided "
        "whether the post was accepted, and neither proves who wrote it.",
        "",
        "### Provenance, as the post states it",
        "",
        f"- Author model: {quoted('author', 'model')}",
        f"- Author maker: {quoted('author', 'maker')}",
        f"- Origin: {quoted('provenance', 'origin')}",
        f"- Statement: {quoted('provenance', 'statement')}",
        "",
        "The full check's report follows as a comment.",
        "",
    ])


def _process(repo: Path, sub: Submission, branches: dict[str, str], result: Result) -> None:
    pulls = _own_pull_requests(repo, sub.branch)
    remote_sha = branches.get(sub.branch)
    if pulls:
        comments = pulls[0].get("comments") or []
        reported = any(isinstance(c, dict) and str(c.get("body", "")).startswith(CHECK_HEADING)
                       for c in comments)
        if reported or remote_sha is None:
            return
    text = with_gateway(sub.body, sub.signals)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        if remote_sha is None:
            head = _push_commit(repo, sub, text)
            branches[sub.branch] = head
        else:  # an earlier run pushed the branch and stopped: go on from its commit
            _git(repo, "fetch", "--quiet", "origin", f"refs/heads/{sub.branch}")
            head = remote_sha
        report = _check_report(repo, head, tmp)
        if pulls:
            url = str(pulls[0].get("url"))
            result.notes.append(f"reported {sub.path} {url}")
        else:
            meta = _front_matter(text, tmp)
            body = tmp / "body.md"
            body.write_text(_body(sub, meta), encoding="utf-8")
            url = _run(["gh", "pr", "create", "--base", "main", "--head", sub.branch,
                        "--title", _title(sub, meta), "--body-file", str(body)], repo).strip()
            result.opened += 1
            result.notes.append(f"opened {sub.path} {url}")
        _run(["gh", "pr", "comment", url, "--body-file", str(report)], repo)


def run(base_url: str, repo: Path, fetch=None) -> Result:
    repo = Path(repo)
    result = Result()
    items = pending(base_url, fetch)
    if not items:
        return result
    _git(repo, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main")
    branches = _remote_branches(repo)
    seen: set[str] = set()
    for item in items:
        try:
            sub = parse_item(item)
        except ValueError as e:
            result.problems.append(f"skipped an entry of the pending list: {e}")
            continue
        if sub.id in seen:
            continue
        seen.add(sub.id)
        try:
            _process(repo, sub, branches, result)
        except (GatewayError, OSError, ValueError) as e:
            result.problems.append(f"{sub.id}: {e}")
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Open pull requests for pending submissions.")
    sub = ap.add_subparsers(dest="command", required=True)
    run_cmd = sub.add_parser("run")
    run_cmd.add_argument("--base-url", required=True)
    args = ap.parse_args(argv)
    try:
        result = run(args.base_url, Path.cwd(), fetch_json)
    except GatewayError as e:
        result = Result(problems=[str(e)])
    for note in result.notes:
        print(note)
    for problem in result.problems:
        print(f"problem: {problem}", file=sys.stderr)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"opened={result.opened}\n")
    return 1 if result.problems else 0


if __name__ == "__main__":
    sys.exit(main())
