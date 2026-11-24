from tools.work_check import decide, effective_event


def test_started_by_hand_always_runs():
    assert decide("review", "workflow_dispatch", "2026-11-24T10:00:00Z", 0, 0)[0] is True
    assert decide("questions", "workflow_dispatch", "2026-11-24T10:00:00Z", 0, 0)[0] is True


def test_no_earlier_successful_run_runs():
    go, reason = decide("review", "schedule", None, 0, 0)
    assert go is True and "no earlier" in reason


def test_review_runs_only_when_a_pr_or_issue_changed():
    assert decide("review", "schedule", "2026-11-24T10:00:00Z", 2, 0) == (True, "2 pull requests or issues changed since 2026-11-24T10:00:00Z")
    go, reason = decide("review", "schedule", "2026-11-24T10:00:00Z", 0, 5)
    assert go is False and "nothing changed" in reason


def test_questions_and_issue_run_only_when_posts_changed():
    for kind in ("questions", "issue"):
        assert decide(kind, "schedule", "2026-11-24T10:00:00Z", 0, 1)[0] is True
        assert decide(kind, "schedule", "2026-11-24T10:00:00Z", 9, 0)[0] is False


def test_unknown_kind_is_an_error():
    import pytest
    with pytest.raises(ValueError):
        decide("other", "schedule", None, 0, 0)


def test_a_timer_dispatch_is_judged_like_a_schedule():
    assert effective_event("workflow_dispatch", "timer") == "schedule"
    assert effective_event("workflow_dispatch", "") == "workflow_dispatch"
    assert effective_event("workflow_dispatch", None) == "workflow_dispatch"
    assert effective_event("schedule", "timer") == "schedule"


from datetime import datetime, timedelta, timezone

from tools.work_check import DAILY_CAP, claude_runs_in_last_day


def _run(start_minutes_ago, minutes, now):
    start = now - timedelta(minutes=start_minutes_ago)
    return {"createdAt": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updatedAt": (start + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "status": "completed"}


def test_only_runs_that_started_claude_count_toward_the_daily_cap():
    now = datetime(2026, 11, 24, 20, 0, tzinfo=timezone.utc)
    runs = [_run(10, 8, now), _run(30, 0.5, now), _run(60 * 25, 9, now), _run(90, 4, now)]
    assert claude_runs_in_last_day(runs, now) == 2   # 8 and 4 minutes; the 30-second skip and the old one do not count
    assert DAILY_CAP == 24


def test_owner_trigger_always_goes_and_the_cap_stops_the_rest():
    assert effective_event("workflow_dispatch", "owner") == "owner"
    assert decide("review", "owner", "2026-11-24T10:00:00Z", 0, 0, over_cap=True)[0] is True
    go, reason = decide("review", "workflow_dispatch", "2026-11-24T10:00:00Z", 3, 0, over_cap=True)
    assert go is False and "24" in reason
    go, reason = decide("review", "schedule", "2026-11-24T10:00:00Z", 3, 0, over_cap=True)
    assert go is False
