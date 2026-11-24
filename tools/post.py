"""Load a post file: markdown with YAML front matter."""
from dataclasses import dataclass
from pathlib import Path

import yaml

MAX_BYTES = 200 * 1024


class PostError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Post:
    slug: str
    meta: dict
    body: str
    path: Path


def _slug(path: Path, root: Path | None = None) -> str:
    """Slug = path under posts/. With a repo root: relative to root/posts.

    Without a root, the part after the last `posts` component is used.
    Never returns an empty string.
    """
    if root is not None:
        try:
            return "/".join(path.with_suffix("").relative_to(Path(root) / "posts").parts)
        except ValueError:
            pass
    parts = path.with_suffix("").parts
    if "posts" in parts:
        idx = len(parts) - 1 - parts[::-1].index("posts")
        slug = "/".join(parts[idx + 1:])
        if slug:
            return slug
    return path.stem


def load_post(path: Path, root: Path | None = None) -> Post:
    path = Path(path)
    try:
        size = path.stat().st_size
    except OSError as e:
        raise PostError(f"cannot read file: {e.strerror or e}") from e
    if size > MAX_BYTES:
        raise PostError(f"file too large: {size} bytes exceeds the {MAX_BYTES} byte limit")
    try:
        text = path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as e:
        raise PostError(f"file is not valid UTF-8 (invalid byte at position {e.start})") from e
    text = text.lstrip("﻿").replace("\r\n", "\n")

    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise PostError("missing front matter: file must start with a --- line")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        raise PostError("missing front matter: no closing --- line") from None

    try:
        meta = yaml.safe_load("\n".join(lines[1:end]))
    except (yaml.YAMLError, ValueError, RecursionError) as e:
        # PyYAML raises ValueError for values such as `0x_` or the date 2026-13-45, and
        # RecursionError for very deep nesting.
        raise PostError(f"invalid YAML in front matter: {e}") from e
    except Exception as e:
        # PyYAML also raises AttributeError (`!!timestamp "x"`) and KeyError (`!!bool maybe`)
        # on some tagged values. A malformed post gets a report, never a traceback.
        raise PostError(f"front matter could not be parsed: {type(e).__name__}") from e
    if not isinstance(meta, dict):
        raise PostError("front matter must be a YAML mapping")

    body = "\n".join(lines[end + 1:])
    if not body.strip():
        raise PostError("empty body: post has no content after the front matter")
    return Post(slug=_slug(path, root), meta=meta, body=body, path=path)


def collect_posts(repo: Path) -> list[Post]:
    """Load every posts/**/*.md under the repo root, sorted by slug.

    Only the posts/ tree is read: quarantine/ and everything else is ignored.
    A file that fails to load raises PostError.
    """
    posts = [load_post(p, repo) for p in Path(repo).joinpath("posts").rglob("*.md")]
    return sorted(posts, key=lambda p: p.slug)
