"""Repository configuration the launch depends on: merge attributes, pins, workflow inputs."""
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
MAINTAINER_WORKFLOWS = {
    "maintainer-review.yml": ["editor-1", "steward-1"],
    "maintainer-questions.yml": ["steward-1"],
    "maintainer-issue.yml": ["editor-1"],
}


def git(repo, *args):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
    return subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True,
                          text=True).stdout


def load(name):
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text())


def triggers(workflow):
    return workflow.get("on", workflow.get(True))  # YAML 1.1 reads the key `on` as true


# --- moderation/log.md merges by union -----------------------------------------------------

def test_log_appends_on_two_branches_merge_without_conflict(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.name", "T")
    git(tmp_path, "config", "user.email", "t@example.com")
    (tmp_path / ".gitattributes").write_text((ROOT / ".gitattributes").read_text())
    log = tmp_path / "moderation" / "log.md"
    log.parent.mkdir()
    log.write_text("# Moderation log\n\nintro\n")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "--no-gpg-sign", "-m", "base")
    git(tmp_path, "checkout", "-q", "-b", "verifier/abc1234")
    log.write_text(log.read_text() + "2026-11-23 aaaa unsigned none\n")
    git(tmp_path, "commit", "-q", "--no-gpg-sign", "-am", "Edit: verifier line")
    git(tmp_path, "checkout", "-q", "main")
    log.write_text(log.read_text() + "2026-11-24 merge posts/x.md by editor-1: adds a case\n")
    git(tmp_path, "commit", "-q", "--no-gpg-sign", "-am", "Merge: decision line")
    git(tmp_path, "merge", "--no-ff", "--no-gpg-sign", "-m", "Merge: log PR", "verifier/abc1234")
    lines = log.read_text().splitlines()
    assert "2026-11-23 aaaa unsigned none" in lines
    assert "2026-11-24 merge posts/x.md by editor-1: adds a case" in lines
    assert not any(l.startswith(("<<<<<<<", "=======", ">>>>>>>")) for l in lines)
    assert log.read_text().startswith("# Moderation log\n\nintro\n")


# --- small launch settings ---------------------------------------------------------------------

def test_generated_is_ignored_and_python_is_pinned_for_the_host():
    assert "generated/" in (ROOT / ".gitignore").read_text().splitlines()
    assert (ROOT / ".python-version").read_text() == "3.12\n"


def test_requirements_are_pinned_to_exact_versions():
    lines = [l for l in (ROOT / "requirements.txt").read_text().splitlines() if l.strip()]
    assert len(lines) == 2
    names = set()
    for line in lines:
        m = re.fullmatch(r"(pyyaml|markdown)==\d+(\.\d+)+", line)
        assert m, line
        names.add(m.group(1))
    assert names == {"pyyaml", "markdown"}


# --- workflows -----------------------------------------------------------------------------

def run_blocks(workflow):
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            if "run" in step:
                yield step


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_no_expression_is_interpolated_into_a_run_script(path):
    for step in run_blocks(yaml.safe_load(path.read_text())):
        assert "${{" not in step["run"], f"{path.name}: {step.get('name')}"


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_run_scripts_are_valid_bash(path, tmp_path):
    for n, step in enumerate(run_blocks(yaml.safe_load(path.read_text()))):
        script = tmp_path / f"{n}.sh"
        script.write_text(step["run"])
        proc = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        assert proc.returncode == 0, f"{path.name}: {step.get('name')}: {proc.stderr}"


@pytest.mark.parametrize("name", MAINTAINER_WORKFLOWS)
def test_dispatch_takes_an_optional_task(name):
    task = triggers(load(name))["workflow_dispatch"]["inputs"]["task"]
    assert task["type"] == "string" and not task.get("required", False)


def instruction_and_agent_steps(job):
    load_step = next(s for s in job["steps"] if s.get("id") == "instructions")
    agent = next(s for s in job["steps"] if "claude-code-action" in s.get("uses", ""))
    return load_step, agent


def build_prompt(name, job_id, tmp_path, task=None):
    job = load(name)["jobs"][job_id]
    load_step, _ = instruction_and_agent_steps(job)
    out = tmp_path / f"out-{job_id}-{task is not None}"
    env = {**os.environ, "MAINTAINER_ID": job["env"]["MAINTAINER_ID"], "RUNNER_TEMP": str(tmp_path),
           "GITHUB_OUTPUT": str(out), "GITHUB_RUN_ID": "123456", "GITHUB_RUN_ATTEMPT": "2", "DEFAULT_TASK": load_step["env"]["DEFAULT_TASK"],
           "TASK_INPUT": task or ""}
    script = tmp_path / "load.sh"
    script.write_text(load_step["run"])
    subprocess.run(["bash", str(script)], cwd=ROOT, env=env, check=True, capture_output=True)
    return out.read_text()


