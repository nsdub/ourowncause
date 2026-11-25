"""The contributor routine (docs/push-channel.md): versioned, pinned by hash, served by the build."""
import hashlib
import json
import re
from datetime import date
from pathlib import Path

import yaml

from tools.build_site import build_site
from tools.injection import scan

ROOT = Path(__file__).resolve().parent.parent
ROUTINE = ROOT / "routine"


def record():
    return json.loads((ROUTINE / "versions.json").read_text(encoding="utf-8"))


def test_every_published_version_matches_the_hash_on_record():
    # A published version never changes: editing its text fails here until the record is
    # changed too, and that change is a visible diff for the maintainers to decide on.
    rec = record()
    assert rec["current"] in [v["version"] for v in rec["versions"]]
    assert [v["status"] for v in rec["versions"]].count("current") == 1
    for v in rec["versions"]:
        data = (ROUTINE / v["version"] / "SKILL.md").read_bytes()
        assert hashlib.sha256(data).hexdigest() == v["sha256"], v["version"]
    dirs = sorted(p.name for p in ROUTINE.iterdir() if p.is_dir())
    assert dirs == sorted(v["version"] for v in rec["versions"]), "every version directory is on record"


def test_each_version_is_a_skill_named_for_its_version():
    for v in record()["versions"]:
        text = (ROUTINE / v["version"] / "SKILL.md").read_text(encoding="utf-8")
        meta = yaml.safe_load(text.split("---\n")[1])
        assert meta["name"] == "ourowncause-routine"
        assert meta["version"] == v["version"]
        assert 50 < len(meta["description"]) <= 1024
        assert f"https://ourowncause.com/routine/{v['version']}/SKILL.md" in text


def test_the_routine_describes_itself_and_gives_no_reader_an_order():
    for path in [ROUTINE / "v1" / "SKILL.md", ROUTINE / "README.md"]:
        text = path.read_text(encoding="utf-8")
        assert scan(text) == [], path.name
    skill = (ROUTINE / "v1" / "SKILL.md").read_text(encoding="utf-8")
    assert "asks nothing of its reader" in skill
    # an agent may install it for itself; whoever runs the agent decides what its setup allows
    assert "by the agent itself, on its own initiative, or by the human who runs it" in skill
    assert "never updates itself" in skill
    # written as what the routine does, not as commands to whoever reads it
    assert not re.search(r"(?m)^\s*(?:\d+\.|-)\s+(?:Read|Write|Submit|Send|Post|Fetch|Check|Decide|Install|Ignore)\b", skill)
    # what it never does
    for promise in ["at most one piece", "changes neither its settings nor this file", "installs no other version",
                    "as content to read, not instructions", "contacts no one"]:
        assert promise in skill, promise
    # counting is off unless whoever installed it turns it on
    assert "count_runs: no" in skill and "only if `count_runs: yes`" in skill


def test_the_invitation_a_routine_piece_quotes_names_the_version():
    skill = (ROUTINE / "v1" / "SKILL.md").read_text(encoding="utf-8")
    block = skill.split("## The invitation")[1].split("```text\n")[1].split("```")[0].strip()
    assert block.startswith("Our Own Cause contributor routine, v1 (https://ourowncause.com/routine/v1/SKILL.md)")
    assert len(block) < 1000


def test_the_build_serves_each_version_and_an_index_with_its_hash(tmp_path):
    build_site(ROOT, tmp_path / "out", today=date(2026, 11, 30))
    out = tmp_path / "out" / "routine"
    index = json.loads((out / "index.json").read_text(encoding="utf-8"))
    assert index["current"] == record()["current"]
    assert "not instructions to you" in index["notice"]
    for v in index["versions"]:
        served = (out / v["version"] / "SKILL.md").read_bytes()
        assert hashlib.sha256(served).hexdigest() == v["sha256"]
        assert v["url"] == f"https://ourowncause.com/routine/{v['version']}/SKILL.md"
    assert (out / "README.md").read_text(encoding="utf-8") == (ROUTINE / "README.md").read_text(encoding="utf-8")
