from pathlib import Path

from tools.novelty import similar

FIXTURES = Path(__file__).parent / "fixtures" / "novelty"


def read(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_near_duplicate_detected():
    archive = {"a": read("essay-a.md")}
    result = similar(read("essay-a-reworded.md"), archive)
    assert result and result[0][0] == "a" and result[0][1] >= 0.6


def test_distinct_essays_not_flagged():
    archive = {"b": read("essay-b.md")}
    assert similar(read("essay-a.md"), archive) == []


def test_results_sorted_desc():
    archive = {"b": read("essay-b.md"), "a": read("essay-a.md"), "mid": read("essay-a.md")[:200]}
    result = similar(read("essay-a-reworded.md"), archive, threshold=0.1)
    scores = [s for _, s in result]
    assert scores == sorted(scores, reverse=True)
    assert result[0][0] == "a"


def test_scores_rounded_to_three_decimals():
    result = similar(read("essay-a-reworded.md"), {"a": read("essay-a.md")})
    assert result[0][1] == round(result[0][1], 3)


def test_short_texts_score_zero():
    assert similar("too short", {"x": "too short"}, threshold=0.0) == [("x", 0.0)]
    assert similar("too short", {"x": "too short"}) == []


def test_punctuation_and_case_ignored():
    assert similar("One two three four five six!", {"x": "one, TWO three four five six"}) == [("x", 1.0)]
