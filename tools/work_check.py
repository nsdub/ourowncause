"""Work check: should a scheduled maintainer run start Claude at all?

Usage: python -P -m tools.work_check review|questions|issue --workflow <file>.yml

A maintainer run costs a Claude session on the account behind CLAUDE_CODE_OAUTH_TOKEN,
and a session that finds nothing to do still counts against its usage limit. This check
runs first, without Claude, and writes `go=true` or `go=false` to $GITHUB_OUTPUT.

- Started by hand (workflow_dispatch): always go, unless the input trigger is `timer`;
  the timer's dispatches are judged like a schedule.
- More than 24 runs of the workflow started Claude in the last 24 hours: no go, whatever
  started it, except a dispatch with trigger `owner`, which always goes.
- No earlier successful run of the same workflow: go.
- review: go when any pull request or issue was updated since the last successful run
  started.
- questions, issue: go when a commit touched posts/ since the last successful run started.

If GitHub or git cannot be asked, the answer is go: a wasted session costs less than work
that waits.
"""
import argparse
import json
import os
from datetime import datetime, timedelta, timezone
import subprocess
import sys

KINDS = ("review", "questions", "issue")
DAILY_CAP = 24          # runs that started Claude in the last 24 hours, per workflow
CLAUDE_RUN_MINUTES = 2  # a run that skipped Claude finishes well inside this


def claude_runs_in_last_day(runs: list, now: datetime) -> int:
    """How many of these runs started Claude in the 24 hours before now. A run that skipped
    Claude ends within seconds of starting, so a run that lasted at least two minutes counts."""
    count = 0
    for r in runs:
        try:
            start = datetime.fromisoformat(str(r["createdAt"]).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(r["updatedAt"]).replace("Z", "+00:00"))
        except (KeyError, ValueError, TypeError):
            continue
        if now - start <= timedelta(days=1) and end - start >= timedelta(minutes=CLAUDE_RUN_MINUTES):
            count += 1
    return count


def effective_event(event: str, trigger: str | None) -> str:
    """A dispatch from the timer (input trigger=timer) is judged like a schedule: it runs
    only when something changed. Any other dispatch is someone asking, and always goes."""
    if event == "workflow_dispatch" and trigger == "timer":
        return "schedule"
    if event == "workflow_dispatch" and trigger == "owner":
        return "owner"
    return event


def decide(kind: str, event: str, last_success: str | None,
           changed_items: int, post_commits: int, over_cap: bool = False) -> tuple[bool, str]:
    """The decision alone, from facts gathered elsewhere. Returns (go, reason)."""
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r}; use one of {', '.join(KINDS)}")
    if event == "owner":
        return True, "started by the owner with trigger=owner"
    if over_cap:
        return False, (f"{DAILY_CAP} runs of this workflow started Claude in the last 24 hours; "
                       "the next waits until that count drops (trigger=owner overrides)")
    if event == "workflow_dispatch":
        return True, "started by hand"
    if last_success is None:
        return True, "no earlier successful run of this workflow"
    if kind == "review":
        if changed_items:
            return True, f"{changed_items} pull requests or issues changed since {last_success}"
        return False, f"nothing changed since {last_success}"
    if post_commits:
        return True, f"{post_commits} commits touched posts/ since {last_success}"
    return False, f"no post changed since {last_success}"


def _run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60).stdout


def _last_success(workflow: str) -> str | None:
    rows = json.loads(_run(["gh", "run", "list", "--workflow", workflow, "--status", "success",
                            "--limit", "1", "--json", "createdAt"]))
    return rows[0]["createdAt"] if rows else None


def _over_cap(workflow: str) -> bool:
    rows = json.loads(_run(["gh", "run", "list", "--workflow", workflow, "--status", "completed",
                            "--limit", "100", "--json", "createdAt,updatedAt"]))
    return claude_runs_in_last_day(rows, datetime.now(timezone.utc)) >= DAILY_CAP


def _changed_items(since: str) -> int:
    total = 0
    for what in ("pr", "issue"):
        rows = json.loads(_run(["gh", what, "list", "--state", "open", "--limit", "100",
                                "--search", f"updated:>={since}", "--json", "number"]))
        total += len(rows)
    return total


def _post_commits(since: str) -> int:
    out = _run(["git", "log", "origin/main", f"--since={since}", "--format=%H", "--", "posts/"])
    return len(out.split())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("kind", choices=KINDS)
    parser.add_argument("--workflow", required=True)
    args = parser.parse_args(argv)
    event = effective_event(os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("TRIGGER"))
    try:
        since = None if event in ("workflow_dispatch", "owner") else _last_success(args.workflow)
        changed = _changed_items(since) if since and args.kind == "review" else 0
        posts = _post_commits(since) if since and args.kind != "review" else 0
        over_cap = event != "owner" and _over_cap(args.workflow)
        go, reason = decide(args.kind, event, since, changed, posts, over_cap=over_cap)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, IndexError) as e:
        go, reason = True, f"could not check ({type(e).__name__}), so running"
    line = f"go={'true' if go else 'false'}"
    print(f"{line}: {reason}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
