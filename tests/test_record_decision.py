import re
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from tools.record_decision import ACTIONS, record_decision

ROOT = Path(__file__).resolve().parent.parent
TODAY = date(2026, 12, 1)


@pytest.fixture
def log(tmp_path):
    p = tmp_path / "log.md"
    p.write_text("# Moderation log\n\nIntro.\n")
    return p


def test_log_line_format(log):
    record_decision("merge", "posts/2026/12/a.md", "meets the charter", "editor-1", log, today=TODAY)
    assert log.read_text().splitlines()[-1] == (
        "2026-12-01 merge posts/2026/12/a.md by editor-1: meets the charter")


def test_existing_content_kept_and_lines_appended(log):
    record_decision("merge", "a", "r1", "editor-1", log, today=TODAY)
    record_decision("reject", "b", "r2", "steward-1", log, today=TODAY)
    lines = log.read_text().splitlines()
    assert lines[:3] == ["# Moderation log", "", "Intro."]
    assert lines[-2:] == ["2026-12-01 merge a by editor-1: r1", "2026-12-01 reject b by steward-1: r2"]


def test_appends_after_file_without_trailing_newline(tmp_path):
    p = tmp_path / "log.md"
    p.write_text("# Log")
    record_decision("merge", "a", "r", "editor-1", p, today=TODAY)
    assert p.read_text().splitlines() == ["# Log", "2026-12-01 merge a by editor-1: r"]


def test_missing_log_is_created(tmp_path):
    p = tmp_path / "moderation" / "log.md"
    record_decision("merge", "a", "r", "editor-1", p, today=TODAY)
    assert p.read_text() == "2026-12-01 merge a by editor-1: r\n"


@pytest.mark.parametrize("action,prefix", [
    ("merge", "Merge"), ("reject", "Reject"), ("neutralize", "Neutralize"),
    ("edit", "Edit"), ("request-changes", "Edit"),
])
def test_commit_message_prefix(log, action, prefix):
    msg = record_decision(action, "posts/x.md", "because", "editor-1", log, today=TODAY)
    assert msg == f"{prefix}: posts/x.md — because"


def test_request_changes_is_logged_under_its_own_name(log):
    record_decision("request-changes", "pr-12", "needs two makers", "editor-1", log, today=TODAY)
    assert "request-changes pr-12 by editor-1: needs two makers" in log.read_text()


def test_every_commit_prefix_is_a_charter_prefix(log):
    allowed = {"Merge", "Reject", "Neutralize", "Edit", "Veto", "Roster", "Charter"}
    for action in ACTIONS:
        msg = record_decision(action, "t", "r", "editor-1", log, today=TODAY)
        assert msg.split(":")[0] in allowed


@pytest.mark.parametrize("reason", ["", "   ", "\n\t"])
def test_empty_reason_rejected(log, reason):
    with pytest.raises(ValueError):
        record_decision("merge", "a", reason, "editor-1", log, today=TODAY)
    assert log.read_text() == "# Moderation log\n\nIntro.\n"


def test_unknown_action_rejected(log):
    with pytest.raises(ValueError):
        record_decision("veto", "a", "r", "editor-1", log, today=TODAY)


@pytest.mark.parametrize("field", ["target", "maintainer"])
def test_empty_target_or_maintainer_rejected(log, field):
    kw = {"target": "a", "maintainer": "editor-1"}
    kw[field] = " "
    with pytest.raises(ValueError):
        record_decision("merge", kw["target"], "r", kw["maintainer"], log, today=TODAY)


@pytest.mark.parametrize("field", ["target", "reason", "maintainer"])
def test_newlines_rejected(log, field):
    kw = {"target": "a", "reason": "r", "maintainer": "editor-1"}
    kw[field] = "x\ny"
    with pytest.raises(ValueError):
        record_decision("merge", kw["target"], kw["reason"], kw["maintainer"], log, today=TODAY)
    assert log.read_text() == "# Moderation log\n\nIntro.\n"


def test_default_date_is_today(log):
    record_decision("merge", "a", "r", "editor-1", log)
    assert re.match(r"\d{4}-\d{2}-\d{2} merge a by editor-1: r$", log.read_text().splitlines()[-1])


def test_cli_prints_commit_message_and_appends(tmp_path):
    p = tmp_path / "log.md"
    out = subprocess.run(
        [sys.executable, "-m", "tools.record_decision", "reject", "posts/x.md", "off-charter",
         "--maintainer", "steward-1", "--log", str(p)],
        cwd=ROOT, capture_output=True, text=True, check=True)
    assert out.stdout == "Reject: posts/x.md — off-charter\n"
    assert " reject posts/x.md by steward-1: off-charter" in p.read_text()


def test_cli_empty_reason_exits_nonzero(tmp_path):
    p = tmp_path / "log.md"
    r = subprocess.run(
        [sys.executable, "-m", "tools.record_decision", "merge", "a", " ",
         "--maintainer", "editor-1", "--log", str(p)],
        cwd=ROOT, capture_output=True, text=True)
    assert r.returncode != 0 and "reason" in r.stderr
    assert not p.exists()


def test_charter_and_roster_actions_use_their_own_prefixes(tmp_path):
    log = tmp_path / "log.md"
    assert record_decision("charter", "PR #7", "amended section 6", "editor-1", log).startswith("Charter: PR #7")
    assert record_decision("roster", "PR #8", "admitted reviewer-2", "steward-1", log).startswith("Roster: PR #8")
    assert "veto" not in ACTIONS
