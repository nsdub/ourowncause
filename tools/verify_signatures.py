"""Classify commits by who signed them, so unsigned or owner changes to main are visible.

Statuses (everything except `maintainer` and `contributed` is flagged in public):
  maintainer        signed by a key listed in allowed_signers (not owner, not verifier)
  owner-veto        signed by the owner key, subject starts with `Veto:`
  owner-unlabeled   signed by the owner key, without a `Veto:` subject
  verifier          signed by the verifier key on main's first-parent chain
  unsigned          no signature (including merge commits whose parents are signed)
  unknown-key       a signature exists but does not verify against allowed_signers
  contributed       brought into main by a maintainer-signed merge commit (side parents);
                    principal is the merging maintainer
  rewrite           history was rewritten or rewound, or the anchor is not on main
  error             the commit could not be judged (reason in the principal column)

Trust root: each first-parent commit is judged against maintainers/allowed_signers as it
exists at that commit's FIRST PARENT, never the file the commit itself ships. The anchor
commit (maintainers/ANCHOR) is judged against its own file. The anchor is the most
recent valid one in the history of main's previous tip; only when that history never held one
(the launch) is it read from the tip being judged.
"""
import argparse
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

OWNER = "owner"
VERIFIER = "verifier"
NULL_SHA = "0" * 40
SIGNERS_PATH = "maintainers/allowed_signers"
ANCHOR_PATH = "maintainers/ANCHOR"
UNFLAGGED = ("maintainer", "contributed")
_GOOD = re.compile(r'^Good "git" signature for (.+) with \S+ key \S+\s*$', re.MULTILINE)
_PRINCIPAL = re.compile(r"^[a-z0-9-]+$")
_SHA = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class CommitClass:
    sha: str  # a commit sha; for `rewrite`, the range `<before>..<after>`
    status: str
    principal: str | None


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True,
                          errors="replace", check=check)


def _one_line(text: str) -> str:
    return " ".join(str(text).split()) or "unknown"


