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