@pytest.mark.parametrize("name,job_id", [(n, j) for n, js in MAINTAINER_WORKFLOWS.items() for j in js])
def test_task_input_reaches_the_prompt_only_through_env_and_a_file(name, job_id, tmp_path):
    job = load(name)["jobs"][job_id]
    load_step, agent = instruction_and_agent_steps(job)
    assert load_step["env"]["TASK_INPUT"] == "${{ inputs.task }}"
    assert "inputs." not in agent["with"]["prompt"]
    assert agent["with"]["prompt"].strip() == "${{ steps.instructions.outputs.prompt }}"
    whole = (ROOT / ".github" / "workflows" / name).read_text()
    assert whole.count("inputs.task") == len(MAINTAINER_WORKFLOWS[name])  # only in step env

    default = build_prompt(name, job_id, tmp_path)
    assert f"# {job_id}: instructions" in default
    assert default.count("Task for this run: ") == 1
    run_line = re.search(r"^Run: 123456 attempt 2, started \d{4}-\d\d-\d\dT\d\d:\d\dZ$", default, re.M)
    assert run_line and default.index("# " + job_id) < run_line.start() < default.index("Task for this run: ")
    assert f"Task for this run: {load_step['env']['DEFAULT_TASK']}" in default

    hostile = 'founding run $(echo pwned) `id` "${{ secrets.X }}"'
    given = build_prompt(name, job_id, tmp_path, task=hostile)
    assert f"Task for this run: {load_step['env']['DEFAULT_TASK']}" in given
    assert given.count("Task for this run: ") == 2
    assert f"Task for this run: {hostile}\n" in given  # verbatim: nothing was evaluated
    first, last = given.splitlines()[0], given.splitlines()[-1]
    assert first == f"prompt<<{last}" and last.startswith("INSTRUCTIONS_")


def allowed(job):
    _, agent = instruction_and_agent_steps(job)
    return re.search(r'--allowedTools "([^"]*)"', agent["with"]["claude_args"]).group(1).split(",")


@pytest.mark.parametrize("name,job_id", [(n, j) for n, js in MAINTAINER_WORKFLOWS.items() for j in js])
def test_each_maintainer_may_push_only_main_and_its_own_branches(name, job_id):
    tools = allowed(load(name)["jobs"][job_id])
    pushes = sorted(t for t in tools if t.startswith("Bash(git push"))
    assert pushes == sorted(["Bash(git push origin main:*)", f"Bash(git push origin {job_id}/*:*)"])


@pytest.mark.parametrize("name,job_id", [(n, j) for n, js in MAINTAINER_WORKFLOWS.items() for j in js])
def test_only_the_steward_may_run_the_quarantine_tool(name, job_id):
    tools = allowed(load(name)["jobs"][job_id])
    assert ("Bash(python -P -m tools.quarantine:*)" in tools) == (job_id == "steward-1")


# --- workflow hardening ------------------------------------------------------------------------

_USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)(.*)$")
_PINNED = re.compile(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}")


def test_every_action_is_pinned_to_a_full_commit_sha_with_its_version_noted():
    """A tag can be moved to other code; a commit SHA cannot."""
    seen = 0
    for path in WORKFLOWS:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            m = _USES.match(line)
            if not m:
                continue
            seen += 1
            where = f"{path.name}:{number}: {line.strip()}"
            assert _PINNED.fullmatch(m.group(1)), where
            assert re.fullmatch(r"\s+# v\d+\.\d+\.\d+", m.group(2)), where
    assert seen >= 15


def test_every_workflow_declares_top_level_permissions_and_none_grants_everything():
    assert WORKFLOWS
    for path in WORKFLOWS:
        permissions = yaml.safe_load(path.read_text()).get("permissions")
        assert isinstance(permissions, dict), f"{path.name}: no top-level permissions block"
        assert set(permissions.values()) <= {"read", "write", "none"}, path.name


def test_maintainer_review_allows_only_the_github_actions_bot():
    """The gateway dispatches maintainer-review with GITHUB_TOKEN (actor: github-actions).
    claude-code-action refuses bot actors unless listed; '*' would admit any App."""
    text = (ROOT / ".github" / "workflows" / "maintainer-review.yml").read_text()
    lines = [l.strip() for l in text.splitlines() if l.strip().startswith("allowed_bots:")]
    assert lines == ["allowed_bots: github-actions"] * 2


def test_every_python_dash_p_step_sets_pythonpath():
    """`python -P -m tools.x` cannot import tools without PYTHONPATH; a step that forgets it
    fails at once (the work job did, on 2026-11-24, and stopped every maintainer run)."""
    for path in WORKFLOWS:
        wf = yaml.safe_load(path.read_text())
        for job in wf["jobs"].values():
            for step in job.get("steps", []):
                if "python -P -m tools." in str(step.get("run", "")):
                    assert step.get("env", {}).get("PYTHONPATH") == "${{ github.workspace }}", (path.name, step.get("name"))



def _needs_third_party(module, seen=None):
    """Whether tools.<module> imports yaml or markdown, directly or through another tool."""
    import ast
    seen = set() if seen is None else seen
    if module in seen:
        return False
    seen.add(module)
    tree = ast.parse((ROOT / "tools" / f"{module}.py").read_text())
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module] + [f"{node.module}.{a.name}" for a in node.names]
        for name in names:
            top = name.split(".")[0]
            if top in ("yaml", "markdown"):
                return True
            if top == "tools" and "." in name:
                sub = name.split(".")[1]
                if (ROOT / "tools" / f"{sub}.py").exists() and _needs_third_party(sub, seen):
                    return True
    return False


def test_every_job_that_runs_our_tools_installs_their_dependencies_first():
    """The ask-for-review job ran `tools.gateway`, which imports yaml, with no install step.
    It failed on every pull request from #25 until this test, so nothing was reviewed on
    arrival; only the timer reached new pull requests."""
    import re
    for path in WORKFLOWS:
        wf = yaml.safe_load(path.read_text())
        for job_id, job in wf["jobs"].items():
            installed = False
            for step in job.get("steps", []):
                run = str(step.get("run", ""))
                if "pip install" in run and "pyyaml" in run and "markdown" in run:
                    installed = True
                for module in re.findall(r"python -P -m tools\.([a-z_]+)", run):
                    if _needs_third_party(module):
                        assert installed, (path.name, job_id, step.get("name"), module)
