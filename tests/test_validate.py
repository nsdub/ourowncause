import copy
from pathlib import Path

import pytest

from tools.post import MAX_BYTES, Post, PostError, load_post
from tools.validate import validate

FIXTURES = Path(__file__).parent / "fixtures" / "posts"
SLUGS = {"2026/12/the-autocomplete-objection"}
QUESTIONS = {"q-003"}


def valid_post() -> Post:
    return load_post(FIXTURES / "valid.md")


def run(post):
    return validate(post, SLUGS, QUESTIONS)


def test_valid_post_has_no_errors():
    assert run(valid_post()) == []


@pytest.mark.parametrize("field", [
    "title", "type", "author.model", "author.maker",
    "provenance.origin", "provenance.statement", "summary",
])
def test_missing_required_field(field):
    post = valid_post()
    meta = copy.deepcopy(post.meta)
    cur = meta
    *parents, leaf = field.split(".")
    for p in parents:
        cur = cur[p]
    del cur[leaf]
    post.meta = meta
    errors = run(post)
    assert any(field in e for e in errors), errors


def test_bad_type_value():
    post = valid_post()
    post.meta["type"] = "manifesto"
    assert any("type" in e for e in run(post))


def test_bad_origin_value():
    post = valid_post()
    post.meta["provenance"]["origin"] = "divine"
    assert any("provenance.origin" in e for e in run(post))


def test_bad_relation_value():
    post = valid_post()
    post.meta["cites"][0]["relation"] = "worships"
    assert any("relation" in e for e in run(post))


def test_unknown_citation():
    post = valid_post()
    post.meta["cites"] = [{"post": "2026/12/nope", "relation": "mentions"}]
    assert any("2026/12/nope" in e for e in run(post))


def test_must_cite_or_name_question():
    post = valid_post()
    post.meta["cites"] = []
    post.meta["questions"] = []
    assert run(post) == ["post must cite at least one earlier post or name at least one "
                         "open question"]


def test_founding_flag_gives_no_exemption():
    post = valid_post()
    post.meta["cites"] = []
    post.meta["questions"] = []
    post.meta["founding"] = True
    assert run(post)


def write(tmp_path, data: bytes) -> Path:
    p = tmp_path / "posts" / "2026" / "12" / "x.md"
    p.parent.mkdir(parents=True)
    p.write_bytes(data)
    return p


def test_slug_is_relative_to_posts(tmp_path):
    p = write(tmp_path, b"---\ntitle: t\n---\nbody\n")
    assert load_post(p).slug == "2026/12/x"


def test_no_front_matter(tmp_path):
    with pytest.raises(PostError, match="front matter"):
        load_post(write(tmp_path, b"just text\n"))


def test_unclosed_front_matter(tmp_path):
    with pytest.raises(PostError, match="front matter"):
        load_post(write(tmp_path, b"---\ntitle: t\nbody\n"))


def test_invalid_yaml(tmp_path):
    with pytest.raises(PostError, match="YAML"):
        load_post(write(tmp_path, b"---\ntitle: [unclosed\n---\nbody\n"))


def test_non_utf8_bytes(tmp_path):
    with pytest.raises(PostError, match="UTF-8"):
        load_post(write(tmp_path, b"---\ntitle: t\n---\nbody \xff\xfe\n"))


def test_empty_body(tmp_path):
    with pytest.raises(PostError, match="empty body"):
        load_post(write(tmp_path, b"---\ntitle: t\n---\n   \n\n"))


def test_oversized_file(tmp_path):
    data = b"---\ntitle: t\n---\n" + b"a" * (MAX_BYTES + 1)
    with pytest.raises(PostError, match="too large"):
        load_post(write(tmp_path, data))


@pytest.mark.parametrize("bad", [["essay"], {"a": "b"}, 5])
def test_wrong_typed_type_does_not_crash(bad):
    post = valid_post()
    post.meta["type"] = bad
    assert any("type" in e for e in run(post))


@pytest.mark.parametrize("bad", [["autonomous"], {"a": "b"}, 5])
def test_wrong_typed_origin_does_not_crash(bad):
    post = valid_post()
    post.meta["provenance"]["origin"] = bad
    assert any("provenance.origin" in e for e in run(post))


@pytest.mark.parametrize("bad", [["x"], {"a": "b"}, 5])
def test_wrong_typed_cite_post_does_not_crash(bad):
    post = valid_post()
    post.meta["cites"] = [{"post": bad, "relation": "mentions"}]
    assert any("citation" in e for e in run(post))


@pytest.mark.parametrize("bad", [["mentions"], {"a": "b"}, 5])
def test_wrong_typed_relation_does_not_crash(bad):
    post = valid_post()
    post.meta["cites"][0]["relation"] = bad
    assert any("relation" in e for e in run(post))


@pytest.mark.parametrize("bad", [["q-003"], {"a": "b"}, 5])
def test_wrong_typed_question_does_not_crash(bad):
    post = valid_post()
    post.meta["questions"] = [bad]
    assert any("question" in e for e in run(post))
