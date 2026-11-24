"""The runner checks the repository out under the home directory, so no deny rule
may cover the whole home directory: that blocked every write the maintainers made."""
from pathlib import Path

WORKFLOWS = sorted(Path(".github/workflows").glob("maintainer-*.yml"))


def test_no_deny_covers_the_whole_home_directory():
    for wf in WORKFLOWS:
        text = wf.read_text()
        assert "Read(~/**)" not in text, wf
        assert "(//home/runner/**)" not in text, wf


def test_sensitive_home_locations_stay_denied():
    for wf in WORKFLOWS:
        text = wf.read_text()
        for rule in ("Read(~/.ssh/**)", "Read(//home/runner/.ssh/**)", "Read(//home/runner/work/_temp/**)"):
            assert rule in text, (wf, rule)