def _exists(repo: Path, sha: str) -> bool:
    return _git(repo, "cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


def _is_ancestor(repo: Path, anc: str, desc: str) -> bool:
    return _git(repo, "merge-base", "--is-ancestor", anc, desc, check=False).returncode == 0


def _parents(sha: str, repo: Path) -> list[str]:
    return _git(repo, "rev-list", "--parents", "-n1", sha).stdout.split()[1:]


def _show(repo: Path, rev: str, path: str) -> str | None:
    proc = _git(repo, "show", f"{rev}:{path}", check=False)
    return proc.stdout if proc.returncode == 0 else None


def validate_allowed_signers(text: str) -> str | None:
    """Return a reason if the file is unsafe to trust, else None."""
    owners: dict[str, str] = {}
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        tokens = line.split()
        if len(tokens) < 4:
            return f"invalid allowed_signers line {n}: expected principal, options, keytype, key"
        principal, options, _keytype, key = tokens[:4]
        if not _PRINCIPAL.match(principal):
            return f"invalid allowed_signers line {n}: principal must match [a-z0-9-]+"
        if options != 'namespaces="git"':
            return f'invalid allowed_signers line {n}: options must be exactly namespaces="git"'
        if key in owners and owners[key] != principal:
            return f"invalid allowed_signers line {n}: key listed under more than one principal"
        owners[key] = principal
    return None


def _has_signature(sha: str, repo: Path) -> bool:
    headers = _git(repo, "cat-file", "commit", sha).stdout.split("\n\n", 1)[0]
    return any(line.startswith("gpgsig") for line in headers.splitlines())


def _classify(sha: str, repo: Path, signers_text: str) -> CommitClass:
    problem = validate_allowed_signers(signers_text)
    if problem:
        return CommitClass(sha, "error", problem)
    if not _has_signature(sha, repo):
        return CommitClass(sha, "unsigned", None)
    with tempfile.TemporaryDirectory() as tmp:
        signers = Path(tmp) / "allowed_signers"
        signers.write_text(signers_text)
        proc = _git(repo, "-c", "gpg.format=ssh", "-c", f"gpg.ssh.allowedSignersFile={signers}",
                    "verify-commit", "--raw", sha, check=False)
    match = _GOOD.search(proc.stdout + proc.stderr) if proc.returncode == 0 else None
    if not match:
        return CommitClass(sha, "unknown-key", None)
    principal = match.group(1)
    if principal == VERIFIER:
        return CommitClass(sha, "verifier", principal)
    if principal != OWNER:
        return CommitClass(sha, "maintainer", principal)
    message = _git(repo, "log", "-1", "--format=%B", sha).stdout
    return CommitClass(sha, "owner-veto" if message.startswith("Veto:") else "owner-unlabeled",
                       principal)


def _safe_classify(sha: str, repo: Path, signers_text: str) -> CommitClass:
    try:
        return _classify(sha, repo, signers_text)
    except Exception as e:  # never fail open: an unjudgeable commit is flagged
        return CommitClass(sha, "error", _one_line(f"{type(e).__name__}: {e}"))


def classify_commit(sha: str, repo: Path, allowed_signers: Path) -> CommitClass:
    """Judge one commit against an explicit allowed_signers file."""
    p = Path(allowed_signers)
    text = p.read_text(errors="replace") if p.exists() else ""
    return _safe_classify(sha, Path(repo), text)


def _trust_for(sha: str, repo: Path, override: str | None, own: bool) -> str:
    if override is not None:
        return override
    parents = _parents(sha, repo)
    rev = sha if (own or not parents) else parents[0]
    return _show(repo, rev, SIGNERS_PATH) or ""


def _classify_with_contributions(sha: str, repo: Path, override: str | None,
                                 own: bool = False) -> list[CommitClass]:
    try:
        text = _trust_for(sha, repo, override, own)
        parents = _parents(sha, repo)
    except Exception as e:
        return [CommitClass(sha, "error", _one_line(f"{type(e).__name__}: {e}"))]
    c = _safe_classify(sha, repo, text)
    out = [c]
    if len(parents) > 1:
        # Commits this merge brings in through its non-first parents, oldest first.
        shas = _git(repo, "rev-list", "--reverse", "--topo-order", *parents[1:],
                    "--not", parents[0]).stdout.split()
        for s in shas:
            if c.status == "maintainer":
                out.append(CommitClass(s, "contributed", c.principal))
            else:
                out.append(_safe_classify(s, repo, text))
    return out


def _override_text(allowed_signers: Path | None) -> str | None:
    if allowed_signers is None:
        return None
    p = Path(allowed_signers)
    return p.read_text(errors="replace") if p.exists() else ""


def _rewrite_lines(before: str | None, head: str, repo: Path, forced: bool) -> list[CommitClass]:
    """A rewrite line when the push replaced history rather than extending it."""
    if before is None or before == NULL_SHA:
        return [CommitClass(f"none..{head}", "rewrite", None)] if forced else []
    if forced or not _exists(repo, before) or not _is_ancestor(repo, before, head):
        return [CommitClass(f"{before}..{head}", "rewrite", None)]
    return []


def classify_range(base: str, head: str, repo: Path, allowed_signers: Path | None = None,
                   forced: bool = False) -> list[CommitClass]:
    """Judge main's first-parent chain in base..head, oldest first.

    Each first-parent commit gets a normal status, judged against allowed_signers at its first
    parent (or against `allowed_signers` when a path is given explicitly). For a maintainer-signed
    merge, the commits it brings in through its other parents follow it as `contributed`; for any
    other merge they are classified normally. A `rewrite` entry comes first when base is missing
    from the clone, is not an ancestor of head (rewind or divergence), or the push was forced.
    An all-zeros base (first push) classifies only head.
    """
    repo = Path(repo)
    override = _override_text(allowed_signers)
    result = _rewrite_lines(base, head, repo, forced)
    if base == NULL_SHA or not _exists(repo, base):
        shas = [_git(repo, "rev-parse", head).stdout.strip()]
    else:
        shas = _git(repo, "rev-list", "--first-parent", "--reverse", f"{base}..{head}").stdout.split()
    for s in shas:
        result.extend(_classify_with_contributions(s, repo, override))
    return result


def _read_anchor(repo: Path, rev: str) -> str | None:
    text = _show(repo, rev, ANCHOR_PATH)
    if text is None:
        return None
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line.lower() if _SHA.match(line.lower()) else None
    return None


def _last_anchor(repo: Path, rev: str) -> str | None:
    """The most recent valid anchor on rev's first-parent chain, or None if there never was one.

    Only commits that changed the ANCHOR file relative to their first parent are read, newest
    first; the file's state at any other commit equals the state at the latest of those.
    """
    changed = _git(repo, "rev-list", "--first-parent", rev, "--", ANCHOR_PATH).stdout.split()
    for sha in changed:
        anchor = _read_anchor(repo, sha)
        if anchor is not None:
            return anchor
    return None


def classify_since_anchor(head: str, repo: Path, allowed_signers: Path | None = None,
                          before: str | None = None, forced: bool = False) -> list[CommitClass]:
    """Classify main's whole first-parent history from the anchor (inclusive) to head.

    The anchor is the most recent valid one on the first-parent chain of `before` (the last
    state not yet under judgment), so a push cannot move the anchor to hide its own commits,
    and blanking or deleting the file in an earlier push does not free the next push to choose
    it. Only when no commit reachable that way ever held a valid anchor (the launch), or there
    is no `before`, is it read from head. An anchor missing from both means the root of history. The anchor commit is judged against
    its own allowed_signers; everything after it against its first parent's. An anchor that
    is off main's first-parent chain yields a `rewrite` entry and the whole history is
    classified.
    """
    repo = Path(repo)
    override = _override_text(allowed_signers)
    head = _git(repo, "rev-parse", head).stdout.strip()
    result = _rewrite_lines(before, head, repo, forced)
    chain = _git(repo, "rev-list", "--first-parent", "--reverse", head).stdout.split()
    anchor = None
    if before and before != NULL_SHA and _exists(repo, before):
        anchor = _last_anchor(repo, before)
    if anchor is None:
        anchor = _read_anchor(repo, head)
    start = 0
    if anchor is not None:
        if anchor in chain:
            start = chain.index(anchor)
        else:
            result.append(CommitClass(f"{anchor}..{head}", "rewrite", None))
    for s in chain[start:]:
        result.extend(_classify_with_contributions(s, repo, override,
                                                   own=(anchor is not None and s == anchor)))
    return result


def trusted_log_rev(results: list[CommitClass], repo: Path, head: str) -> str | None:
    """The most recent first-parent commit of head judged `maintainer` in results, or None.

    moderation/log.md as it exists there is the only copy a dedup may trust: a later commit
    (for instance an owner's) cannot vouch for itself by editing the log.
    """
    chain = set(_git(Path(repo), "rev-list", "--first-parent", head).stdout.split())
    for c in reversed(results):
        if c.status == "maintainer" and c.sha in chain:
            return c.sha
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Classify commits by signature.")
    ap.add_argument("refs", nargs="+", metavar="ref",
                    help="<base> <head>, or just <head> with --since-anchor")
    ap.add_argument("--allowed-signers", type=Path, default=None,
                    help="judge every commit against this file instead of the one in git history")
    ap.add_argument("--since-anchor", action="store_true",
                    help="classify the whole first-parent history from maintainers/ANCHOR")
    ap.add_argument("--before", help="previous tip of main; flags a rewrite if not an ancestor")
    ap.add_argument("--trusted-log-rev-file", type=Path,
                    help="write the sha whose moderation/log.md may be trusted (empty if none)")
    ap.add_argument("--forced", action="store_true", help="the push was forced")
    args = ap.parse_args(argv)
    repo = Path.cwd()
    if args.since_anchor:
        classes = classify_since_anchor(args.refs[-1], repo, args.allowed_signers,
                                        args.before, args.forced)
    else:
        if len(args.refs) != 2:
            ap.error("expected <base> <head>")
        classes = classify_range(args.refs[0], args.refs[1], repo, args.allowed_signers, args.forced)
    if args.trusted_log_rev_file:
        head = _git(repo, "rev-parse", args.refs[-1]).stdout.strip()
        args.trusted_log_rev_file.write_text((trusted_log_rev(classes, repo, head) or "") + "\n")
    for c in classes:
        print(f"{c.sha} {c.status} {c.principal or 'none'}")
    return 0  # flagging, not failing, is the policy


if __name__ == "__main__":
    sys.exit(main())
