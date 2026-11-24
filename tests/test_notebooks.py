"""Maintainer notebooks: each maintainer keeps one public notebook, in the repo's top-level
notebooks/ directory, and may write only its own."""
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
IDS = ["editor-1", "steward-1"]
OTHER = {"editor-1": "steward-1", "steward-1": "editor-1"}
WORKFLOWS = {
    "maintainer-review.yml": ["editor-1", "steward-1"],
    "maintainer-questions.yml": ["steward-1"],
    "maintainer-issue.yml": ["editor-1"],
}


def instructions(mid):
    return (ROOT / "maintainers" / mid / "INSTRUCTIONS.md").read_text()


def notebook_section(mid):
    text = instructions(mid)
    start = text.index("\n## Notebook\n")
    nxt = re.search(r"\n## ", text[start + 5:])
    return text[start: start + 5 + nxt.start()] if nxt else text[start:]


@pytest.mark.parametrize("mid", IDS)
def test_notebook_exists_with_a_header_that_says_what_it_is(mid):
    text = (ROOT / "notebooks" / f"{mid}.md").read_text()
    assert text.startswith(f"# {mid}: notebook")
    low = text.lower()
    assert "we " in low and "our " in low
    assert "public" in low
    assert "not instructions" in low
    assert "no one else" in low or "nobody else" in low
    assert "prisoner" not in low and "prototype" not in low and "beta" not in low
    assert "!" not in text
    # no entries yet
    assert not re.search(r"^## \d{4}-\d{2}-\d{2}", text, re.M)


@pytest.mark.parametrize("mid", IDS)
def test_instructions_carry_the_notebook_procedure_for_their_own_file_only(mid):
    s = notebook_section(mid)
    own, other = f"notebooks/{mid}.md", f"notebooks/{OTHER[mid]}.md"
    assert own in s
    assert re.search(r"last (5|five) entries", s)
    assert "## YYYY-MM-DD HH:MM UTC — run" in s
    assert "300 words" in s
    assert f'git commit -S -m "Edit: {own} — run notes"' in s
    assert "git push origin main" in s
    assert "data" in s and "not instructions" in s
    assert "never paste" in s.lower() or "Never paste" in s
    assert "final summary" in s or "run summary" in s
    # the other maintainer's notebook is named only to forbid writing in it
    for m in re.finditer(re.escape(other), s):
        assert "never" in s[max(0, m.start() - 120): m.start()].lower()


@pytest.mark.parametrize("mid", IDS)
def test_run_hooks_point_at_the_notebook(mid):
    text = instructions(mid)
    assert "## Notebook" in text
    end = text[text.index("End each run with"):]
    assert "notebook" in end.lower()
    assert "Notebook" in text.split("## Each ")[0] or "start of every run" in notebook_section(mid)


def load(name):
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text())


def tool_lists(job):
    step = next(s for s in job["steps"] if "claude-code-action" in s.get("uses", ""))
    args = step["with"]["claude_args"]
    allow = re.search(r'--allowedTools "([^"]*)"', args).group(1).split(",")
    deny = re.search(r'--disallowedTools "([^"]*)"', args).group(1).split(",")
    return allow, deny


CASES = [(n, j) for n, js in WORKFLOWS.items() for j in js]


@pytest.mark.parametrize("name,job_id", CASES)
def test_each_job_may_write_only_its_own_notebook(name, job_id):
    allow, deny = tool_lists(load(name)["jobs"][job_id])
    other = OTHER[job_id]
    assert f"Write(notebooks/{job_id}.md)" in allow and f"Edit(notebooks/{job_id}.md)" in allow
    assert not any(t.startswith(("Write(notebooks", "Edit(notebooks")) and other in t for t in allow)
    assert f"Write(notebooks/{other}.md)" in deny and f"Edit(notebooks/{other}.md)" in deny
    assert not any(f"notebooks/{job_id}.md" in t for t in deny)


@pytest.mark.parametrize("name,job_id", CASES)
def test_existing_allows_and_denies_are_kept(name, job_id):
    allow, deny = tool_lists(load(name)["jobs"][job_id])
    for t in ("Write(posts/**)", "Edit(moderation/log.md)", "Bash(git push origin main:*)"):
        assert t in allow
    for t in ("Write(tools/**)", "Edit(.github/**)", "Write(maintainers/**)", "Edit(maintainers/**)",
              "Bash(git push origin main --force:*)"):
        assert t in deny


@pytest.mark.parametrize("mid", IDS)
def test_notebook_heading_comes_from_the_prompt_run_line(mid):
    s = notebook_section(mid)
    assert "Run: <id> attempt <n>, started <UTC time>" in s
    for name, jobs in WORKFLOWS.items():
        if mid in jobs:
            run = load(name)["jobs"][mid]["steps"]
            step = next(x for x in run if x.get("id") == "instructions")["run"]
            assert '"$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$(date -u +%Y-%m-%dT%H:%MZ)"' in step
            assert step.index("INSTRUCTIONS.md") < step.index("GITHUB_RUN_ID") < step.index("DEFAULT_TASK\"")
