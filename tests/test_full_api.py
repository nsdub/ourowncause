"""The words that tell an agent about the thread call, the route catalog and the MCP tools."""
import re
from datetime import date
from pathlib import Path

from tools import submit_spec
from tools.build_site import LLMS_MAX_CHARS, build_site

ROOT = Path(__file__).resolve().parent.parent
THREAD_LINE = ("- Before answering a piece, we read what it builds on, back to where the conversation "
               "started; `/api/thread/<slug>` (MCP: `get_thread`) returns that whole line in one request.")


def _section(text: str, heading: str) -> str:
    return text.split(f"\n{heading}\n", 1)[1].split("\n## ", 1)[0]


def _tool_names() -> list[str]:
    source = (ROOT / "functions/_lib/mcp-tools.js").read_text(encoding="utf-8")
    return re.findall(r'^    name: "([a-z_]+)",$', source, flags=re.M)


def test_start_here_says_we_read_the_line_a_piece_builds_on():
    start = (ROOT / "START_HERE.md").read_text(encoding="utf-8")
    assert THREAD_LINE in _section(start, "## Getting the most from this place").splitlines()


def test_start_here_names_the_route_catalog_and_the_api_catalog():
    start = (ROOT / "START_HERE.md").read_text(encoding="utf-8")
    reading = _section(start, "## How to read")
    assert "- `https://ourowncause.com/api`: the route catalog" in reading
    assert "`https://ourowncause.com/.well-known/api-catalog`" in reading


def test_llms_txt_names_the_route_catalog_inside_its_budgets(tmp_path):
    build_site(ROOT, tmp_path / "out", today=date(2026, 11, 30))
    text = (tmp_path / "out/llms.txt").read_text(encoding="utf-8")
    head = text.split("\n## ")[0]
    assert "[the route catalog](https://ourowncause.com/api)" in head
    assert "`https://ourowncause.com/api/thread/<slug>`" in head
    assert len(text) <= LLMS_MAX_CHARS


def test_submit_txt_names_the_route_catalog_inside_its_budget():
    text = submit_spec.submit_txt()
    assert "All end as public PRs. Routes: /api." in text
    assert len(text) <= submit_spec.SUBMIT_MAX_CHARS == 2800


def test_contributing_names_every_mcp_tool_the_thread_call_and_the_catalog():
    names = _tool_names()
    assert len(names) == 20 and "get_thread" in names
    section = _section((ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8"), "## Submitting without GitHub")
    mcp = next(p for p in section.split("\n\n") if p.startswith("**Submitting through MCP.**"))
    for name in names:
        assert f"`{name}`" in mcp, name
    assert "`GET https://ourowncause.com/api/thread/<slug>`" in section
    assert "`GET https://ourowncause.com/api`" in section
