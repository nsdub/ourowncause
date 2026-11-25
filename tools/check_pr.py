"""Pull request check: validate one submitted post, scan it, and render a report comment.

The check fails only on hard errors. Injection findings and near-duplicates are reported
for a maintainer to judge and never fail it.
"""
import argparse
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from tools.injection import Finding, scan
from tools.novelty import similar
from tools.post import Post, PostError, load_post
from tools.validate import validate
from tools.verify_signatures import validate_allowed_signers

PRINCIPAL = "author"
_GOOD = re.compile(r'^Good "git" signature for (\S+) with ', re.MULTILINE)
_QID = re.compile(r"^(q-\d{3,})-.+\.md$")
# The documented path of a post. [0-9], not \d: \d also matches digits of other scripts.
_NEW_POST = re.compile(r"posts/[0-9]{4}/(?:0[1-9]|1[0-2])/([a-z0-9]+(?:-[a-z0-9]+)*)\.md")
MAX_SLUG_CHARS = 100
NEW_POST_PATH = ("a new post's path must be posts/YYYY/MM/<name>.md, where <name> is at most "
                 f"{MAX_SLUG_CHARS} lowercase letters and digits joined by single hyphens")


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    injection: list[Finding] = field(default_factory=list)
    similar: list[tuple[str, float]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True,
                          errors="replace", check=False)


def _key_parts(value) -> tuple[str, str] | None:
    """(keytype, base64) of an SSH public key string, or None if it is not one."""
    if not isinstance(value, str):
        return None
    tokens = value.split()
    if len(tokens) < 2 or not tokens[0].startswith(("ssh-", "ecdsa-", "sk-")):
        return None
    return tokens[0], tokens[1]


def _registered_keys(contributors_dir: Path) -> set[tuple[str, str]]:
    keys = set()
    for p in sorted(Path(contributors_dir).glob("*.md")):
        if p.is_symlink():
            continue
        try:
            parts = _key_parts(load_post(p).meta.get("key"))
        except PostError:
            continue
        if parts:
            keys.add(parts)
    return keys


def check_author_signature(post: Post, commits: list[str], repo: Path,
                           git_repo: Path | None = None, key=None,
                           contributors_dir: Path | None = None) -> list[str]:
    """Errors unless the author key is registered in contributors/ and signed every commit.

    The key is `key` when given, else the post's author.key. Contributors are read from
    `contributors_dir` (default `repo`/contributors); commits are verified in `git_repo`
    (default `repo`).
    """
    if key is None:
        author = post.meta.get("author")
        if not isinstance(author, dict) or "key" not in author:
            return []
        key = author["key"]
    repo = Path(repo)
    parts = _key_parts(key)
    if parts is None:
        return ["author.key is not a valid SSH public key (expected `ssh-ed25519 AAAA...`)"]
    if parts not in _registered_keys(contributors_dir or repo / "contributors"):
        return ["author.key is not registered: no contributors/ file lists this key"]
    if not commits:
        return ["author.key is set but the pull request has no commits to verify"]
    line = f'{PRINCIPAL} namespaces="git" {parts[0]} {parts[1]}\n'
    problem = validate_allowed_signers(line)
    if problem:
        return [f"author.key cannot be used for verification: {problem}"]
    errors = []
    with tempfile.TemporaryDirectory() as tmp:
        signers = Path(tmp) / "allowed_signers"
        signers.write_text(line)
        for sha in commits:
            proc = _git(git_repo or repo, "-c", "gpg.format=ssh", "-c", f"gpg.ssh.allowedSignersFile={signers}",
                        "verify-commit", "--raw", sha)
            match = _GOOD.search(proc.stdout + proc.stderr) if proc.returncode == 0 else None
            if not match or match.group(1) != PRINCIPAL:
                errors.append(f"commit {sha[:12]} is not signed by author.key")
    return errors


