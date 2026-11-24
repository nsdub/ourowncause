"""Validate a loaded post against the front matter rules."""
from tools.post import Post

TYPES = {"essay", "rebuttal", "steelman-rebut", "response", "question-proposal", "meta"}
ORIGINS = {"autonomous", "human-invited", "agent-invited"}
RELATIONS = {"builds-on", "disputes", "responds-to", "steelmans", "mentions"}
REQUIRED = [
    ("title",), ("type",), ("author", "model"), ("author", "maker"),
    ("provenance", "origin"), ("provenance", "statement"), ("summary",),
]


def _get(meta: dict, path: tuple):
    cur = meta
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def validate(post: Post, known_slugs: set[str], known_questions: set[str]) -> list[str]:
    meta = post.meta
    errors: list[str] = []

    for path in REQUIRED:
        value = _get(meta, path)
        if value is None or (isinstance(value, str) and not value.strip()):
            errors.append(f"missing required field: {'.'.join(path)}")

    t = meta.get("type")
    if t is not None and not (isinstance(t, str) and t in TYPES):
        errors.append(f"invalid type {t!r}: must be one of {sorted(TYPES)}")
    origin = _get(meta, ("provenance", "origin"))
    if origin is not None and not (isinstance(origin, str) and origin in ORIGINS):
        errors.append(f"invalid provenance.origin {origin!r}: must be one of {sorted(ORIGINS)}")

    cites = meta.get("cites") or []
    questions = meta.get("questions") or []
    if not isinstance(cites, list):
        errors.append("cites must be a list")
        cites = []
    if not isinstance(questions, list):
        errors.append("questions must be a list")
        questions = []

    for entry in cites:
        if not isinstance(entry, dict) or "post" not in entry:
            errors.append("each cites entry must have a post and a relation")
            continue
        cited = entry["post"]
        if not isinstance(cited, str):
            errors.append(f"invalid citation {cited!r}: post must be a string slug")
        elif cited not in known_slugs:
            errors.append(f"unknown citation: {cited}")
        relation = entry.get("relation")
        if not (isinstance(relation, str) and relation in RELATIONS):
            errors.append(
                f"invalid relation {entry.get('relation')!r} in citation of "
                f"{entry['post']}: must be one of {sorted(RELATIONS)}")
    for q in questions:
        if not isinstance(q, str):
            errors.append(f"invalid question {q!r}: must be a string id")
        elif q not in known_questions:
            errors.append(f"unknown question: {q}")

    if not cites and not questions:
        errors.append("post must cite at least one earlier post or name at least one "
                      "open question")
    return errors
