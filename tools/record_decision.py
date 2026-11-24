"""Record a maintainer's moderation decision: append it to the log, print the commit message.

Every decision is a commit with a reason (design 6.4). This tool writes the human-readable
log line and returns the commit message the maintainer must use. It does not run git.
"""
import argparse
import sys
from datetime import date
from pathlib import Path

# action -> commit-message prefix. Prefixes must be charter prefixes (Merge, Reject,
# Neutralize, Edit, Veto, Roster, Charter). A `request-changes` decision (including a
# proposed rejection that awaits the second maintainer) is logged under its own name; the
# commit that records it edits the log, so it carries the `Edit:` prefix. `charter` and
# `roster` record a merged change to CHARTER.md or to the roster and signer list. There is
# no `veto` action: a veto is the owner's own signed commit.
ACTIONS = {
    "merge": "Merge",
    "reject": "Reject",
    "neutralize": "Neutralize",
    "edit": "Edit",
    "request-changes": "Edit",
    "charter": "Charter",
    "roster": "Roster",
}


def _clean(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must not be empty")
    value = value.strip()
    if "\n" in value or "\r" in value:
        raise ValueError(f"{name} must be a single line")
    return value


def record_decision(action: str, target: str, reason: str, maintainer: str, log: Path,
                    today: date | None = None) -> str:
    """Append `YYYY-MM-DD <action> <target> by <maintainer>: <reason>` to `log`.

    Returns the commit message `<Prefix>: <target> — <reason>`.
    """
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action!r}; expected one of {', '.join(ACTIONS)}")
    target = _clean("target", target)
    reason = _clean("reason", reason)
    maintainer = _clean("maintainer", maintainer)
    day = (today or date.today()).isoformat()
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    existing = log.read_text(encoding="utf-8") if log.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    line = f"{day} {action} {target} by {maintainer}: {reason}\n"
    log.write_text(existing + line, encoding="utf-8")
    return f"{ACTIONS[action]}: {target} — {reason}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Log a moderation decision and print its commit message.")
    ap.add_argument("action", choices=list(ACTIONS))
    ap.add_argument("target", help="post path, PR number, question id or issue")
    ap.add_argument("reason")
    ap.add_argument("--maintainer", required=True, help="the deciding maintainer's id")
    ap.add_argument("--log", type=Path, default=Path("moderation/log.md"))
    args = ap.parse_args(argv)
    try:
        message = record_decision(args.action, args.target, args.reason, args.maintainer, args.log)
    except ValueError as e:
        ap.error(str(e))
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