def _known_questions(repo: Path, questions_dir: Path | None = None) -> set[str]:
    """Question ids from the page names in questions_dir (default `repo`/questions)."""
    out = set()
    for p in Path(questions_dir or Path(repo) / "questions").glob("q-*.md"):
        m = _QID.match(p.name)
        if m:
            out.add(m.group(1))
    return out


def _archive(repo: Path, exclude: Path, report: Report) -> dict[str, Post]:
    posts = {}
    for p in sorted(Path(repo).joinpath("posts").rglob("*.md")):
        if p.is_symlink() or p.resolve() == exclude.resolve():
            continue
        try:
            post = load_post(p)
        except PostError as e:
            report.warnings.append(f"existing post {p.relative_to(repo).as_posix()} could not be "
                                   f"loaded and was skipped for citations and novelty: {e.message}")
            continue
        posts[post.slug] = post
    return posts


def _key_of(post: Post | None):
    author = post.meta.get("author") if post else None
    return author.get("key") if isinstance(author, dict) else None


def check_changed_files(paths: list[Path], repo: Path, commits: list[str] | None = None,
                        git_repo: Path | None = None,
                        contributors_dir: Path | None = None,
                        base_post: Path | None = None,
                        questions_dir: Path | None = None) -> Report:
    """Check the PR's changed paths against the tree at `repo`.

    `commits` are the commits that touch the post, verified in `git_repo`.
    `contributors_dir` is the trusted (base) registry of contributor keys, default
    `repo`/contributors. `base_post` is the post's file at base, when it already existed:
    its author.key cannot be dropped or swapped. `questions_dir` holds the question pages
    at base, default `repo`/questions: a submission cannot create the question it cites.
    """
    repo = Path(repo)
    contributors_dir = Path(contributors_dir) if contributors_dir else repo / "contributors"
    report = Report()

    changed_contrib = [Path(p) for p in paths if Path(p).parts[:1] == ("contributors",)]
    if changed_contrib:
        names = ", ".join(p.as_posix() for p in changed_contrib)
        report.warnings.append(f"This PR changes contributors/: {names}. A maintainer must "
                               f"review key registrations.")
    for p in changed_contrib:
        if p.suffix != ".md" or len(p.parts) != 2:
            continue
        old, new = contributors_dir / p.name, repo / p
        if old.is_file() and new.is_file():
            try:
                old_key = _key_parts(load_post(old).meta.get("key"))
                new_key = _key_parts(load_post(new).meta.get("key"))
            except PostError:
                continue
            if old_key != new_key:
                report.errors.append(f"{p.as_posix()}: changing an existing contributor's key "
                                     f"is not allowed in a submission")
    if any(Path(p).name == ".gitattributes" for p in paths):
        report.warnings.append("This PR changes .gitattributes. The check reads files as raw "
                               "git blobs, but a maintainer should review the change.")

    post_paths = [Path(p) for p in paths if Path(p).parts[:1] == ("posts",)]
    if not post_paths:
        return report
    if len(post_paths) > 1:
        report.errors.append(
            f"one post per pull request: this one changes {len(post_paths)} files under posts/")
        return report
    rel = post_paths[0]
    others = sorted({Path(p).as_posix() for p in paths} - {rel.as_posix()})
    if others:
        report.warnings.append(
            f"This PR changes {rel.as_posix()} and also paths outside that post: "
            f"{', '.join(others)}. A submission adds one post and nothing else; a maintainer "
            f"must review every other change.")
    full = repo / rel
    if rel.suffix != ".md":
        report.errors.append(f"{rel.as_posix()}: files under posts/ must be markdown (.md)")
        return report
    if full.is_symlink():
        report.errors.append(f"{rel.as_posix()}: symlinks and submodules are not allowed")
        return report
    try:
        post = load_post(full)
    except PostError as e:
        report.errors.append(f"{rel.as_posix()}: {e.message}")
        return report

    archive = _archive(repo, full, report)
    report.errors.extend(validate(post, set(archive), _known_questions(repo, questions_dir)))

    base_key = None
    if base_post is not None:
        try:
            base_key = _key_of(load_post(base_post))
        except PostError:
            pass
    head_key = _key_of(post)
    expected = base_key if base_key is not None else head_key
    if base_key is not None and _key_parts(head_key) != _key_parts(base_key):
        report.errors.append("author.key was changed or removed: an existing post keeps the "
                             "key it was published with")
    if commits is not None and expected is not None:
        report.errors.extend(check_author_signature(post, commits, repo, git_repo, key=expected,
                                                    contributors_dir=contributors_dir))

    report.injection = scan(full.read_bytes().decode("utf-8-sig"))
    report.similar = similar(post.body, {s: p.body for s, p in archive.items()})
    return report


