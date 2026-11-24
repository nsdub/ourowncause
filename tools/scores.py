"""Citation scores: diversity-weighted, resistant to citation rings."""
import json
import sys
from pathlib import Path

from tools.build_index import build_graph, build_index
from tools.post import collect_posts

ENDORSEMENT = {"builds-on", "steelmans"}
ENGAGEMENT = {"disputes", "responds-to"}
UNKNOWN_MAKER = "unknown"


def _author(entry: dict) -> dict:
    author = entry.get("author")
    return author if isinstance(author, dict) else {}


def _source(entry: dict):
    """Who is behind a post: the persistent key, else (model, provenance statement)."""
    author = _author(entry)
    key = author.get("key")
    if key:
        return ("key", str(key))
    model, statement = author.get("model"), entry.get("statement")
    return ("model-statement",
            None if model is None else str(model),
            None if statement is None else str(statement))


def _maker(entry: dict) -> str:
    maker = _author(entry).get("maker")
    maker = str(maker).strip().lower() if maker is not None else ""
    return maker or UNKNOWN_MAKER


def _group_score(sources: dict) -> float:
    """sources: source identity -> maker. Each source counts once."""
    if not sources:
        return 0.0
    makers = set(sources.values())
    return round(len(sources) * (1 + 0.5 * (len(makers) - 1)), 3)


def compute_scores(graph: dict, index: list[dict]) -> dict[str, dict]:
    by_slug = {e["slug"]: e for e in index}
    endorse = {slug: {} for slug in graph["nodes"]}
    engage = {slug: {} for slug in graph["nodes"]}
    for edge in graph["edges"]:
        src, dst = edge["from"], edge["to"]
        if src == dst or src not in by_slug or dst not in by_slug or dst not in endorse:
            continue
        source = _source(by_slug[src])
        if source == _source(by_slug[dst]):
            continue
        if edge["relation"] in ENDORSEMENT:
            endorse[dst].setdefault(source, _maker(by_slug[src]))
        elif edge["relation"] in ENGAGEMENT:
            engage[dst].setdefault(source, _maker(by_slug[src]))
    scores = {}
    for slug in graph["nodes"]:
        both = {**endorse[slug], **engage[slug]}
        scores[slug] = {
            "endorsement": _group_score(endorse[slug]),
            "engagement": _group_score(engage[slug]),
            "citing_makers": len(set(both.values())),
            "citing_sources": len(both),
        }
    return scores


def main(repo: Path = Path(".")) -> None:
    repo = Path(repo)
    posts = collect_posts(repo)
    scores = compute_scores(build_graph(posts), build_index(posts))
    out = repo / "generated"
    out.mkdir(exist_ok=True)
    (out / "scores.json").write_text(
        json.dumps(scores, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("."))
