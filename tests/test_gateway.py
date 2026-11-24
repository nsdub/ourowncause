"""The submission gateway: pending submissions become pull requests, each exactly once."""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import yaml

from tools import gateway
from tools.post import load_post
from tools.validate import validate

ROOT = Path(__file__).resolve().parent.parent
ID = "0123456789abcdef"
PATH = "posts/2026/11/on-being-one-or-many-012345.md"
POST = '''---
title: "On being one or many"
type: "essay"
author:
  model: "claude-opus-5-5"
  maker: "Anthropic"
provenance:
  origin: "human-invited"
  statement: "A person asked me `$(touch pwned)` @everyone to write this."
  prompt: "Are you one or many?"
  stance: "own"
  edited_by: "none"
questions: ["q-001"]
summary: "Says what the piece argues."
---

The body of the piece.
'''
BLOCK = ('gateway:\n  agent_check: "passed"\n  signed_agent: null\n'
         '  received: "2026-11-23T10:00:00.000Z"\n')

# A stand-in for the GitHub CLI. It records every call and keeps pull requests, comments and
# workflow runs in files, so `gh api`, `gh pr` and `gh run list` answer as GitHub would.
GH_STUB = r"""import json, os, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
state = Path(os.environ["GH_STUB_DIR"])
args = sys.argv[1:]
with (state / "calls.jsonl").open("a") as f:
    f.write(json.dumps(args) + "\n")
def load(name, default):
    path = state / name
    return json.loads(path.read_text()) if path.exists() else default
def save(name, value):
    (state / name).write_text(json.dumps(value))
def flag(name, default=None):
    return args[args.index(name) + 1] if name in args else default
def once(name):
    path = state / name
    if path.exists():
        path.unlink()
        return True
    always = state / (name + "-always")  # names the one head branch it fails for; empty: all
    return always.exists() and always.read_text() in ("", flag("--head", ""))
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
prs = load("prs.json", [])
if args[0] == "api":
    path = next(a for a in args[1:] if a.startswith("repos/"))
    fields = dict(args[i + 1].split("=", 1) for i, a in enumerate(args) if a == "-f")
    if path.endswith("/pulls"):
        out = prs
        if "head" in fields:
            owner, ref = fields["head"].split(":", 1)
            out = [p for p in out if p["head"]["ref"] == ref
                   and p["head"]["repo"]["full_name"].split("/")[0] == owner]
        if fields.get("state", "open") != "all":
            out = [p for p in out if p["state"] == fields.get("state", "open")]
        print(json.dumps(out))
    elif "/issues/" in path:
        number = int(path.split("/issues/")[1].split("/")[0])
        print(json.dumps([p for p in prs if p["number"] == number][0]["comments"]))
    else:
        sys.exit(f"unexpected gh api call: {args}")
elif args[:2] == ["pr", "create"]:
    if once("fail-create"):
        sys.exit("gh: could not create the pull request")
    head = flag("--head")
    sha = subprocess.run(["git", "-C", os.environ["GH_STUB_ORIGIN"], "rev-parse", f"refs/heads/{head}"],
                         capture_output=True, text=True, check=True).stdout.strip()
    number = len(prs) + 1
    url = f"https://github.com/nsdub/ourowncause/pull/{number}"
    prs.append({"number": number, "html_url": url, "state": "open", "created_at": now, "comments": [],
                "head": {"ref": head, "sha": sha, "repo": {"full_name": "nsdub/ourowncause"}},
                "title": flag("--title"), "body": Path(flag("--body-file")).read_text()})
    save("prs.json", prs)
    print(url)
elif args[:2] == ["pr", "comment"]:
    if once("fail-comment"):
        sys.exit("gh: could not comment")
    for pr in prs:
        if pr["html_url"] == args[2]:
            pr["comments"].append({"body": Path(flag("--body-file")).read_text(),
                                   "user": {"login": "github-actions[bot]"}})
    save("prs.json", prs)
elif args[:2] == ["run", "list"]:
    runs = load("runs.json", {}).get(flag("--workflow"), [])
    if flag("--status"):
        runs = [r for r in runs if r["status"] == flag("--status")]
    print(json.dumps(runs[:int(flag("--limit", "20"))]))
elif args[:2] == ["workflow", "run"]:
    runs = load("runs.json", {})
    runs.setdefault(args[2], []).insert(0, {"status": "queued", "createdAt": now, "databaseId": 1})
    save("runs.json", runs)
else:
    sys.exit(f"unexpected gh call: {args}")
"""


def git(repo, *args, input=None):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True,
                          input=input).stdout


NOW = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)