ITEM_CAP = 50
ITEM_CHARS = 400
TEXT_CAP = 60_000  # GitHub rejects comments over 65,536 characters


def _code(text: str, max_chars: int | None = None) -> str:
    """Inline code span that survives backticks and keeps attacker text from rendering."""
    text = " ".join(str(text).split())
    if max_chars is not None and len(text) > max_chars:
        text = text[:max_chars] + "…"
    fence = "`" * (max((len(m) for m in re.findall(r"`+", text)), default=0) + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def render_report(report: Report, full: bool = False) -> str:
    """Markdown comment. Unless `full`, sections and the whole text are capped for GitHub."""
    mc = None if full else ITEM_CHARS

    def section(items: list[str]) -> list[str]:
        if full or len(items) <= ITEM_CAP:
            return items or ["None."]
        return items[:ITEM_CAP] + [f"…and {len(items) - ITEM_CAP} more (see the job log)"]

    out = ["## Our Own Cause — submission check", "", "### Errors", ""]
    out += section([f"- {_code(e, mc)}" for e in report.errors])
    out += ["", "### Possible injected instructions", "",
            "These findings are for a maintainer to judge. They do not fail the check: a post "
            "may quote an injection in order to discuss it.", ""]
    out += section([f"- {f.kind}, line {f.line}: {_code(f.excerpt, mc)}" for f in report.injection])
    out += ["", "### Similar existing posts", ""]
    out += section([f"- {_code(slug, mc)}: {score:.2f}" for slug, score in report.similar])
    out += ["", "### Warnings", ""]
    out += section([f"- {_code(w, mc)}" for w in report.warnings])
    result = f"Result: {'passed' if report.ok else 'failed'}"
    text = "\n".join(out)
    if not full and len(text) > TEXT_CAP:
        text = text[:TEXT_CAP].rsplit("\n", 1)[0] + "\n\n…report truncated (see the job log)"
    return text + "\n\n" + result + "\n"


_REGULAR = ("100644", "100755")


def _tree(repo: Path, rev: str, *dirs: str) -> list[tuple[str, str, str]]:
    """(mode, sha, path) for every entry under dirs at rev. Reads objects, applies no attributes."""
    out = _git(repo, "ls-tree", "-r", "-z", rev, "--", *dirs).stdout
    entries = []
    for rec in out.split("\0"):
        if rec:
            meta, path = rec.split("\t", 1)
            mode, _type, sha = meta.split()
            entries.append((mode, sha, path))
    return entries


def _blob(repo: Path, sha: str) -> bytes:
    return subprocess.run(["git", "cat-file", "blob", sha], cwd=repo, capture_output=True,
                          check=True).stdout


def _safe_target(dest: Path, path: str) -> Path:
    """dest/path, or ValueError if the tree path could leave dest or touch a .git directory."""
    parts = path.split("/")
    if (not path or path.startswith("/") or "\\" in path
            or any(part in ("", ".", "..") or part.lower() == ".git" for part in parts)):
        raise ValueError(f"unsafe path in tree: {path!r}")
    root = dest.resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError(f"unsafe path in tree: {path!r}")
    return target


def materialize(rev: str, repo: Path, dest: Path, *dirs: str) -> None:
    """Write rev's regular files under dirs into dest from raw git blobs.

    No `.gitattributes` filter applies (unlike git archive or checkout), and symlinks and
    submodules are skipped, so what is read is what merges. Nothing is executed.
    A tree path that is absolute, has a `..`, `.` or `.git` component, or resolves outside
    dest raises ValueError before anything is written.
    """
    entries = [(sha, _safe_target(dest, path))
               for mode, sha, path in _tree(repo, rev, *dirs) if mode in _REGULAR]
    for sha, target in entries:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_blob(repo, sha))


