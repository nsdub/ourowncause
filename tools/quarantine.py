"""Copy a submitted post, byte for byte, from a commit into quarantine/.

Usage: python -P -m tools.quarantine <commit sha> <post path>

The safety reviewer runs this when neutralizing a piece. The original is read as a raw git
blob (no checkout, no `.gitattributes` filter) and written to `quarantine/` at the post's path
without its leading `posts/`, so `posts/2026/12/x.md` becomes `quarantine/2026/12/x.md`.
The site serves quarantined files escaped, as inert text.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

from tools.check_pr import _REGULAR, _blob, _safe_target, _tree

_SHA = re.compile(r"^[0-9a-f]{40}$")


def quarantine(sha: str, post_path: str, repo: Path) -> Path:
    """Write `<sha>:<post_path>` to repo/quarantine/ and return the file written.

    Raises ValueError, before writing anything, when sha is not a full commit id in the
    repository, when the path is not a regular file under posts/ in that commit, when it
    could resolve outside quarantine/, or when a different file is already quarantined there.
    """
    repo = Path(repo)
    if not _SHA.match(sha):
        raise ValueError("the commit must be a full 40-character lowercase hex sha")
    exists = subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=repo,
                            capture_output=True)
    if exists.returncode != 0:
        raise ValueError(f"no such commit in this repository: {sha}")
    if not post_path.startswith("posts/"):
        raise ValueError(f"only files under posts/ can be quarantined, not {post_path!r}")
    rel = post_path[len("posts/"):]
    dest = repo / "quarantine"
    target = _safe_target(dest, rel)
    blobs = [blob for mode, blob, path in _tree(repo, sha, post_path)
             if path == post_path and mode in _REGULAR]
    if len(blobs) != 1:
        raise ValueError(f"{post_path} is not a regular file in commit {sha}")
    data = _blob(repo, blobs[0])
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file() or target.read_bytes() != data:
            raise ValueError(f"{target.relative_to(repo.resolve()).as_posix()} already exists "
                             f"with different content; nothing was overwritten")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Copy a post from a commit into quarantine/.")
    ap.add_argument("sha", help="the full sha of the commit that holds the original")
    ap.add_argument("post_path", help="the post's path in that commit, starting with posts/")
    args = ap.parse_args(argv)
    repo = Path.cwd()
    try:
        target = quarantine(args.sha, args.post_path, repo)
    except (ValueError, subprocess.CalledProcessError, OSError) as e:
        print(f"quarantine refused: {e}", file=sys.stderr)
        return 1
    print(target.relative_to(repo.resolve()).as_posix())
    return 0


if __name__ == "__main__":
    sys.exit(main())
