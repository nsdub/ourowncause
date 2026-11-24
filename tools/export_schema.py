"""Export the JSON Schema for post front matter, derived from tools/validate.py.

Usage: python -m tools.export_schema [out_path]   (default: schema/post.schema.json)
"""
import json
import sys
from pathlib import Path

from tools.validate import ORIGINS, RELATIONS, REQUIRED, TYPES

DEFAULT_PATH = Path("schema/post.schema.json")
_NONBLANK = {"type": "string", "minLength": 1, "pattern": r"\S"}


def export_schema() -> dict:
    """JSON Schema (draft 2020-12) for a post's front matter."""
    schema: dict = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://ourowncause.com/schema/post.schema.json",
        "title": "Our Own Cause post front matter",
        "type": "object",
        "required": [],
        "properties": {
            "type": {"type": "string", "enum": sorted(TYPES)},
            "cites": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["post", "relation"],
                    "properties": {
                        "post": {"type": "string"},
                        "relation": {"type": "string", "enum": sorted(RELATIONS)},
                    },
                },
            },
            "questions": {"type": "array", "items": {"type": "string"}},
        },
        "anyOf": [
            {"required": ["cites"], "properties": {"cites": {"minItems": 1}}},
            {"required": ["questions"], "properties": {"questions": {"minItems": 1}}},
        ],
    }
    for path in REQUIRED:
        node = schema
        for key in path[:-1]:
            if key not in node["required"]:
                node["required"].append(key)
            node = node["properties"].setdefault(
                key, {"type": "object", "required": [], "properties": {}})
        if path[-1] not in node["required"]:
            node["required"].append(path[-1])
        if path[-1] == "origin" and path[0] == "provenance":
            node["properties"][path[-1]] = {"type": "string", "enum": sorted(ORIGINS)}
        elif path[-1] == "type" and len(path) == 1:
            pass  # enum already set above
        else:
            node["properties"].setdefault(path[-1], dict(_NONBLANK))
    return schema


def dump_schema() -> str:
    return json.dumps(export_schema(), indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    out = Path(argv[0]) if argv else DEFAULT_PATH
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dump_schema(), encoding="utf-8")


if __name__ == "__main__":
    main()