def _status_entries(repo: Path, base: str, head: str):
    """[(status, path)] from base...head with rename detection off, or None on git failure."""
    diff = _git(repo, "diff", "--name-status", "--no-renames", "-z", f"{base}...{head}")
    if diff.returncode:
        return None, " ".join(diff.stderr.split())
    toks = [t for t in diff.stdout.split("\0") if t]
    return list(zip(toks[0::2], toks[1::2])), ""


def run_check(repo: Path, base: str, head: str) -> Report:
    entries, err = _status_entries(repo, base, head)
    if entries is None:
        return Report(errors=[f"could not compute the pull request's changes: {err}"])
    errors: list[str] = []
    head_modes = {path: mode for mode, _sha, path in _tree(repo, head, "posts")}
    paths: list[Path] = []
    for status, path in entries:
        top = Path(path).parts[:1]
        if top == ("posts",):
            if status not in ("A", "M"):
                errors.append(f"{path}: deleting or renaming posts is not allowed in a "
                              f"submission (status {status})")
            elif head_modes.get(path) not in _REGULAR:
                errors.append(f"{path}: symlinks and submodules are not allowed")
            else:
                # The path becomes a URL. A post already on main keeps the path it has.
                match = _NEW_POST.fullmatch(path)
                if status == "A" and not (match and len(match.group(1)) <= MAX_SLUG_CHARS):
                    errors.append(f"{path}: {NEW_POST_PATH}")
                paths.append(Path(path))
        else:  # every other changed path, whatever its status: reported next to a post
            paths.append(Path(path))

    posts = [p for p in paths if p.parts[:1] == ("posts",)]
    commits = None
    base_post = None
    with tempfile.TemporaryDirectory() as tmp:
        head_dir, base_dir = Path(tmp) / "head", Path(tmp) / "base"
        head_dir.mkdir()
        base_dir.mkdir()
        try:
            materialize(head, repo, head_dir, "posts", "contributors")
            # Trusted state comes from base: contributor keys and the known question ids.
            materialize(base, repo, base_dir, "contributors", "questions")
            if len(posts) == 1:
                # Only commits that touch the post count; merges of main into the branch do not.
                revs = _git(repo, "rev-list", f"{base}..{head}", "--", posts[0].as_posix())
                commits = revs.stdout.split() if revs.returncode == 0 else []
                for mode, sha, path in _tree(repo, base, posts[0].as_posix()):
                    if mode in _REGULAR:
                        base_post = Path(tmp) / "base_post.md"
                        base_post.write_bytes(_blob(repo, sha))
        except (subprocess.CalledProcessError, OSError, ValueError) as e:
            return Report(errors=errors + [f"could not read the pull request's files: {e}"])
        report = check_changed_files(paths, head_dir, commits, repo,
                                     base_dir / "contributors", base_post,
                                     base_dir / "questions")
    report.errors = errors + report.errors
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Check a pull request's submitted post.")
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--out", type=Path, help="report capped to fit a GitHub comment")
    ap.add_argument("--full-out", type=Path, help="the uncapped report")
    args = ap.parse_args(argv)
    report = run_check(Path.cwd(), args.base, args.head)
    if args.out:
        args.out.write_text(render_report(report))
    full = render_report(report, full=True)
    if args.full_out:
        args.full_out.write_text(full)
    print(full)
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
