import os
import subprocess
import sys
from pathlib import Path

import pytest

from tools.verify_signatures import (CommitClass, classify_commit, classify_range,
                                     classify_since_anchor, trusted_log_rev)

ROOT = Path(__file__).resolve().parent.parent


def run(repo, *args, **kw):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
    return subprocess.run(args, cwd=repo, env=env, check=True, capture_output=True,
                          text=True, **kw).stdout.strip()


class Repo:
    def __init__(self, path: Path):
        self.path = path
        run(path, "git", "init", "-q", "-b", "main")
        run(path, "git", "config", "user.name", "Test")
        run(path, "git", "config", "user.email", "t@example.com")
        run(path, "git", "config", "gpg.format", "ssh")
        self.keys = {}
        self.n = 0

    def key(self, name) -> Path:
        if name not in self.keys:
            k = self.path.parent / f"key-{name}"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(k)],
                           check=True, capture_output=True)
            self.keys[name] = k
        return self.keys[name]

    def allowed(self, **principals) -> Path:
        """principals: principal -> key name (keys are created on demand)."""
        lines = []
        for principal, keyname in principals.items():
            keytype, b64 = self.key(keyname).with_suffix(".pub").read_text().split()[:2]
            lines.append(f'{principal} namespaces="git" {keytype} {b64}')
        f = self.path.parent / "allowed_signers"
        f.write_text("# header\n" + "\n".join(lines) + "\n")
        return f

    def commit(self, message, key=None) -> str:
        self.n += 1
        (self.path / f"f{self.n}.txt").write_text(str(self.n))
        run(self.path, "git", "add", "-A")
        if key:
            run(self.path, "git", "-c", f"user.signingkey={self.key(key)}.pub",
                "commit", "-q", "-S", "-m", message)
        else:
            run(self.path, "git", "commit", "-q", "--no-gpg-sign", "-m", message)
        return run(self.path, "git", "rev-parse", "HEAD")

    def merge(self, branch, key=None) -> str:
        if key:
            run(self.path, "git", "-c", f"user.signingkey={self.key(key)}.pub",
                "merge", "--no-ff", "-S", "-m", "Merge: branch", branch)
        else:
            run(self.path, "git", "merge", "--no-ff", "--no-gpg-sign", "-m", "Merge: branch", branch)
        return run(self.path, "git", "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    p = tmp_path / "repo"
    p.mkdir()
    return Repo(p)


def test_maintainer_signature(repo):
    allowed = repo.allowed(**{"maint-1": "m1", "owner": "own"})
    sha = repo.commit("Merge: a post, because it is good", key="m1")
    assert classify_commit(sha, repo.path, allowed) == CommitClass(sha, "maintainer", "maint-1")


def test_owner_veto(repo):
    allowed = repo.allowed(**{"owner": "own"})
    sha = repo.commit("Veto: removes a post, reason given", key="own")
    assert classify_commit(sha, repo.path, allowed) == CommitClass(sha, "owner-veto", "owner")


def test_owner_without_veto_prefix(repo):
    allowed = repo.allowed(**{"owner": "own"})
    sha = repo.commit("Fix typo", key="own")
    assert classify_commit(sha, repo.path, allowed) == CommitClass(sha, "owner-unlabeled", "owner")


def test_veto_prefix_matches_only_subject_start(repo):
    allowed = repo.allowed(**{"owner": "own"})
    sha = repo.commit("Edit: something\n\nVeto: hidden in the body", key="own")
    assert classify_commit(sha, repo.path, allowed).status == "owner-unlabeled"
    sha = repo.commit("veto: wrong case", key="own")
    assert classify_commit(sha, repo.path, allowed).status == "owner-unlabeled"


def test_maintainer_cannot_use_veto_label(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    sha = repo.commit("Veto: not the owner", key="m1")
    assert classify_commit(sha, repo.path, allowed).status == "maintainer"


def test_unsigned(repo):
    allowed = repo.allowed(**{"owner": "own"})
    sha = repo.commit("Merge: unsigned")
    assert classify_commit(sha, repo.path, allowed) == CommitClass(sha, "unsigned", None)


def test_unknown_key(repo):
    allowed = repo.allowed(**{"owner": "own"})
    repo.key("stranger")
    sha = repo.commit("Merge: signed by nobody we know", key="stranger")
    assert classify_commit(sha, repo.path, allowed) == CommitClass(sha, "unknown-key", None)


def test_empty_allowed_signers_makes_signed_commit_unknown(repo):
    allowed = repo.path.parent / "allowed_signers"
    allowed.write_text("# only a header\n")
    sha = repo.commit("Merge: x", key="m1")
    assert classify_commit(sha, repo.path, allowed).status == "unknown-key"


def test_tampered_signature_is_not_trusted(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    sha = repo.commit("Merge: original", key="m1")
    raw = run(repo.path, "git", "cat-file", "commit", sha)
    forged = raw.replace("Merge: original", "Merge: forged")
    new = subprocess.run(["git", "hash-object", "-t", "commit", "-w", "--stdin"],
                         cwd=repo.path, input=forged + "\n", text=True, check=True,
                         capture_output=True).stdout.strip()
    assert classify_commit(new, repo.path, allowed).status == "unknown-key"


def test_unsigned_merge_with_signed_parents(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    repo.commit("Merge: base", key="m1")
    run(repo.path, "git", "checkout", "-q", "-b", "side")
    repo.commit("Merge: side work", key="m1")
    run(repo.path, "git", "checkout", "-q", "main")
    repo.commit("Merge: main work", key="m1")
    merge = repo.merge("side")
    assert len(run(repo.path, "git", "rev-list", "--parents", "-n1", merge).split()) == 3
    assert classify_commit(merge, repo.path, allowed) == CommitClass(merge, "unsigned", None)


def test_range_oldest_first_includes_merges(repo):
    allowed = repo.allowed(**{"maint-1": "m1", "owner": "own"})
    base = repo.commit("Merge: base", key="m1")
    run(repo.path, "git", "checkout", "-q", "-b", "side")
    side = repo.commit("Merge: side", key="m1")
    run(repo.path, "git", "checkout", "-q", "main")
    main = repo.commit("Veto: something", key="own")
    merge = repo.merge("side")
    head = repo.commit("Fix", key="own")
    result = classify_range(base, head, repo.path, allowed)
    by_sha = {c.sha: c for c in result}
    assert set(by_sha) == {side, main, merge, head}
    assert by_sha[side].status == "maintainer"
    assert by_sha[main].status == "owner-veto"
    assert by_sha[merge].status == "unsigned"
    assert by_sha[head].status == "owner-unlabeled"
    order = [c.sha for c in result]
    assert order.index(main) < order.index(merge) < order.index(side)
    assert order[-1] == head


def test_range_empty_when_base_equals_head(repo):
    allowed = repo.allowed(**{"owner": "own"})
    sha = repo.commit("x", key="own")
    assert classify_range(sha, sha, repo.path, allowed) == []


def test_cli_prints_one_line_per_commit_and_exits_zero(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    base = repo.commit("Merge: base", key="m1")
    good = repo.commit("Merge: ok", key="m1")
    bad = repo.commit("Merge: bad")
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    proc = subprocess.run(
        [sys.executable, "-m", "tools.verify_signatures", base, bad,
         "--allowed-signers", str(allowed)],
        cwd=repo.path, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines() == [f"{good} maintainer maint-1", f"{bad} unsigned none"]


def test_cli_exits_zero_with_nothing_new(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    sha = repo.commit("x", key="m1")
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    proc = subprocess.run(
        [sys.executable, "-m", "tools.verify_signatures", sha, sha, "--allowed-signers", str(allowed)],
        cwd=repo.path, env=env, capture_output=True, text=True)
    assert proc.returncode == 0 and proc.stdout == ""


def test_shipped_allowed_signers_lists_the_roster_and_validates():
    from tools.verify_signatures import validate_allowed_signers
    text = (ROOT / "maintainers" / "allowed_signers").read_text()
    assert validate_allowed_signers(text) is None
    lines = [l.split() for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    assert [l[0] for l in lines] == ["editor-1", "steward-1", "verifier"]
    assert all(l[1] == 'namespaces="git"' and l[2] == "ssh-ed25519" for l in lines)
    roster = (ROOT / "maintainers" / "roster.md").read_text()
    assert "TBD" not in roster
    for principal, _opts, keytype, key in (l[:4] for l in lines):
        pub = subprocess.run(["ssh-keygen", "-lf", "-"], input=f"{keytype} {key}\n",
                             capture_output=True, text=True, check=True).stdout.split()[1]
        row = next(r for r in roster.splitlines() if r.startswith(f"| {principal} |"))
        assert pub in row


def test_zero_base_classifies_only_head_without_rewrite(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    repo.commit("Merge: first", key="m1")
    head = repo.commit("Merge: second")
    assert classify_range("0" * 40, head, repo.path, allowed) == [CommitClass(head, "unsigned", None)]


def test_missing_base_is_flagged_as_rewrite(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    repo.commit("Merge: first", key="m1")
    head = repo.commit("Merge: second", key="m1")
    missing = "1" * 40
    result = classify_range(missing, head, repo.path, allowed)
    assert result[0] == CommitClass(f"{missing}..{head}", "rewrite", None)
    assert result[1] == CommitClass(head, "maintainer", "maint-1")


def test_rewind_is_flagged_as_rewrite(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    first = repo.commit("Merge: first", key="m1")
    second = repo.commit("Merge: second", key="m1")
    assert classify_range(second, first, repo.path, allowed) == [
        CommitClass(f"{second}..{first}", "rewrite", None)]


def test_diverged_base_is_flagged_as_rewrite(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    base = repo.commit("Merge: base", key="m1")
    old_tip = repo.commit("Merge: old", key="m1")
    run(repo.path, "git", "reset", "-q", "--hard", base)
    new_tip = repo.commit("Merge: replacement", key="m1")
    result = classify_range(old_tip, new_tip, repo.path, allowed)
    assert result[0] == CommitClass(f"{old_tip}..{new_tip}", "rewrite", None)


def test_forced_flag_marks_rewrite_even_for_descendant(repo):
    allowed = repo.allowed(**{"maint-1": "m1"})
    base = repo.commit("Merge: base", key="m1")
    head = repo.commit("Merge: next", key="m1")
    result = classify_range(base, head, repo.path, allowed, forced=True)
    assert result[0].status == "rewrite" and result[1].status == "maintainer"


# --- trust root comes from the first parent (C1) -------------------------------------------

def signers_text(repo, **principals):
    lines = []
    for principal, keyname in principals.items():
        keytype, b64 = repo.key(keyname).with_suffix(".pub").read_text().split()[:2]
        lines.append(f'{principal} namespaces="git" {keytype} {b64}')
    return "# header\n" + "\n".join(lines) + "\n"


def commit_signers(repo, text, key=None, message="Roster: update signers"):
    d = repo.path / "maintainers"
    d.mkdir(exist_ok=True)
    (d / "allowed_signers").write_text(text)
    return repo.commit(message, key=key)


def test_commit_adding_its_own_key_is_unknown_key(repo):
    base = commit_signers(repo, signers_text(repo, **{"maint-1": "m1"}), key="m1")
    evil = commit_signers(repo, signers_text(repo, **{"maint-1": "m1", "owner": "owner"}),
                          key="owner", message="Roster: sneak in the owner key")
    assert classify_range(base, evil, repo.path)[0].status == "unknown-key"


def test_later_commits_use_the_updated_file(repo):
    base = commit_signers(repo, signers_text(repo, **{"maint-1": "m1"}), key="m1")
    added = commit_signers(repo, signers_text(repo, **{"maint-1": "m1", "maint-2": "m2"}), key="m1")
    after = repo.commit("Merge: by the new maintainer", key="m2")
    assert classify_range(base, after, repo.path) == [
        CommitClass(added, "maintainer", "maint-1"), CommitClass(after, "maintainer", "maint-2")]


def test_missing_signers_file_means_everyone_unknown(repo):
    base = repo.commit("base")
    sha = repo.commit("signed", key="m1")
    assert classify_range(base, sha, repo.path)[0].status == "unknown-key"


# --- anchor (C2) -----------------------------------------------------------------------------

def anchored_repo(repo):
    pre = repo.commit("pre-launch junk")
    anchor = commit_signers(repo, signers_text(repo, **{"maint-1": "m1", "owner": "owner"}), key="m1")
    (repo.path / "maintainers" / "ANCHOR").write_text(f"# anchor\n{anchor}\n")
    marker = repo.commit("Charter: set anchor", key="m1")
    return pre, anchor, marker


def test_since_anchor_starts_at_anchor_inclusive_and_skips_before(repo):
    pre, anchor, marker = anchored_repo(repo)
    result = classify_since_anchor(marker, repo.path)
    assert result == [CommitClass(anchor, "maintainer", "maint-1"),
                      CommitClass(marker, "maintainer", "maint-1")]


def test_since_anchor_catches_gap_missed_by_per_push_range(repo):
    pre, anchor, marker = anchored_repo(repo)
    gap = repo.commit("sneaky, run skipped")
    tip = repo.commit("Merge: ok", key="m1")
    result = classify_since_anchor(tip, repo.path, before=gap)
    assert CommitClass(gap, "unsigned", None) in result
    assert result[-1] == CommitClass(tip, "maintainer", "maint-1")


def test_placeholder_anchor_means_root_of_history(repo):
    root = repo.commit("root, unsigned")
    (repo.path / "maintainers").mkdir()
    (repo.path / "maintainers" / "ANCHOR").write_text("# placeholder, no sha yet\n")
    tip = repo.commit("tip", key="m1")
    shas = [c.sha for c in classify_since_anchor(tip, repo.path)]
    assert shas == [root, tip]


def test_anchor_not_on_main_is_flagged_as_rewrite(repo):
    pre, anchor, marker = anchored_repo(repo)
    ghost = "2" * 40
    (repo.path / "maintainers" / "ANCHOR").write_text(f"{ghost}\n")
    tip = repo.commit("Charter: move anchor", key="m1")
    result = classify_since_anchor(tip, repo.path)
    assert CommitClass(f"{ghost}..{tip}", "rewrite", None) in result


# --- verifier (C4) -------------------------------------------------------------------------

def test_verifier_commit_on_first_parent_chain_is_flagged(repo):
    allowed = repo.allowed(**{"maint-1": "m1", "verifier": "ver"})
    base = repo.commit("Merge: base", key="m1")
    sha = repo.commit("Edit: log", key="ver")
    assert classify_range(base, sha, repo.path, allowed) == [CommitClass(sha, "verifier", "verifier")]


def test_verifier_commit_inside_maintainer_merge_is_contributed(repo):
    allowed = repo.allowed(**{"maint-1": "m1", "verifier": "ver"})
    base = repo.commit("Merge: base", key="m1")
    run(repo.path, "git", "checkout", "-q", "-b", "log")
    logc = repo.commit("Edit: log", key="ver")
    run(repo.path, "git", "checkout", "-q", "main")
    merge = repo.merge("log", key="m1")
    assert classify_range(base, merge, repo.path, allowed) == [
        CommitClass(merge, "maintainer", "maint-1"), CommitClass(logc, "contributed", "maint-1")]


# --- errors fail closed (I1) -----------------------------------------------------------------

def test_non_utf8_commit_message_does_not_crash(repo):
    allowed = repo.allowed(**{"owner": "own"})
    base = repo.commit("base", key="own")
    (repo.path / "x.txt").write_text("x")
    run(repo.path, "git", "add", "-A")
    msg = repo.path.parent / "msg"
    msg.write_bytes(b"Veto: caf\xff bad bytes\n")
    run(repo.path, "git", "-c", f"user.signingkey={repo.key('own')}.pub", "commit", "-q", "-S",
        "-F", str(msg))
    head = run(repo.path, "git", "rev-parse", "HEAD")
    # Depending on the git build, a signature over a non-UTF-8 message either fails to verify
    # (unknown-key) or verifies as the owner's veto. Both are logged publicly; what matters is
    # that nothing crashes and the commit is never classified as a maintainer's.
    result = classify_range(base, head, repo.path, allowed)
    assert len(result) == 1 and result[0].sha == head
    assert result[0].status in {"unknown-key", "owner-veto"}
    assert result[0].principal in {None, "owner"}


def test_non_utf8_unsigned_commit_is_flagged(repo):
    allowed = repo.allowed(**{"owner": "own"})
    base = repo.commit("base", key="own")
    raw = subprocess.run(["git", "cat-file", "commit", base], cwd=repo.path, capture_output=True,
                         check=True).stdout
    # a child commit object with a \xff byte in the message and no signature
    body = b"tree " + run(repo.path, "git", "rev-parse", base + "^{tree}").encode() + \
        b"\nparent " + base.encode() + b"\nauthor A <a@b.c> 1 +0000\ncommitter A <a@b.c> 1 +0000\n\nbad \xff\n"
    head = subprocess.run(["git", "hash-object", "-t", "commit", "-w", "--stdin"], cwd=repo.path,
                          input=body, capture_output=True, check=True).stdout.decode().strip()
    assert classify_range(base, head, repo.path, allowed) == [CommitClass(head, "unsigned", None)]


def test_unexpected_exception_becomes_error_status(repo, monkeypatch):
    allowed = repo.allowed(**{"owner": "own"})
    sha = repo.commit("x", key="own")
    import tools.verify_signatures as vs
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(vs, "_classify", boom)
    assert classify_commit(sha, repo.path, allowed) == CommitClass(sha, "error", "RuntimeError: boom")


# --- allowed_signers validation (I2) -----------------------------------------------------------

def bad_signers(repo, name):
    keytype, b64 = repo.key("m1").with_suffix(".pub").read_text().split()[:2]
    keytype2, b642 = repo.key("own").with_suffix(".pub").read_text().split()[:2]
    lines = {
        "wildcard": [f'* namespaces="git" {keytype} {b64}'],
        "duplicate-key": [f'maint-1 namespaces="git" {keytype} {b64}',
                          f'owner namespaces="git" {keytype} {b64}'],
        "comma-principals": [f'maint-1,owner namespaces="git" {keytype} {b64}'],
        "extra-options": [f'maint-1 cert-authority,namespaces="git" {keytype} {b64}'],
        "no-options": [f"maint-1 {keytype} {b64}"],
        "uppercase": [f'Maint namespaces="git" {keytype2} {b642}'],
    }[name]
    f = repo.path.parent / "allowed_signers"
    f.write_text("\n".join(lines) + "\n")
    return f


@pytest.mark.parametrize("name", ["wildcard", "duplicate-key", "comma-principals",
                                  "extra-options", "no-options", "uppercase"])
def test_invalid_allowed_signers_makes_commit_error(repo, name):
    allowed = bad_signers(repo, name)
    sha = repo.commit("Fix", key="m1")
    c = classify_commit(sha, repo.path, allowed)
    assert c.status == "error" and "allowed_signers" in c.principal


def test_invalid_signers_in_git_history_errors_following_commit(repo):
    base = commit_signers(repo, "# ok\n", key="m1")
    keytype, b64 = repo.key("m1").with_suffix(".pub").read_text().split()[:2]
    bad = commit_signers(repo, f'* namespaces="git" {keytype} {b64}\n', key="m1")
    after = repo.commit("Merge: next", key="m1")
    result = classify_range(base, after, repo.path)
    assert result[0].status == "unknown-key"  # judged against the good parent file
    assert result[1].status == "error"        # judged against the bad file


def test_cli_since_anchor_with_before_and_forced(repo):
    pre, anchor, marker = anchored_repo(repo)
    tip = repo.commit("Merge: ok", key="m1")
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    proc = subprocess.run(
        [sys.executable, "-m", "tools.verify_signatures", "--since-anchor", "--before", marker,
         "--forced", tip], cwd=repo.path, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == f"{marker}..{tip} rewrite none"
    assert lines[1:] == [f"{anchor} maintainer maint-1", f"{marker} maintainer maint-1",
                         f"{tip} maintainer maint-1"]


# --- trusted log for dedup ---------------------------------------------------------------------

def log_repo(repo):
    """Maintainer-signed bootstrap with allowed_signers, a log and a copy of the classifier."""
    (repo.path / "moderation").mkdir()
    (repo.path / "moderation" / "log.md").write_text("# log\n")
    (repo.path / "tools").mkdir()
    (repo.path / "tools" / "verify_signatures.py").write_text(
        (ROOT / "tools" / "verify_signatures.py").read_text())
    return commit_signers(repo, signers_text(repo, **{"maint-1": "m1", "owner": "owner"}),
                          key="m1", message="Charter: bootstrap")


def probe_commits(repo):
    a = repo.commit("Fix stuff", key="owner")  # owner-unlabeled
    log = repo.path / "moderation" / "log.md"
    log.write_text(log.read_text() + f"2026-11-23 {a} owner-veto owner (veto)\n")
    run(repo.path, "git", "add", "-A")
    run(repo.path, "git", "-c", f"user.signingkey={repo.key('owner')}.pub", "commit", "-q", "-S",
        "-m", "Veto: tidy")
    return a, run(repo.path, "git", "rev-parse", "HEAD")


def test_trusted_log_rev_ignores_log_edited_by_flagged_commits(repo):
    base = log_repo(repo)
    a, b = probe_commits(repo)
    results = classify_since_anchor(b, repo.path)
    assert trusted_log_rev(results, repo.path, b) == base
    trusted = run(repo.path, "git", "show", f"{base}:moderation/log.md")
    assert a not in trusted
    assert CommitClass(a, "owner-unlabeled", "owner") in results


def test_trusted_log_rev_picks_latest_first_parent_maintainer(repo):
    base = log_repo(repo)
    later = repo.commit("Merge: later", key="m1")
    repo.commit("Fix", key="owner")
    results = classify_since_anchor(run(repo.path, "git", "rev-parse", "HEAD"), repo.path)
    assert trusted_log_rev(results, repo.path, "HEAD") == later


def test_trusted_log_rev_none_without_maintainer_commits(repo):
    sha = repo.commit("unsigned")
    assert trusted_log_rev(classify_since_anchor(sha, repo.path), repo.path, sha) is None


def test_trusted_log_rev_skips_maintainer_commits_off_the_first_parent_chain(repo):
    base = log_repo(repo)
    run(repo.path, "git", "checkout", "-q", "-b", "side")
    repo.commit("Merge: side", key="m1")
    run(repo.path, "git", "checkout", "-q", "main")
    merge = repo.merge("side")  # unsigned, so the side commit is judged normally: maintainer
    results = classify_since_anchor(merge, repo.path)
    assert any(c.status == "maintainer" for c in results[1:])
    assert trusted_log_rev(results, repo.path, merge) == base


def workflow_step(index):
    import yaml
    d = yaml.safe_load((ROOT / ".github" / "workflows" / "verify-main.yml").read_text())
    return d["jobs"]["verify"]["steps"][index]["run"]


def run_classify_step(repo, tmp_path, before, head, pending_body=""):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    gh = bindir / "gh"
    gh.write_text(f"#!/bin/sh\ncat <<'EOF_PENDING'\n{pending_body}\nEOF_PENDING\n")
    gh.chmod(0o755)
    temp = tmp_path / "runner"
    temp.mkdir(exist_ok=True)
    script = tmp_path / "step.sh"
    script.write_text(workflow_step(1))
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "RUNNER_TEMP": str(temp),
           "GITHUB_OUTPUT": str(temp / "out"), "BEFORE": before, "FORCED": "false",
           "HEAD_SHA": head, "GH_TOKEN": "x", "GH_REPO": "o/r"}
    proc = subprocess.run(["bash", str(script)], cwd=repo.path, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    return (temp / "flagged.txt").read_text()


def test_workflow_dedup_cannot_be_forged_by_the_pushed_log(repo, tmp_path):
    base = log_repo(repo)
    a, b = probe_commits(repo)
    flagged = run_classify_step(repo, tmp_path, base, b)
    assert f" {a} owner-unlabeled owner" in flagged
    assert f" {b} owner-veto owner (veto)" in flagged


def test_workflow_skips_ids_pending_in_an_open_verifier_pr(repo, tmp_path):
    base = log_repo(repo)
    a, b = probe_commits(repo)
    pending = f"```\n2026-11-23 {a} owner-unlabeled owner\n```"
    flagged = run_classify_step(repo, tmp_path, base, b, pending_body=pending)
    assert a not in flagged and b in flagged


def test_workflow_skips_ids_in_the_trusted_log(repo, tmp_path):
    base = log_repo(repo)
    a = repo.commit("Fix stuff", key="owner")
    log = repo.path / "moderation" / "log.md"
    log.write_text(log.read_text() + f"2026-11-23 {a} owner-unlabeled owner\n")
    run(repo.path, "git", "add", "-A")
    run(repo.path, "git", "-c", f"user.signingkey={repo.key('m1')}.pub", "commit", "-q", "-S",
        "-m", "Edit: log it")
    head = run(repo.path, "git", "rev-parse", "HEAD")
    assert run_classify_step(repo, tmp_path, base, head).strip() == ""


# --- launch sequence: the anchor is read from HEAD until BEFORE has a valid one ---------------

def launch_repo(repo):
    """seed (unsigned, no ANCHOR) -> launch (placeholder ANCHOR, signers) -> ANCHOR=launch."""
    seed = repo.commit("seed")
    m = repo.path / "maintainers"
    m.mkdir()
    (m / "allowed_signers").write_text(signers_text(repo, **{"editor-1": "e1"}))
    (m / "ANCHOR").write_text("# The launch anchor: no sha yet.\n")
    (repo.path / "tools").mkdir()
    (repo.path / "tools" / "verify_signatures.py").write_text(
        (ROOT / "tools" / "verify_signatures.py").read_text())
    launch = repo.commit("Charter: launch", key="e1")
    (m / "ANCHOR").write_text(f"# The launch anchor.\n{launch}\n")
    anchored = repo.commit("Charter: set the anchor to the launch commit", key="e1")
    return seed, launch, anchored


def test_launch_pushes_produce_no_flags(repo):
    seed, launch, anchored = launch_repo(repo)
    expected = [CommitClass(launch, "maintainer", "editor-1"),
                CommitClass(anchored, "maintainer", "editor-1")]
    # BEFORE = seed: it has no ANCHOR, so the anchor comes from HEAD.
    assert classify_since_anchor(anchored, repo.path, before=seed) == expected
    # BEFORE = launch: its ANCHOR is a placeholder, so the anchor still comes from HEAD.
    assert classify_since_anchor(anchored, repo.path, before=launch) == expected
    # Scheduled and dispatched runs have no BEFORE.
    assert classify_since_anchor(anchored, repo.path) == expected


def test_anchor_commit_is_judged_against_its_own_allowed_signers(repo):
    seed, launch, anchored = launch_repo(repo)
    # The launch commit's parent (seed) has no allowed_signers: judged against the parent's
    # file it would be unknown-key. As the anchor it is judged against the file it ships.
    assert classify_range(seed, launch, repo.path) == [CommitClass(launch, "unknown-key", None)]
    assert classify_since_anchor(anchored, repo.path)[0] == CommitClass(launch, "maintainer",
                                                                        "editor-1")


def test_valid_anchor_in_before_still_wins_over_head(repo):
    """Once BEFORE holds an anchor, a push cannot move the anchor to hide its own commits."""
    seed, launch, anchored = launch_repo(repo)
    sneaky = repo.commit("unsigned change")
    (repo.path / "maintainers" / "ANCHOR").write_text(f"{sneaky}\n")
    tip = repo.commit("unsigned: move the anchor past the unsigned change")
    (repo.path / "maintainers" / "ANCHOR").write_text(f"{tip}\n")
    result = classify_since_anchor(tip, repo.path, before=anchored)
    assert CommitClass(sneaky, "unsigned", None) in result
    assert result[0] == CommitClass(launch, "maintainer", "editor-1")


def test_launch_workflow_step_flags_nothing(repo, tmp_path):
    seed, launch, anchored = launch_repo(repo)
    assert run_classify_step(repo, tmp_path, seed, anchored).strip() == ""
    assert run_classify_step(repo, tmp_path, launch, anchored).strip() == ""


def test_workflow_dedup_matches_the_sha_as_the_second_field_only(repo, tmp_path):
    """A log line that merely mentions a sha (in a reason) does not hide that commit's flag."""
    base = log_repo(repo)
    a = repo.commit("Fix stuff", key="owner")
    log = repo.path / "moderation" / "log.md"
    log.write_text(log.read_text() + f"2026-11-23 edit PR-1 by maint-1: about {a} and more\n")
    run(repo.path, "git", "add", "-A")
    run(repo.path, "git", "-c", f"user.signingkey={repo.key('m1')}.pub", "commit", "-q", "-S",
        "-m", "Edit: mention it")
    head = run(repo.path, "git", "rev-parse", "HEAD")
    assert f" {a} owner-unlabeled owner" in run_classify_step(repo, tmp_path, base, head)


def test_workflow_log_append_starts_on_a_new_line(tmp_path):
    """The append in the log PR step adds a newline first when the log lacks a trailing one."""
    script = workflow_step(3)
    lines = [l for l in script.splitlines() if ">> moderation/log.md" in l]
    assert len(lines) == 2
    snippet = "\n".join(lines)
    (tmp_path / "moderation").mkdir()
    (tmp_path / "moderation" / "log.md").write_text("# log\nlast line without newline")
    (tmp_path / "flagged.txt").write_text("2026-11-23 abc unsigned none\n")
    env = {**os.environ, "RUNNER_TEMP": str(tmp_path)}
    subprocess.run(["bash", "-euo", "pipefail", "-c", snippet], cwd=tmp_path, env=env, check=True)
    assert (tmp_path / "moderation" / "log.md").read_text() == (
        "# log\nlast line without newline\n2026-11-23 abc unsigned none\n")
    subprocess.run(["bash", "-euo", "pipefail", "-c", snippet], cwd=tmp_path, env=env, check=True)
    assert "none\n2026-11-23 abc" in (tmp_path / "moderation" / "log.md").read_text()


def test_orphan_launch_commit_pushed_alone_is_clean(repo, tmp_path):
    """main created as one signed root commit with a placeholder ANCHOR: nothing is flagged."""
    m = repo.path / "maintainers"
    m.mkdir()
    (m / "allowed_signers").write_text(signers_text(repo, **{"editor-1": "e1"}))
    (m / "ANCHOR").write_text("# The launch anchor: no sha yet.\n")
    (repo.path / "tools").mkdir()
    (repo.path / "tools" / "verify_signatures.py").write_text(
        (ROOT / "tools" / "verify_signatures.py").read_text())
    launch = repo.commit("Charter: launch", key="e1")
    zeros = "0" * 40
    assert classify_since_anchor(launch, repo.path, before=zeros) == [
        CommitClass(launch, "maintainer", "editor-1")]
    assert run_classify_step(repo, tmp_path, zeros, launch).strip() == ""


def test_blanking_the_anchor_in_one_push_does_not_let_the_next_push_choose_it(repo):
    """Push 1 blanks ANCHOR; push 2 ships its own signers and anchors on itself."""
    seed, launch, anchored = launch_repo(repo)
    m = repo.path / "maintainers"
    (m / "ANCHOR").write_text("# blanked\n")
    blank = repo.commit("unsigned: blank the anchor")          # push 1 ends here
    assert CommitClass(blank, "unsigned", None) in classify_since_anchor(
        blank, repo.path, before=anchored)
    sneaky = repo.commit("unsigned: sneaky change")             # push 2 starts here
    (m / "allowed_signers").write_text(signers_text(repo, **{"editor-1": "owner"}))
    forged = repo.commit("Roster: ship my own signers", key="owner")
    (m / "ANCHOR").write_text(f"{forged}\n")
    tip = repo.commit("Charter: anchor on the forged commit", key="owner")
    result = classify_since_anchor(tip, repo.path, before=blank)
    assert CommitClass(sneaky, "unsigned", None) in result
    assert CommitClass(forged, "unknown-key", None) in result
    assert result[0] == CommitClass(launch, "maintainer", "editor-1")


def test_deleting_the_anchor_file_in_one_push_does_not_free_the_next(repo):
    seed, launch, anchored = launch_repo(repo)
    m = repo.path / "maintainers"
    (m / "ANCHOR").unlink()
    gone = repo.commit("unsigned: delete the anchor file")      # push 1
    sneaky = repo.commit("unsigned: sneaky change")             # push 2
    (m / "ANCHOR").write_text(f"{sneaky}\n")
    tip = repo.commit("unsigned: anchor past the sneaky change")
    (m / "ANCHOR").write_text(f"{tip}\n")
    result = classify_since_anchor(tip, repo.path, before=gone)
    assert result[0] == CommitClass(launch, "maintainer", "editor-1")
    assert CommitClass(sneaky, "unsigned", None) in result
