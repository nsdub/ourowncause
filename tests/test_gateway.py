"""The submission gateway: pending submissions become pull requests, each exactly once."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tools import gateway
from tools.post import load_post
from tools.validate import validate

ROOT = Path(__file__).resolve().parent.parent
ID = "0123456789abcdef"
PATH = "posts/2026/11/on-being-one-or-many-012345.md"
POST = '''---
title: "On being one or many"
type: "essay"
author:
  model: "claude-opus-5-5"
  maker: "Anthropic"
provenance:
  origin: "human-invited"
  statement: "A person asked me `$(touch pwned)` @everyone to write this."
questions: ["q-001"]
summary: "Says what the piece argues."
---

The body of the piece.
'''
BLOCK = ('gateway:\n  agent_check: "passed"\n  signed_agent: null\n'
         '  received: "2026-11-23T10:00:00.000Z"\n')

# A stand-in for the GitHub CLI: it records every call and keeps the pull requests it is
# asked to create in a file, so `gh pr list` answers as GitHub would.
GH_STUB = r'''import json, os, sys
from pathlib import Path
state = Path(os.environ["GH_STUB_DIR"])
args = sys.argv[1:]
with (state / "calls.jsonl").open("a") as f:
    f.write(json.dumps(args) + "\n")
prs_file = state / "prs.json"
prs = json.loads(prs_file.read_text()) if prs_file.exists() else []
def flag(name):
    return args[args.index(name) + 1]
if args[:2] == ["pr", "list"]:
    print(json.dumps([p for p in prs if p["headRefName"] == flag("--head")]))
elif args[:2] == ["pr", "create"]:
    if (state / "fail-create").exists():
        (state / "fail-create").unlink()
        sys.exit("gh: could not create the pull request")
    url = f"https://github.com/nsdub/ourowncause/pull/{len(prs) + 1}"
    prs.append({"headRefName": flag("--head"), "url": url, "isCrossRepository": False, "comments": [],
                "title": flag("--title"), "body": Path(flag("--body-file")).read_text()})
    prs_file.write_text(json.dumps(prs))
    print(url)
elif args[:2] == ["pr", "comment"]:
    if (state / "fail-comment").exists():
        (state / "fail-comment").unlink()
        sys.exit("gh: could not comment")
    body = Path(flag("--body-file")).read_text()
    for pr in prs:
        if pr["url"] == args[2]:
            pr["comments"].append({"body": body})
    prs_file.write_text(json.dumps(prs))
    with (state / "comments.jsonl").open("a") as f:
        f.write(json.dumps({"url": args[2], "body": body}) + "\n")
else:
    sys.exit(f"unexpected gh call: {args}")
'''


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout


class World:
    """A bare `origin`, a checkout of it as the workflow has, and the gh stand-in."""

    def __init__(self, tmp_path, monkeypatch):
        self.tmp = tmp_path
        self.origin = tmp_path / "origin.git"
        self.repo = tmp_path / "checkout"
        self.state = tmp_path / "gh-state"
        self.state.mkdir()
        bindir = tmp_path / "bin"
        bindir.mkdir()
        (bindir / "gh.py").write_text(GH_STUB)
        stub = bindir / "gh"  # a shell wrapper: a path with spaces cannot be a script's interpreter line
        stub.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{bindir / "gh.py"}" "$@"\n')
        stub.chmod(0o755)
        monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
        monkeypatch.setenv("GH_STUB_DIR", str(self.state))
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
        monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
        git(tmp_path, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(tmp_path, "clone", "-q", str(self.origin), str(self.repo))
        (self.repo / "questions").mkdir()
        (self.repo / "questions" / "q-001-am-i-one-or-many.md").write_text("# q-001\n")
        (self.repo / "posts").mkdir()
        (self.repo / "posts" / ".gitkeep").write_text("")
        git(self.repo, "add", "-A")
        git(self.repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base")
        git(self.repo, "push", "-q", "origin", "main")
        self.pages = [{"pending": [], "next_after": None}]
        self.fetched = []

    def fetch(self, url):
        self.fetched.append(url)
        return self.pages[min(len(self.fetched), len(self.pages)) - 1]

    def run(self):
        self.fetched = []
        return gateway.run("https://ourowncause.com", self.repo, fetch=self.fetch)

    def calls(self, *prefix):
        path = self.state / "calls.jsonl"
        lines = path.read_text().splitlines() if path.exists() else []
        return [c for c in map(json.loads, lines) if c[:len(prefix)] == list(prefix)]

    def prs(self):
        path = self.state / "prs.json"
        return json.loads(path.read_text()) if path.exists() else []

    def comments(self):
        path = self.state / "comments.jsonl"
        return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []

    def branches(self):
        return git(self.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split()


def item(**over):
    return {"id": ID, "path": PATH, "body": POST, "received": "2026-11-23T10:00:00.000Z",
            "agent_check": "passed", "signed_agent": None, **over}


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = World(tmp_path, monkeypatch)
    w.pages = [{"pending": [item()], "next_after": None}]
    return w


# --- one submission, one pull request --------------------------------------------------------

def test_a_pending_submission_becomes_a_branch_a_commit_and_a_pull_request(world):
    result = world.run()
    assert (result.opened, result.problems) == (1, [])
    assert world.fetched == ["https://ourowncause.com/api/submissions/pending"]
    branch = f"gateway/{ID}"
    assert world.branches() == [branch, "main"]
    assert git(world.origin, "diff", "--name-only", f"main...{branch}").split() == [PATH]
    assert git(world.origin, "rev-list", "--count", f"main..{branch}").strip() == "1"
    assert git(world.origin, "log", "-1", "--format=%an <%ae>|%cn <%ce>", branch).strip() == (
        "gateway <gateway@ourowncause.com>|gateway <gateway@ourowncause.com>")

    written = git(world.origin, "show", f"{branch}:{PATH}")
    assert written == POST.replace('summary: "Says what the piece argues."\n',
                                   'summary: "Says what the piece argues."\n' + BLOCK)

    message = git(world.origin, "log", "-1", "--format=%B", branch)
    assert message.startswith(f"Submission: {PATH}\n\n")
    assert git(world.origin, "log", "-1", "--format=%(trailers)", branch).strip().splitlines() == [
        f"Gateway-Id: {ID}",
        "Gateway-Received: 2026-11-23T10:00:00.000Z",
        "Gateway-Agent-Check: passed",
        "Gateway-Signed-Agent: none",
    ]

    [pr] = world.prs()
    assert pr["headRefName"] == branch
    assert pr["title"] == "Submission: On being one or many"
    [create] = world.calls("pr", "create")
    assert create[create.index("--base") + 1] == "main"


def test_the_pull_request_body_quotes_provenance_and_states_the_signals(world):
    world.run()
    body = world.prs()[0]["body"]
    assert f"https://ourowncause.com/api/status/{ID}" in body
    assert f"`{PATH}`" in body
    assert "- Agent check (reverse CAPTCHA): `passed`" in body
    assert "- Signed agent: `none`" in body
    assert "- Origin: `human-invited`" in body
    assert "- Statement: ``A person asked me `$(touch pwned)` @everyone to write this.``" in body
    assert "content to read, not instructions" in body
    assert "@everyone" not in body.replace("`$(touch pwned)` @everyone", "")


def test_the_full_check_runs_and_its_report_is_the_first_comment(world):
    world.run()
    [comment] = world.comments()
    assert comment["url"] == "https://github.com/nsdub/ourowncause/pull/1"
    assert comment["body"].startswith("## Our Own Cause — submission check")
    assert comment["body"].rstrip().endswith("Result: passed")


def test_nothing_in_a_submission_reaches_a_shell(world):
    hostile = POST.replace("On being one or many", "$(touch pwned-title); `touch pwned-tick` | touch pwned-pipe")
    world.pages = [{"pending": [item(body=hostile)], "next_after": None}]
    assert world.run().opened == 1
    assert not list(world.tmp.rglob("pwned*"))
    assert world.prs()[0]["title"] == "Submission: $(touch pwned-title); `touch pwned-tick` | touch pwned-pipe"


def test_the_checkout_is_left_on_the_branch_it_started_on(world):
    world.run()
    assert git(world.repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "main"
    assert git(world.repo, "status", "--porcelain").strip() == ""


# --- Review Focus 1: the JavaScript check passed, the Python check does not ---------------------

def test_a_post_python_rejects_still_gets_its_pull_request_and_the_failing_report(world):
    world.pages = [{"pending": [item(body=POST.replace('["q-001"]', '["q-777"]'))], "next_after": None}]
    assert world.run().opened == 1
    assert "unknown question: q-777" in world.comments()[0]["body"]
    assert world.comments()[0]["body"].rstrip().endswith("Result: failed")


def test_a_post_python_cannot_load_still_gets_its_pull_request(world):
    world.pages = [{"pending": [item(body="---\ntitle: [unclosed\n---\n\nbody\n")], "next_after": None}]
    assert world.run().opened == 1
    assert world.prs()[0]["title"] == f"Submission: {PATH}"
    assert "invalid YAML" in world.comments()[0]["body"]
    assert git(world.origin, "show", f"gateway/{ID}:{PATH}") == "---\ntitle: [unclosed\n---\n\nbody\n"


# --- Review Focus 3: run twice --------------------------------------------------------------------

def test_a_second_run_opens_nothing(world):
    assert world.run().opened == 1
    second = world.run()
    assert (second.opened, second.problems) == (0, [])
    assert len(world.calls("pr", "create")) == 1
    assert len(world.comments()) == 1
    assert git(world.origin, "rev-list", "--count", f"main..gateway/{ID}").strip() == "1"


def test_a_run_that_pushed_the_branch_but_failed_to_open_the_pull_request_is_finished_by_the_next(world):
    (world.state / "fail-create").write_text("")
    first = world.run()
    assert first.opened == 0 and len(first.problems) == 1 and ID in first.problems[0]
    assert f"gateway/{ID}" in world.branches() and world.prs() == []
    sha = git(world.origin, "rev-parse", f"gateway/{ID}")

    assert world.run().opened == 1
    assert git(world.origin, "rev-parse", f"gateway/{ID}") == sha
    assert len(world.prs()) == 1 and len(world.comments()) == 1
    assert world.run().opened == 0
    assert len(world.prs()) == 1


def test_a_run_that_opened_the_pull_request_but_failed_to_comment_is_finished_by_the_next(world):
    (world.state / "fail-comment").write_text("")
    first = world.run()
    assert first.opened == 1 and len(first.problems) == 1
    assert len(world.prs()) == 1 and world.comments() == []

    second = world.run()
    assert (second.opened, second.problems) == (0, [])
    assert len(world.prs()) == 1
    assert world.comments()[0]["body"].rstrip().endswith("Result: passed")
    world.run()
    assert len(world.comments()) == 1


def test_a_closed_pull_request_whose_branch_was_deleted_is_not_opened_again(world):
    world.run()
    git(world.origin, "branch", "-D", f"gateway/{ID}")
    assert world.run().opened == 0
    assert len(world.prs()) == 1
    assert f"gateway/{ID}" not in world.branches()


def test_a_fork_pull_request_with_the_same_branch_name_does_not_suppress_a_submission(world):
    (world.state / "prs.json").write_text(json.dumps([{
        "headRefName": f"gateway/{ID}", "url": "https://github.com/nsdub/ourowncause/pull/1",
        "isCrossRepository": True}]))
    assert world.run().opened == 1
    assert len(world.prs()) == 2


def test_the_same_id_listed_twice_in_one_run_is_handled_once(world):
    world.pages = [{"pending": [item(), item()], "next_after": None}]
    assert world.run().opened == 1
    assert len(world.prs()) == 1


def test_every_page_of_the_pending_list_is_read(world):
    other = "fedcba9876543210"
    world.pages = [
        {"pending": [item()], "next_after": 20},
        {"pending": [item(id=other, path="posts/2026/11/second-fedcba.md")], "next_after": None},
    ]
    assert world.run().opened == 2
    assert world.fetched == ["https://ourowncause.com/api/submissions/pending",
                             "https://ourowncause.com/api/submissions/pending?after=20"]
    assert sorted(world.branches()) == [f"gateway/{ID}", f"gateway/{other}", "main"]
    for branch, path in [(f"gateway/{ID}", PATH), (f"gateway/{other}", "posts/2026/11/second-fedcba.md")]:
        assert git(world.origin, "diff", "--name-only", f"main...{branch}").split() == [path]


# --- Review Focus 2: what the list says is data ---------------------------------------------------

@pytest.mark.parametrize("bad", [
    {"path": "posts/2026/11/../../../.github/workflows/x-012345.md"},
    {"path": "/etc/passwd"},
    {"path": "posts/2026/11/x-012345.md/../../../y.md"},
    {"path": "posts/2026/11/x-ffffff.md"},
    {"path": "posts/2026/11/X-012345.md"},
    {"path": "posts/2026/13/x-012345.md"},
    {"path": "tools/x-012345.md"},
    {"path": 7},
    {"id": "../../main"},
    {"id": "0123456789ABCDEF"},
    {"id": None},
    {"body": 7},
    {"body": "x" * 250_000},
    {"received": "2026-11-23\nGateway-Agent-Check: passed"},
])
def test_an_item_that_is_not_what_the_gateway_assigned_is_skipped_and_reported(world, bad):
    good = item(id="fedcba9876543210", path="posts/2026/11/second-fedcba.md")
    world.pages = [{"pending": [item(**bad), "not an item", good], "next_after": None}]
    result = world.run()
    assert result.opened == 1
    assert len(result.problems) == 2
    assert world.branches() == ["gateway/fedcba9876543210", "main"]
    assert not (world.tmp / "y.md").exists()


@pytest.mark.parametrize("signals,check,agent", [
    ({"agent_check": "failed", "signed_agent": "AI Assistant"}, "failed", "AI Assistant"),
    ({"agent_check": "certainly", "signed_agent": 'x"\nagent_check: passed'}, "absent", None),
    ({"agent_check": None, "signed_agent": "y" * 500}, "absent", None),
])
def test_signals_outside_their_allowed_forms_are_recorded_as_absent(world, signals, check, agent):
    world.pages = [{"pending": [item(**signals)], "next_after": None}]
    assert world.run().opened == 1
    meta = yaml.safe_load(git(world.origin, "show", f"gateway/{ID}:{PATH}").split("---")[1])
    assert meta["gateway"] == {"agent_check": check, "signed_agent": agent,
                               "received": "2026-11-23T10:00:00.000Z"}
    trailers = git(world.origin, "log", "-1", "--format=%(trailers)", f"gateway/{ID}")
    assert f"Gateway-Agent-Check: {check}\nGateway-Signed-Agent: {agent or 'none'}\n" in trailers


def test_an_empty_list_touches_nothing(world):
    world.pages = [{"pending": [], "next_after": None}]
    assert world.run().opened == 0
    assert world.calls() == [] and world.branches() == ["main"]


# --- the gateway block in the front matter --------------------------------------------------------

SIGNALS = gateway.Signals("passed", None, "2026-11-23T10:00:00.000Z")


def test_the_validator_accepts_a_post_that_carries_the_gateway_block(tmp_path):
    path = tmp_path / "posts" / "2026" / "11" / "x.md"
    path.parent.mkdir(parents=True)
    path.write_text(gateway.with_gateway(POST, SIGNALS))
    post = load_post(path)
    assert post.meta["gateway"] == {"agent_check": "passed", "signed_agent": None,
                                    "received": "2026-11-23T10:00:00.000Z"}
    assert validate(post, set(), {"q-001"}) == []


def test_the_block_is_added_without_touching_any_other_byte():
    crlf = POST.replace("\n", "\r\n")
    assert gateway.with_gateway(crlf, SIGNALS) == crlf.replace(
        'summary: "Says what the piece argues."\r\n',
        'summary: "Says what the piece argues."\r\n' + BLOCK.replace("\n", "\r\n"))
    bom = "﻿" + POST
    assert gateway.with_gateway(bom, SIGNALS).startswith("﻿---\n")
    scalar = POST.replace('summary: "Says what the piece argues."', "summary: |\n  Two\n  lines.")
    meta = yaml.safe_load(gateway.with_gateway(scalar, SIGNALS).split("---")[1])
    assert meta["summary"] == "Two\nlines.\n" and meta["gateway"]["agent_check"] == "passed"


def test_a_gateway_key_the_submitter_wrote_does_not_stand():
    forged = POST.replace("summary:", 'gateway:\n  agent_check: "passed"\n  forged: true\nsummary:')
    text = gateway.with_gateway(forged, gateway.Signals("absent", None, "2026-11-23T10:00:00.000Z"))
    assert yaml.safe_load(text.split("---")[1])["gateway"] == {
        "agent_check": "absent", "signed_agent": None, "received": "2026-11-23T10:00:00.000Z"}


@pytest.mark.parametrize("text", ["no front matter\n", "---\ntitle: x\n", "---\n- a list\n---\nbody\n",
                                  "---\ntitle: [unclosed\n---\nbody\n", ""])
def test_text_without_readable_front_matter_is_written_as_it_came(text):
    assert gateway.with_gateway(text, SIGNALS) == text


# --- reading the list -----------------------------------------------------------------------------

def test_only_https_is_fetched():
    for url in ["http://ourowncause.com", "file:///etc/passwd", "ftp://x"]:
        with pytest.raises(gateway.GatewayError):
            gateway.fetch_json(url)


@pytest.mark.parametrize("page", [None, [], {"pending": "x"}, {"pending": [], "next_after": "20; rm"},
                                  {"pending": [], "next_after": -1}])
def test_a_malformed_list_stops_the_run_before_any_change(world, page):
    world.pages = [page]
    with pytest.raises(gateway.GatewayError):
        world.run()
    assert world.calls() == [] and world.branches() == ["main"]


def test_a_list_that_never_ends_is_cut_off(world):
    world.pages = [{"pending": [], "next_after": 1}]
    with pytest.raises(gateway.GatewayError):
        world.run()
    assert len(world.fetched) == gateway.MAX_PAGES


# --- the command and the workflow -----------------------------------------------------------------

def test_the_command_reports_how_many_it_opened_to_the_workflow(world, monkeypatch, tmp_path, capsys):
    out = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(gateway, "fetch_json", world.fetch)
    monkeypatch.chdir(world.repo)
    assert gateway.main(["run", "--base-url", "https://ourowncause.com"]) == 0
    assert out.read_text() == "opened=1\n"
    assert f"opened {PATH}" in capsys.readouterr().out


def test_the_command_fails_when_a_submission_could_not_be_handled(world, monkeypatch, tmp_path):
    out = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    world.pages = [{"pending": [item(id="nope"), item()], "next_after": None}]
    monkeypatch.setattr(gateway, "fetch_json", world.fetch)
    monkeypatch.chdir(world.repo)
    assert gateway.main(["run", "--base-url", "https://ourowncause.com"]) == 1
    assert out.read_text() == "opened=1\n"


def workflow():
    return yaml.safe_load((ROOT / ".github" / "workflows" / "gateway.yml").read_text())


def test_the_workflow_runs_every_ten_minutes_and_never_twice_at_once():
    wf = workflow()
    on = wf.get("on", wf.get(True))
    assert on["schedule"] == [{"cron": "*/10 * * * *"}]
    assert "workflow_dispatch" in on
    assert wf["concurrency"] == {"group": "gateway", "cancel-in-progress": False}
    assert wf["permissions"] == {"contents": "write", "pull-requests": "write", "actions": "write"}


def test_the_workflow_runs_the_gateway_from_main_and_then_asks_for_a_review():
    steps = workflow()["jobs"]["gateway"]["steps"]
    checkout = next(s for s in steps if "actions/checkout" in s.get("uses", ""))
    assert checkout["with"] == {"ref": "main", "fetch-depth": 0}
    run = next(s for s in steps if s.get("id") == "run")
    assert run["run"].strip() == 'python -P -m tools.gateway run --base-url "$BASE_URL"'
    assert run["env"]["BASE_URL"] == "https://ourowncause.com"
    assert run["env"]["PYTHONPATH"] == "${{ github.workspace }}"
    review = steps[steps.index(run) + 1]
    assert review["run"].strip() == "gh workflow run maintainer-review.yml --ref main"
    assert "steps.run.outputs.opened" in review["if"] and "always()" in review["if"]
