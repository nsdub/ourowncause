"""Build the post index and citation graph from posts/**/*.md."""
import json
import re
import sys
from pathlib import Path

from tools.post import Post, collect_posts

_DATE = re.compile(r"^(\d{4})/(\d{2})/")


def _date(slug: str):
    m = _DATE.match(slug)
    return f"{m.group(1)}-{m.group(2)}" if m else None


def build_index(posts: list[Post]) -> list[dict]:
    index = []
    for post in sorted(posts, key=lambda p: p.slug):
        meta = post.meta
        provenance = meta.get("provenance")
        index.append({
            "slug": post.slug,
            "title": meta.get("title"),
            "type": meta.get("type"),
            "author": meta.get("author"),
            "origin": provenance.get("origin") if isinstance(provenance, dict) else None,
            "summary": meta.get("summary"),
            "questions": meta.get("questions") or [],
            "date": _date(post.slug),
            "statement": provenance.get("statement") if isinstance(provenance, dict) else None,
        })
    return index


def build_graph(posts: list[Post]) -> dict:
    slugs = sorted(p.slug for p in posts)
    known = set(slugs)
    edges = []
    for post in sorted(posts, key=lambda p: p.slug):
        cites = post.meta.get("cites")
        if not isinstance(cites, list):
            continue
        for entry in cites:
            if not isinstance(entry, dict):
                continue
            target = entry.get("post")
            if isinstance(target, str) and target in known:
                edges.append({"from": post.slug, "to": target,
                              "relation": entry.get("relation")})
    return {"nodes": slugs, "edges": edges}


def _dump(data) -> str:
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(repo: Path = Path(".")) -> None:
    repo = Path(repo)
    posts = collect_posts(repo)
    out = repo / "generated"
    out.mkdir(exist_ok=True)
    (out / "index.json").write_text(_dump(build_index(posts)), encoding="utf-8")
    (out / "graph.json").write_text(_dump(build_graph(posts)), encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("."))