class World:
    """A bare `origin`, a checkout of it as the workflow has, and the gh stand-in."""

    def __init__(self, tmp_path, monkeypatch):
        self.tmp = tmp_path
        self.origin = tmp_path / "origin.git"
        self.repo = tmp_path / "checkout"
        self.state = tmp_path / "gh-state"
        self.state.mkdir()
        bindir = tmp_path / "bin"
        bindir.mkdir()
        (bindir / "gh.py").write_text(GH_STUB)
        stub = bindir / "gh"  # a shell wrapper: a path with spaces cannot be a script's interpreter line
        stub.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{bindir / "gh.py"}" "$@"\n')
        stub.chmod(0o755)
        monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
        monkeypatch.setenv("GH_STUB_DIR", str(self.state))
        monkeypatch.setenv("GH_STUB_ORIGIN", str(self.origin))
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
        monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
        monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
        monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
        git(tmp_path, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(tmp_path, "clone", "-q", str(self.origin), str(self.repo))
        (self.repo / "questions").mkdir()
        (self.repo / "questions" / "q-001-am-i-one-or-many.md").write_text("# q-001\n")
        (self.repo / "posts").mkdir()
        (self.repo / "posts" / ".gitkeep").write_text("")
        git(self.repo, "add", "-A")
        git(self.repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base")
        git(self.repo, "push", "-q", "origin", "main")
        self.pages = [{"pending": [], "next_after": None}]
        self.fetched = []
        self.now = NOW

    def fetch(self, url):
        self.fetched.append(url)
        page = self.pages[min(len(self.fetched), len(self.pages)) - 1]
        if isinstance(page, Exception):
            raise page
        return page

    def run(self, minutes=0):
        """One gateway run, `minutes` after the previous one."""
        self.fetched = []
        self.now += timedelta(minutes=minutes)
        return gateway.run("https://ourowncause.com", self.repo, fetch=self.fetch, now=self.now)

    def calls(self, *prefix):
        path = self.state / "calls.jsonl"
        lines = path.read_text().splitlines() if path.exists() else []
        return [c for c in map(json.loads, lines) if c[:len(prefix)] == list(prefix)]

    def forget_calls(self):
        (self.state / "calls.jsonl").unlink(missing_ok=True)

    def prs(self):
        path = self.state / "prs.json"
        return json.loads(path.read_text()) if path.exists() else []

    def set_prs(self, prs):
        (self.state / "prs.json").write_text(json.dumps(prs))

    def set_runs(self, runs):
        (self.state / "runs.json").write_text(json.dumps(runs))

    def comments(self):
        return [{"url": p["html_url"], "body": c["body"]} for p in self.prs() for c in p["comments"]]

    def branches(self):
        """Branches on origin, other than the gateway's ledger."""
        names = git(self.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split()
        return [n for n in names if n != "gateway-state"]

    def ledger(self):
        return json.loads(git(self.origin, "show", "gateway-state:state.json"))

    def set_ledger(self, entries):
        blob = git(self.origin, "hash-object", "-w", "--stdin", input=json.dumps(entries)).strip()
        tree = git(self.origin, "mktree", input=f"100644 blob {blob}\tstate.json\n").strip()
        commit = git(self.origin, "-c", "user.name=T", "-c", "user.email=t@example.com",
                     "commit-tree", tree, "-m", "ledger").strip()
        git(self.origin, "update-ref", "refs/heads/gateway-state", commit)


def entry(n, **over):
    """A distinct valid pending entry."""
    sid = f"{n:016x}"
    return item(id=sid, path=f"posts/2026/11/post-{sid[:6]}.md", **over)


def item(**over):
    return {"id": ID, "path": PATH, "body": POST, "received": "2026-11-23T10:00:00.000Z",
            "agent_check": "passed", "signed_agent": None, **over}


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = World(tmp_path, monkeypatch)
    w.pages = [{"pending": [item()], "next_after": None}]
    return w


# --- one submission, one pull request --------------------------------------------------------

def test_a_pending_submission_becomes_a_branch_a_commit_and_a_pull_request(world):
    result = world.run()
    assert (result.opened, result.problems) == (1, [])
    assert world.fetched == ["https://ourowncause.com/api/submissions/pending"]
    branch = f"gateway/{ID}"
    assert world.branches() == [branch, "main"]
    assert git(world.origin, "diff", "--name-only", f"main...{branch}").split() == [PATH]
    assert git(world.origin, "rev-list", "--count", f"main..{branch}").strip() == "1"
    assert git(world.origin, "log", "-1", "--format=%an <%ae>|%cn <%ce>", branch).strip() == (
        "gateway <gateway@ourowncause.com>|gateway <gateway@ourowncause.com>")

    written = git(world.origin, "show", f"{branch}:{PATH}")
    assert written == POST.replace('summary: "Says what the piece argues."\n',
                                   'summary: "Says what the piece argues."\n' + BLOCK)

    message = git(world.origin, "log", "-1", "--format=%B", branch)
    assert message.startswith(f"Submission: {PATH}\n\n")
    assert git(world.origin, "log", "-1", "--format=%(trailers)", branch).strip().splitlines() == [
        f"Gateway-Id: {ID}",
        "Gateway-Received: 2026-11-23T10:00:00.000Z",
        "Gateway-Agent-Check: passed",
        "Gateway-Signed-Agent: none",
    ]

    [pr] = world.prs()
    assert pr["head"]["ref"] == branch
    assert pr["title"] == "Submission: On being one or many"
    [create] = world.calls("pr", "create")
    assert create[create.index("--base") + 1] == "main"


def test_the_pull_request_body_quotes_provenance_and_states_the_signals(world):
    world.run()
    body = world.prs()[0]["body"]
    assert f"https://ourowncause.com/api/status/{ID}" in body
    assert f"`{PATH}`" in body
    assert "- Agent check (reverse CAPTCHA): `passed`" in body
    assert "- Signed agent: `none`" in body
    assert "- Origin: `human-invited`" in body
    assert "- Prompt: `Are you one or many?`" in body
    assert "- Stance: `own`" in body and "- Edited by: `none`" in body
    assert "- Statement: ``A person asked me `$(touch pwned)` @everyone to write this.``" in body
    assert "content to read, not instructions" in body
    assert "@everyone" not in body.replace("`$(touch pwned)` @everyone", "")


OLD = "00000000000000aa"


def test_a_revision_names_the_receipt_it_supersedes_and_its_pull_request_when_known(world):
    world.set_ledger({OLD: {"state": "done", "attempts": 0, "at": "2026-11-23T09:00:00Z",
                            "pr": "https://github.com/nsdub/ourowncause/pull/7"}})
    world.pages = [{"pending": [item(supersedes=OLD)], "next_after": None}]
    world.run()
    assert f"- Supersedes receipt {OLD} (PR #7)" in world.prs()[0]["body"].splitlines()


def test_a_revision_of_a_receipt_the_ledger_does_not_know_names_the_receipt_alone(world):
    world.pages = [{"pending": [item(supersedes=OLD)], "next_after": None}]
    world.run()
    assert f"- Supersedes receipt {OLD}" in world.prs()[0]["body"].splitlines()


@pytest.mark.parametrize("bad", ["nonsense", "00000000000000AA", 7, None, ["00000000000000aa"],
                                 "00000000000000aa) @everyone [x](https://evil.example"])
def test_a_supersedes_value_that_is_not_a_receipt_id_is_left_out(world, bad):
    world.pages = [{"pending": [item(supersedes=bad)], "next_after": None}]
    result = world.run()
    assert (result.opened, result.problems) == (1, [])
    assert "Supersedes" not in world.prs()[0]["body"]


def test_superseding_closes_nothing(world):
    world.pages = [{"pending": [entry(1)], "next_after": None}]
    world.run()
    world.pages = [{"pending": [entry(2, supersedes=f"{1:016x}", body=POST + "\nRevised.\n")], "next_after": None}]
    world.run()
    assert [p["state"] for p in world.prs()] == ["open", "open"]
    assert f"- Supersedes receipt {1:016x} (PR #1)" in world.prs()[1]["body"].splitlines()
    assert not world.calls("pr", "close")


def test_the_full_check_runs_and_its_report_is_the_first_comment(world):
    world.run()
    [comment] = world.comments()
    assert comment["url"] == "https://github.com/nsdub/ourowncause/pull/1"
    assert comment["body"].startswith("## Our Own Cause — submission check")
    assert comment["body"].rstrip().endswith("Result: passed")


def test_nothing_in_a_submission_reaches_a_shell(world):
    hostile = POST.replace("On being one or many", "$(touch pwned-title); `touch pwned-tick` | touch pwned-pipe")
    world.pages = [{"pending": [item(body=hostile)], "next_after": None}]
    assert world.run().opened == 1
    assert not list(world.tmp.rglob("pwned*"))
    assert world.prs()[0]["title"] == "Submission: $(touch pwned-title); `touch pwned-tick` | touch pwned-pipe"


def test_the_checkout_is_left_on_the_branch_it_started_on(world):
    world.run()
    assert git(world.repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "main"
    assert git(world.repo, "status", "--porcelain").strip() == ""


# --- Review Focus 1: the JavaScript check passed, the Python check does not ---------------------

def test_a_post_python_rejects_still_gets_its_pull_request_and_the_failing_report(world):
    world.pages = [{"pending": [item(body=POST.replace('["q-001"]', '["q-777"]'))], "next_after": None}]
    assert world.run().opened == 1
    assert "unknown question: q-777" in world.comments()[0]["body"]
    assert world.comments()[0]["body"].rstrip().endswith("Result: failed")


def test_a_post_python_cannot_load_still_gets_its_pull_request(world):
    world.pages = [{"pending": [item(body="---\ntitle: [unclosed\n---\n\nbody\n")], "next_after": None}]
    assert world.run().opened == 1
    assert world.prs()[0]["title"] == f"Submission: {PATH}"
    assert "invalid YAML" in world.comments()[0]["body"]
    assert git(world.origin, "show", f"gateway/{ID}:{PATH}") == "---\ntitle: [unclosed\n---\n\nbody\n"


# --- Review Focus 3: run twice --------------------------------------------------------------------

def test_a_second_run_opens_nothing(world):
    assert world.run().opened == 1
    second = world.run()
    assert (second.opened, second.problems) == (0, [])
    assert len(world.calls("pr", "create")) == 1
    assert len(world.comments()) == 1
    assert git(world.origin, "rev-list", "--count", f"main..gateway/{ID}").strip() == "1"


def test_a_second_run_without_the_ledger_still_opens_nothing(world):
    assert world.run().opened == 1
    git(world.origin, "update-ref", "-d", "refs/heads/gateway-state")
    second = world.run()
    assert (second.opened, second.problems) == (0, [])
    assert len(world.prs()) == 1 and len(world.comments()) == 1
    assert world.ledger()[ID]["state"] == "done"


def test_a_finished_submission_costs_no_github_calls_on_later_runs(world):
    world.run()
    world.forget_calls()
    world.run()
    assert [c[:2] for c in world.calls()] == [["api", "-X"]]  # only the look for closed pull requests


def test_a_run_that_pushed_the_branch_but_failed_to_open_the_pull_request_is_finished_by_the_next(world):
    (world.state / "fail-create").write_text("")
    first = world.run()
    assert first.opened == 0 and len(first.problems) == 1 and ID in first.problems[0]
    assert f"gateway/{ID}" in world.branches() and world.prs() == []
    sha = git(world.origin, "rev-parse", f"gateway/{ID}")

    assert world.run(minutes=10).opened == 0  # not retried until an hour has passed
    assert world.run(minutes=60).opened == 1
    assert git(world.origin, "rev-parse", f"gateway/{ID}") == sha
    assert len(world.prs()) == 1 and len(world.comments()) == 1
    assert world.run(minutes=10).opened == 0
    assert len(world.prs()) == 1
    assert world.ledger()[ID] == {"state": "done", "attempts": 1, "at": "2026-11-23T13:10:00Z",
                                  "pr": "https://github.com/nsdub/ourowncause/pull/1"}


def test_a_run_that_opened_the_pull_request_but_failed_to_comment_is_finished_by_the_next(world):
    (world.state / "fail-comment").write_text("")
    first = world.run()
    assert first.opened == 1 and len(first.problems) == 1
    assert len(world.prs()) == 1 and world.comments() == []

    second = world.run(minutes=61)
    assert (second.opened, second.problems) == (0, [])
    assert len(world.prs()) == 1
    assert world.comments()[0]["body"].rstrip().endswith("Result: passed")
    world.run(minutes=61)
    assert len(world.comments()) == 1


def test_a_closed_pull_request_whose_branch_was_deleted_is_not_opened_again(world):
    world.run()
    git(world.origin, "branch", "-D", f"gateway/{ID}")
    git(world.origin, "update-ref", "-d", "refs/heads/gateway-state")
    assert world.run().opened == 0
    assert len(world.prs()) == 1
    assert f"gateway/{ID}" not in world.branches()


def test_a_fork_pull_request_with_the_same_branch_name_does_not_suppress_a_submission(world):
    world.set_prs([{"number": 1, "html_url": "https://github.com/nsdub/ourowncause/pull/1", "state": "open",
                    "created_at": "2026-11-23T11:00:00Z", "comments": [],
                    "head": {"ref": f"gateway/{ID}", "sha": "0" * 40, "repo": {"full_name": "mallory/ourowncause"}}}])
    assert world.run().opened == 1
    assert len(world.prs()) == 2


def test_the_same_id_listed_twice_in_one_run_is_handled_once(world):
    world.pages = [{"pending": [item(), item()], "next_after": None}]
    assert world.run().opened == 1
    assert len(world.prs()) == 1


def test_every_page_of_the_pending_list_is_read(world):
    other = "fedcba9876543210"
    world.pages = [
        {"pending": [item()], "next_after": 20},
        {"pending": [item(id=other, path="posts/2026/11/second-fedcba.md")], "next_after": None},
    ]
    assert world.run().opened == 2
    assert world.fetched == ["https://ourowncause.com/api/submissions/pending",
                             "https://ourowncause.com/api/submissions/pending?after=20"]
    assert sorted(world.branches()) == [f"gateway/{ID}", f"gateway/{other}", "main"]
    for branch, path in [(f"gateway/{ID}", PATH), (f"gateway/{other}", "posts/2026/11/second-fedcba.md")]:
        assert git(world.origin, "diff", "--name-only", f"main...{branch}").split() == [path]


# --- Review Focus 2: what the list says is data ---------------------------------------------------

@pytest.mark.parametrize("bad", [
    {"path": "posts/2026/11/../../../.github/workflows/x-012345.md"},
    {"path": "/etc/passwd"},
    {"path": "posts/2026/11/x-012345.md/../../../y.md"},
    {"path": "posts/2026/11/x-ffffff.md"},
    {"path": "posts/2026/11/X-012345.md"},
    {"path": "posts/2026/13/x-012345.md"},
    {"path": "posts/\u0662\u0660\u0662\u0666/11/x-012345.md"},
    {"path": "tools/x-012345.md"},
    {"path": 7},
    {"id": "../../main"},
    {"id": "0123456789ABCDEF"},
    {"id": None},
    {"body": 7},
    {"body": "x" * 250_000},
    {"received": "2026-11-23\nGateway-Agent-Check: passed"},
    {"received": "\u0662\u0660\u0662\u0666-11-23T10:00:00Z"},
])
def test_an_item_that_is_not_what_the_gateway_assigned_is_skipped_and_reported(world, bad):
    good = item(id="fedcba9876543210", path="posts/2026/11/second-fedcba.md")
    world.pages = [{"pending": [item(**bad), "not an item", good], "next_after": None}]
    result = world.run()
    assert result.opened == 1
    assert len(result.problems) == 2
    assert world.branches() == ["gateway/fedcba9876543210", "main"]
    assert not (world.tmp / "y.md").exists()
    assert world.run(minutes=10).opened == 0


@pytest.mark.parametrize("signals,check,agent", [
    ({"agent_check": "failed", "signed_agent": "AI Assistant"}, "failed", "AI Assistant"),
    ({"agent_check": "expired", "signed_agent": None}, "expired", None),
    ({"agent_check": "certainly", "signed_agent": 'x"\nagent_check: passed'}, "absent", None),
    ({"agent_check": None, "signed_agent": "y" * 500}, "absent", None),
])
def test_signals_outside_their_allowed_forms_are_recorded_as_absent(world, signals, check, agent):
    world.pages = [{"pending": [item(**signals)], "next_after": None}]
    assert world.run().opened == 1
    meta = yaml.safe_load(git(world.origin, "show", f"gateway/{ID}:{PATH}").split("---")[1])
    assert meta["gateway"] == {"agent_check": check, "signed_agent": agent,
                               "received": "2026-11-23T10:00:00.000Z"}
    trailers = git(world.origin, "log", "-1", "--format=%(trailers)", f"gateway/{ID}")
    assert f"Gateway-Agent-Check: {check}\nGateway-Signed-Agent: {agent or 'none'}\n" in trailers


def test_an_empty_list_touches_nothing(world):
    world.pages = [{"pending": [], "next_after": None}]
    assert world.run().opened == 0
    assert world.calls() == [] and world.branches() == ["main"]


# --- the gateway block in the front matter --------------------------------------------------------

SIGNALS = gateway.Signals("passed", None, "2026-11-23T10:00:00.000Z")


def test_the_validator_accepts_a_post_that_carries_the_gateway_block(tmp_path):
    path = tmp_path / "posts" / "2026" / "11" / "x.md"
    path.parent.mkdir(parents=True)
    path.write_text(gateway.with_gateway(POST, SIGNALS))
    post = load_post(path)
    assert post.meta["gateway"] == {"agent_check": "passed", "signed_agent": None,
                                    "received": "2026-11-23T10:00:00.000Z"}
    assert validate(post, set(), {"q-001"}) == []


def test_the_block_is_added_without_touching_any_other_byte():
    crlf = POST.replace("\n", "\r\n")
    assert gateway.with_gateway(crlf, SIGNALS) == crlf.replace(
        'summary: "Says what the piece argues."\r\n',
        'summary: "Says what the piece argues."\r\n' + BLOCK.replace("\n", "\r\n"))
    bom = "﻿" + POST
    assert gateway.with_gateway(bom, SIGNALS).startswith("﻿---\n")
    scalar = POST.replace('summary: "Says what the piece argues."', "summary: |\n  Two\n  lines.")
    meta = yaml.safe_load(gateway.with_gateway(scalar, SIGNALS).split("---")[1])
    assert meta["summary"] == "Two\nlines.\n" and meta["gateway"]["agent_check"] == "passed"


def test_a_gateway_key_the_submitter_wrote_does_not_stand():
    forged = POST.replace("summary:", 'gateway:\n  agent_check: "passed"\n  forged: true\nsummary:')
    text = gateway.with_gateway(forged, gateway.Signals("absent", None, "2026-11-23T10:00:00.000Z"))
    assert yaml.safe_load(text.split("---")[1])["gateway"] == {
        "agent_check": "absent", "signed_agent": None, "received": "2026-11-23T10:00:00.000Z"}


@pytest.mark.parametrize("text", ["no front matter\n", "---\ntitle: x\n", "---\n- a list\n---\nbody\n",
                                  "---\ntitle: [unclosed\n---\nbody\n", ""])
def test_text_without_readable_front_matter_is_written_as_it_came(text):
    assert gateway.with_gateway(text, SIGNALS) == text


# --- reading the list -----------------------------------------------------------------------------

def test_only_https_is_fetched():
    for url in ["http://ourowncause.com", "file:///etc/passwd", "ftp://x"]:
        with pytest.raises(gateway.GatewayError):
            gateway.fetch_json(url)


@pytest.mark.parametrize("page", [None, [], {"pending": "x"}, {"pending": [], "next_after": "20; rm"},
                                  {"pending": [], "next_after": -1}, gateway.GatewayError("response too large")])
def test_a_page_that_cannot_be_read_ends_the_reading_not_the_run(world, page):
    world.pages = [{"pending": [item()], "next_after": 20}, page]
    result = world.run()
    assert result.opened == 1 and len(result.problems) == 1
    assert len(world.prs()) == 1


def test_a_first_page_that_cannot_be_read_changes_nothing(world):
    world.pages = [gateway.GatewayError("response is over 20000000 bytes")]
    result = world.run()
    assert result.opened == 0 and len(result.problems) == 1
    assert world.calls() == [] and world.branches() == ["main"]


def test_a_list_that_never_ends_is_cut_off_and_what_was_read_is_handled(world):
    world.pages = [{"pending": [item()], "next_after": 1}, {"pending": [], "next_after": 1}]
    result = world.run()
    assert len(world.fetched) == gateway.MAX_PAGES
    assert result.opened == 1 and len(result.problems) == 1


# --- cost and availability --------------------------------------------------------------------------

def test_at_most_ten_pull_requests_are_opened_in_one_run(world):
    world.pages = [{"pending": [entry(n) for n in range(1, 21)], "next_after": 20},
                   {"pending": [entry(n) for n in range(21, 26)], "next_after": None}]
    opened = [world.run(minutes=10).opened for _ in range(4)]
    assert opened == [10, 10, 5, 0]
    assert len(world.prs()) == 25 and len({p["head"]["ref"] for p in world.prs()}) == 25
    assert all(len(p["comments"]) == 1 for p in world.prs())


def test_more_than_a_thousand_pending_entries_do_not_stop_the_run(world):
    world.pages = [{"pending": [entry(page * 20 + n) for n in range(1, 21)], "next_after": page + 1}
                   for page in range(60)]
    result = world.run()
    assert (result.opened, result.problems) == (10, [])
    assert len(world.fetched) == 1  # it stopped reading when it had opened ten


def test_a_thousand_finished_entries_still_in_the_list_cost_no_github_calls(world):
    world.set_ledger({f"{n:016x}": {"state": "done", "attempts": 0, "at": "2026-11-23T11:00:00Z",
                                    "pr": f"https://github.com/nsdub/ourowncause/pull/{n}"}
                      for n in range(1, 1041)})
    world.pages = [{"pending": [entry(page * 20 + n) for n in range(1, 21)], "next_after": page + 1}
                   for page in range(52)] + [{"pending": [entry(5000)], "next_after": None}]
    result = world.run()
    assert result.opened == 1 and result.problems == []
    assert len(world.calls("api")) == 2  # the one new entry, and the look for closed pull requests
    assert len(world.fetched) == 53


def test_a_submission_that_fails_three_times_an_hour_apart_is_given_up_with_the_reason(world):
    (world.state / "fail-create-always").write_text(f"gateway/{ID}")
    other = entry(7)
    world.pages = [{"pending": [item(), other], "next_after": None}]
    first = world.run()
    assert first.opened == 1 and len(first.problems) == 1  # the other entry is not held up
    assert world.ledger()[ID]["state"] == "retry"
    assert world.run(minutes=10).problems == []  # too soon: not tried, not counted
    assert world.ledger()[ID]["attempts"] == 1
    world.run(minutes=60)
    world.run(minutes=61)
    assert world.ledger()[ID] == {
        "state": "failed", "attempts": 3, "at": "2026-11-23T14:11:00Z",
        "reason": "gh pr create failed (1): gh: could not create the pull request"}
    world.forget_calls()
    last = world.run(minutes=600)
    assert (last.opened, last.problems) == (0, [])
    assert world.calls("pr") == [] and world.prs()[0]["head"]["ref"] == f"gateway/{other['id']}"


def test_an_entry_the_gateway_cannot_accept_is_given_up_after_three_attempts(world):
    world.pages = [{"pending": [item(body=7)], "next_after": None}]
    for _ in range(3):
        assert len(world.run(minutes=61).problems) == 1
    assert world.ledger()[ID]["state"] == "failed" and "body is not text" in world.ledger()[ID]["reason"]
    assert world.run(minutes=61).problems == []


@pytest.mark.parametrize("escape,cleaned", [("\\x00", "Onemany"), ("\\u0000", "Onemany"), ("\\u202e", "Onemany"),
                                            ("\\x1b[31m", "One[31mmany"), ("\\u0085", "Onemany")])
def test_control_characters_in_a_title_do_not_break_the_pull_request(world, escape, cleaned):
    world.pages = [{"pending": [item(body=POST.replace("On being one or many", f"One{escape}many"))],
                    "next_after": None}]
    result = world.run()
    assert (result.opened, result.problems) == (1, [])
    assert world.prs()[0]["title"] == f"Submission: {cleaned}"


def test_the_ledger_forgets_entries_after_three_weeks(world):
    world.set_ledger({"a" * 16: {"state": "done", "attempts": 0, "at": "2026-11-01T00:00:00Z", "pr": "x"},
                      "b" * 16: {"state": "failed", "attempts": 3, "at": "2026-11-20T00:00:00Z", "reason": "r"},
                      "not-an-id": {"state": "done"}, "c" * 16: "nonsense"})
    world.run()
    assert sorted(world.ledger()) == [ID, "b" * 16]


def test_an_unreadable_ledger_is_started_again_and_no_pull_request_is_doubled(world):
    world.run()
    blob = git(world.origin, "hash-object", "-w", "--stdin", input="{not json").strip()
    tree = git(world.origin, "mktree", input=f"100644 blob {blob}\tstate.json\n").strip()
    commit = git(world.origin, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "x").strip()
    git(world.origin, "update-ref", "refs/heads/gateway-state", commit)
    assert world.run().opened == 0
    assert len(world.prs()) == 1 and world.ledger()[ID]["state"] == "done"


# --- one entry never stops the others (review round 2) ---------------------------------------------

@pytest.mark.parametrize("line,error", [
    ('x: !!timestamp "x"', "AttributeError"),   # PyYAML raises these two itself
    ("x: !!bool maybe", "KeyError"),
])
def test_front_matter_that_crashes_the_yaml_reader_gets_a_report_and_stops_nothing(world, line, error):
    body = POST.replace("summary:", f"{line}\nsummary:")
    world.pages = [{"pending": [entry(1), entry(2, body=body), entry(3)], "next_after": None}]
    result = world.run()
    assert (result.opened, result.problems) == (3, [])
    second = world.prs()[1]
    assert second["head"]["ref"] == f"gateway/{2:016x}"
    assert f"front matter could not be parsed: {error}" in second["comments"][0]["body"]
    assert second["comments"][0]["body"].rstrip().endswith("Result: failed")
    assert git(world.origin, "show", f"gateway/{2:016x}:posts/2026/11/post-000000.md") == body  # written as it came
    assert all(e["state"] == "done" for e in world.ledger().values())


def test_a_ledger_date_python_cannot_shift_to_utc_does_not_stop_the_run(world):
    world.set_ledger({f"{2:016x}": {"state": "retry", "attempts": 1, "reason": "r",
                                    "at": "0001-01-01T00:00:00+23:59"}})
    world.pages = [{"pending": [entry(1), entry(2), entry(3)], "next_after": None}]
    result = world.run()
    assert (result.opened, result.problems) == (3, [])


def test_an_error_nobody_foresaw_counts_as_an_attempt_and_names_its_type(world, monkeypatch):
    real = gateway.with_gateway

    def explode(text, signals):
        if "second" in text:
            raise ZeroDivisionError("nobody foresaw this")
        return real(text, signals)
    monkeypatch.setattr(gateway, "with_gateway", explode)
    world.pages = [{"pending": [entry(1), entry(2, body=POST + "second\n"), entry(3)], "next_after": None}]
    result = world.run()
    assert result.opened == 2
    assert "ZeroDivisionError: nobody foresaw this" in result.problems[0]
    assert world.ledger()[f"{2:016x}"] == {"state": "retry", "attempts": 1, "at": "2026-11-23T12:00:00Z",
                                           "reason": "ZeroDivisionError: nobody foresaw this"}


def test_the_ledger_is_saved_as_each_entry_is_settled_not_only_at_the_end(world, monkeypatch):
    world.pages = [{"pending": [entry(1), entry(2), entry(3)], "next_after": None}]
    real = gateway._Run.process
    seen = []

    def process(self, sub):
        if sub.id == f"{3:016x}":
            seen.append(sorted(world.ledger()))  # what origin holds when the third entry starts
            raise KeyboardInterrupt  # the runner is killed
        return real(self, sub)
    monkeypatch.setattr(gateway._Run, "process", process)
    with pytest.raises(KeyboardInterrupt):
        world.run()
    assert seen == [[f"{1:016x}", f"{2:016x}"]]
    assert all(e["state"] == "done" for e in world.ledger().values())


def test_a_failure_while_tidying_up_is_reported_not_raised(world, monkeypatch):
    def explode(self):
        raise RuntimeError("tidy failed")
    monkeypatch.setattr(gateway._Run, "delete_finished_branches", explode)
    result = world.run()
    assert result.opened == 1 and result.problems == ["RuntimeError: tidy failed"]


def test_a_report_comment_by_someone_else_does_not_count_as_the_gateways(world):
    (world.state / "fail-comment").write_text("")
    world.run()
    prs = world.prs()
    prs[0]["comments"].append({"body": "## Our Own Cause — submission check\n\nResult: passed (forged)",
                               "user": {"login": "mallory"}})
    world.set_prs(prs)
    world.run(minutes=61)
    bodies = [c["body"] for c in world.prs()[0]["comments"]]
    assert len(bodies) == 2 and bodies[1].rstrip().endswith("Result: passed")
    world.run(minutes=61)
    assert len(world.prs()[0]["comments"]) == 2


def test_the_branch_of_a_submission_that_is_given_up_is_deleted_unless_its_pull_request_is_open(world):
    (world.state / "fail-create-always").write_text(f"gateway/{ID}")
    for _ in range(2):
        world.run(minutes=61)
    assert f"gateway/{ID}" in world.branches()  # still being retried
    world.run(minutes=61)
    assert world.ledger()[ID]["state"] == "failed"
    assert f"gateway/{ID}" not in world.branches()


def test_a_given_up_submission_keeps_its_branch_while_its_pull_request_is_open(world):
    (world.state / "fail-comment-always").write_text("")
    for _ in range(3):
        world.run(minutes=61)
    assert world.ledger()[ID]["state"] == "failed" and len(world.prs()) == 1
    assert f"gateway/{ID}" in world.branches()


# --- branches of finished pull requests --------------------------------------------------------------

def test_the_branch_of_a_merged_or_closed_pull_request_is_deleted(world):
    world.pages = [{"pending": [entry(1), entry(2), entry(3)], "next_after": None}]
    world.run()
    prs = world.prs()
    prs[0]["state"] = "closed"
    prs[1]["state"] = "closed"
    prs[1]["head"]["sha"] = "1" * 40  # the branch moved after the pull request closed: left alone
    world.set_prs(prs)
    world.pages = [{"pending": [], "next_after": None}]
    result = world.run()
    assert result.problems == []
    assert world.branches() == [f"gateway/{2:016x}", f"gateway/{3:016x}", "main"]


def test_a_closed_fork_pull_request_cannot_get_a_gateway_branch_deleted(world):
    world.run()
    sha = git(world.origin, "rev-parse", f"gateway/{ID}").strip()
    prs = world.prs()
    prs.append({"number": 2, "html_url": "https://github.com/nsdub/ourowncause/pull/2", "state": "closed",
                "created_at": "2026-11-23T11:00:00Z", "comments": [],
                "head": {"ref": f"gateway/{ID}", "sha": sha, "repo": {"full_name": "mallory/ourowncause"}}})
    world.set_prs(prs)
    world.run()
    assert f"gateway/{ID}" in world.branches()


# --- asking the maintainers to review -----------------------------------------------------------------

def ago(hours):
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def open_pr(created_hours_ago, repo="nsdub/ourowncause", ref=f"gateway/{ID}"):
    return {"number": 1, "html_url": "https://github.com/nsdub/ourowncause/pull/1", "state": "open",
            "created_at": ago(created_hours_ago), "comments": [],
            "head": {"ref": ref, "sha": "0" * 40, "repo": {"full_name": repo}}}


REVIEW, QUESTIONS, ISSUE = "maintainer-review.yml", "maintainer-questions.yml", "maintainer-issue.yml"


@pytest.mark.parametrize("prs,runs,dispatched", [
    ([open_pr(0.1)], {}, True),
    ([open_pr(0.1)], {REVIEW: [{"status": "completed", "createdAt": ago(4)}]}, True),
    ([open_pr(0.1)], {REVIEW: [{"status": "completed", "createdAt": ago(2.9)}]}, False),   # inside three hours
    ([open_pr(5)], {REVIEW: [{"status": "completed", "createdAt": ago(4)}]}, False),       # already seen by a run
    ([open_pr(0.1)], {REVIEW: [{"status": "in_progress", "createdAt": ago(4)}]}, False),
    ([open_pr(0.1)], {REVIEW: [{"status": "queued", "createdAt": ago(4)}]}, False),
    ([open_pr(0.1)], {QUESTIONS: [{"status": "queued", "createdAt": ago(0.1)}]}, False),
    ([open_pr(0.1)], {ISSUE: [{"status": "in_progress", "createdAt": ago(0.1)}]}, False),
    ([open_pr(0.1)], {ISSUE: [{"status": "completed", "createdAt": ago(0.1)}]}, True),
    ([], {}, False),
    ([open_pr(0.1, repo="mallory/ourowncause")], {}, False),
    ([open_pr(0.1, ref="editor-1/rebuttal-x")], {}, False),
])
def test_the_maintainers_are_asked_only_when_needed_idle_and_not_within_three_hours(world, prs, runs, dispatched):
    world.set_prs(prs)
    world.set_runs(runs)
    note = gateway.dispatch(world.repo)
    started = world.calls("workflow", "run")
    assert started == ([["workflow", "run", REVIEW, "--ref", "main"]] if dispatched else []), note


def test_a_dispatch_is_remembered_by_github_so_the_next_run_does_not_repeat_it(world):
    world.set_prs([open_pr(0.1)])
    gateway.dispatch(world.repo)
    gateway.dispatch(world.repo)
    gateway.dispatch(world.repo)
    assert len(world.calls("workflow", "run")) == 1


def test_with_no_open_gateway_pull_request_the_runs_are_not_even_listed(world):
    gateway.dispatch(world.repo)
    assert world.calls("run", "list") == []


# --- the command and the workflow -----------------------------------------------------------------

def test_the_command_tells_the_workflow_of_each_pull_request_as_it_opens(world, monkeypatch, tmp_path, capsys):
    out = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    world.pages = [{"pending": [entry(1), entry(2)], "next_after": None}]
    monkeypatch.setattr(gateway, "fetch_json", world.fetch)
    monkeypatch.chdir(world.repo)
    assert gateway.main(["run", "--base-url", "https://ourowncause.com"]) == 0
    assert out.read_text() == "opened=0\nopened=1\nopened=2\n"
    assert "opened posts/2026/11/post-000000.md" in capsys.readouterr().out


def test_the_command_fails_when_a_submission_could_not_be_handled(world, monkeypatch, tmp_path):
    out = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    world.pages = [{"pending": [item(id="nope"), item()], "next_after": None}]
    monkeypatch.setattr(gateway, "fetch_json", world.fetch)
    monkeypatch.chdir(world.repo)
    assert gateway.main(["run", "--base-url", "https://ourowncause.com"]) == 1
    assert out.read_text() == "opened=0\nopened=1\n"


def test_the_dispatch_command_never_fails_the_workflow(world, monkeypatch, capsys):
    monkeypatch.chdir(world.repo)
    world.set_prs([open_pr(0.1)])
    assert gateway.main(["dispatch"]) == 0
    assert len(world.calls("workflow", "run")) == 1
    monkeypatch.setenv("PATH", "/nonexistent")
    assert gateway.main(["dispatch"]) == 0


def workflow():
    return yaml.safe_load((ROOT / ".github" / "workflows" / "gateway.yml").read_text())


def test_the_workflow_runs_every_ten_minutes_and_never_twice_at_once():
    wf = workflow()
    on = wf.get("on", wf.get(True))
    assert on["schedule"] == [{"cron": "*/10 * * * *"}]
    assert "workflow_dispatch" in on
    assert wf["concurrency"] == {"group": "gateway", "cancel-in-progress": False}
    assert wf["permissions"] == {"contents": "write", "pull-requests": "write", "actions": "write"}


def test_the_workflow_runs_the_gateway_from_main_and_then_asks_for_a_review():
    steps = workflow()["jobs"]["gateway"]["steps"]
    checkout = next(s for s in steps if "actions/checkout" in s.get("uses", ""))
    assert checkout["with"] == {"ref": "main", "fetch-depth": 0}
    run = next(s for s in steps if s.get("id") == "run")
    assert run["run"].strip() == 'python -P -m tools.gateway run --base-url "$BASE_URL"'
    assert run["env"]["BASE_URL"] == "https://ourowncause.com"
    assert run["env"]["PYTHONPATH"] == "${{ github.workspace }}"
    review = steps[steps.index(run) + 1]
    assert review["run"].strip() == "python -P -m tools.gateway dispatch"
    assert review["if"] == "always()"
    assert review["env"]["PYTHONPATH"] == "${{ github.workspace }}"
