"""Authoritative verdicts for the differential test in differential.test.mjs.

Reads {"posts": [text, ...], "known_slugs": [...], "known_questions": [...]} on stdin. Writes
one {"ok", "errors", "meta"} per post on stdout, from tools.post.load_post and
tools.validate.validate.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.post import PostError, load_post  # noqa: E402
from tools.validate import validate  # noqa: E402

FIELDS = ("title", "type", "author", "provenance", "summary", "cites", "questions",
          "state_report", "author_notes")


def _plain(value):
    """Strings, lists and mappings as they are; any other value tagged so it equals no string."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        # A key set to null reads as absent, in Python's checks and in the JavaScript reader.
        return {str(k): _plain(v) for k, v in value.items() if v is not None}
    return {"not a string": repr(value)}


def main() -> None:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    slugs, questions = set(request["known_slugs"]), set(request["known_questions"])
    verdicts = []
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "posts" / "2026" / "11" / "candidate.md"
        path.parent.mkdir(parents=True)
        for text in request["posts"]:
            path.write_bytes(text.encode("utf-8"))
            try:
                post = load_post(path)
            except PostError as e:
                verdicts.append({"ok": False, "errors": [e.message], "meta": None})
                continue
            errors = validate(post, slugs, questions)
            meta = {k: _plain(post.meta.get(k)) for k in FIELDS if post.meta.get(k) is not None}
            verdicts.append({"ok": not errors, "errors": errors, "meta": meta})
    sys.stdout.write(json.dumps(verdicts))


if __name__ == "__main__":
    main()
