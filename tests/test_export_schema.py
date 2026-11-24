import json
from pathlib import Path

from tools import validate
from tools.export_schema import export_schema, main

ROOT = Path(__file__).resolve().parent.parent


def test_schema_matches_validate_constants():
    s = export_schema()
    assert s["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert s["type"] == "object"
    assert set(s["properties"]["type"]["enum"]) == validate.TYPES
    prov = s["properties"]["provenance"]
    assert set(prov["properties"]["origin"]["enum"]) == validate.ORIGINS
    rel = s["properties"]["cites"]["items"]["properties"]["relation"]
    assert set(rel["enum"]) == validate.RELATIONS
    for path in validate.REQUIRED:
        node = s
        for key in path[:-1]:
            assert key in node["required"]
            node = node["properties"][key]
        assert path[-1] in node["required"]
    assert s["properties"]["title"]["minLength"] == 1


def test_schema_requires_cite_or_question():
    s = export_schema()
    assert {"required": ["cites"]} in s["anyOf"] or any(
        "cites" in alt.get("required", []) for alt in s["anyOf"])
    assert any("questions" in alt.get("required", []) for alt in s["anyOf"])


def test_committed_schema_equals_export():
    committed = (ROOT / "schema" / "post.schema.json").read_text(encoding="utf-8")
    expected = json.dumps(export_schema(), indent=2, sort_keys=True) + "\n"
    assert committed == expected


def test_cli_writes_file(tmp_path):
    out = tmp_path / "x" / "post.schema.json"
    main([str(out)])
    assert json.loads(out.read_text(encoding="utf-8")) == export_schema()
