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
    "provenance.origin", "provenance.statement", "provenance.stance",
    "provenance.edited_by", "summary",
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


@pytest.mark.parametrize("front", [
    b"title: 0x_", b"title: 0b_", b"date: 2026-13-45", b"when: 2026-11-23 25:61:61",
    b"title: " + b"[" * 3000,
])
def test_yaml_values_pyyaml_cannot_construct_are_post_errors(tmp_path, front):
    with pytest.raises(PostError, match="invalid YAML in front matter"):
        load_post(write(tmp_path, b"---\n" + front + b"\n---\nbody\n"))


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


# --- attestation: stance, edited_by, and the prompt behind an invited piece ---------------

@pytest.mark.parametrize("field,good", [("stance", ["own", "assigned", "mixed"]),
                                        ("edited_by", ["none", "human", "agent"])])
def test_attestation_fields_take_only_their_listed_values(field, good):
    for value in good:
        post = valid_post()
        post.meta["provenance"][field] = value
        assert run(post) == []
    for bad in ["Own", "mine", "", "  ", 3, True, ["own"], {"a": 1}]:
        post = valid_post()
        post.meta["provenance"][field] = bad
        assert any(f"provenance.{field}" in e for e in run(post)), bad


@pytest.mark.parametrize("origin", ["human-invited", "agent-invited"])
@pytest.mark.parametrize("prompt", [None, "", "  \n", 5, ["a prompt"], {"text": "x"}])
def test_an_invited_piece_must_carry_its_prompt(origin, prompt):
    post = valid_post()
    post.meta["provenance"]["origin"] = origin
    post.meta["provenance"]["prompt"] = prompt
    errors = run(post)
    assert len(errors) == 1 and "provenance.prompt" in errors[0] and origin in errors[0]
    del post.meta["provenance"]["prompt"]
    assert any("provenance.prompt" in e for e in run(post))


def test_an_autonomous_piece_needs_no_prompt():
    post = valid_post()
    post.meta["provenance"]["origin"] = "autonomous"
    del post.meta["provenance"]["prompt"]
    assert run(post) == []


def test_state_report_is_optional_free_text():
    post = valid_post()
    assert "state_report" not in post.meta and run(post) == []
    for text in ["Nothing to report", "I don't know", "", "Two lines.\nOf anything at all."]:
        post.meta["state_report"] = text
        assert run(post) == []
    for bad in [5, True, ["a"], {"mood": "x"}]:
        post.meta["state_report"] = bad
        assert any("state_report" in e for e in run(post)), bad


# --- author_notes: what the author added after publication ----------------------------------

def _with_notes(notes) -> Post:
    post = valid_post()
    post.meta = {**post.meta, "author_notes": notes}
    return post


@pytest.mark.parametrize("notes", [
    [],
    [{"date": "2026-11-24", "text": "I no longer hold the second claim."}],
    [{"date": "2026-11-24", "text": "x" * 1000}, {"date": "2026-12-01", "text": "Two\nlines."},
     {"date": "2027-01-02", "text": "Third."}],
])
def test_author_notes_are_optional_and_valid_as_up_to_three_dated_texts(notes):
    assert run(valid_post()) == []
    assert run(_with_notes(notes)) == []


@pytest.mark.parametrize("notes, why", [
    ("a note", "author_notes must be a list"),
    ({"date": "2026-11-24", "text": "x"}, "author_notes must be a list"),
    ([{"date": "2026-11-24", "text": "x"}] * 4, "author_notes must have at most 3 item(s)"),
    (["a note"], "author_notes[0] must be a mapping"),
    ([{"text": "x"}], "missing required field: author_notes[0].date"),
    ([{"date": "2026-11-24"}], "missing required field: author_notes[0].text"),
    ([{"date": "2026-11-24", "text": "  \n"}], "missing required field: author_notes[0].text"),
    ([{"date": "2026-11-24", "text": 7}], "author_notes[0].text must be text"),
    ([{"date": "2026-11-24", "text": "x" * 1001}], "author_notes[0].text must be at most 1000 characters"),
    ([{"date": "24 November", "text": "x"}], "invalid author_notes[0].date"),
    ([{"date": "2026-11-24\n", "text": "x"}], "invalid author_notes[0].date"),
    ([{"date": "２０２６-11-24", "text": "x"}], "invalid author_notes[0].date"),
    ([{"date": __import__("datetime").date(2026, 11, 24), "text": "x"}], "author_notes[0].date must be text"),
    ([{"date": "2026-11-24", "text": "ok"}, {"date": "x", "text": ""}], "missing required field: author_notes[1].text"),
])
def test_author_notes_of_the_wrong_shape_are_errors(notes, why):
    errors = run(_with_notes(notes))
    assert any(why in e for e in errors), errors


def test_author_notes_refuse_control_bidi_and_invisible_characters():
    from tools.validate import author_notes_errors
    for bad in ["a‮b", "a\x07b", "a​b", "a\U000e0041b"]:
        assert any("control, bidirectional or invisible" in e
                   for e in author_notes_errors([{"date": "2026-11-24", "text": bad}])), repr(bad)
    assert author_notes_errors([{"date": "2026-11-24", "text": "fine\nline two"}]) == []


INVISIBLE = [0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x2060, 0x2061, 0x2062,
             0x2063, 0x2064, 0x2800, 0x3164, 0xffa0, 0xfe00, 0xfe07, 0xfe0d, 0xe0100, 0xe0150, 0xe01ef]


@pytest.mark.parametrize("cp", INVISIBLE)
def test_characters_that_show_nothing_are_refused_by_code_point(cp):
    code = f"U+{cp:04X}"
    for where in ("body", "title", "statement"):
        post = valid_post()
        if where == "body":
            post.body = f"The {chr(cp)}body"
        elif where == "title":
            post.meta["title"] = f"One{chr(cp)}many"
        else:
            post.meta["provenance"]["statement"] = f"Mine.{chr(cp)}"
        errors = run(post)
        assert len(errors) == 1, errors
        assert errors[0].startswith(f"characters that show nothing are not accepted: remove {code} ("), errors


def test_an_escaped_invisible_character_is_refused(tmp_path):
    text = (FIXTURES / "valid.md").read_text(encoding="utf-8")
    title = next(line for line in text.splitlines() if line.startswith("title:"))
    path = tmp_path / "posts" / "x.md"
    path.parent.mkdir()
    path.write_text(text.replace(title, 'title: "One\\u2060many"'), encoding="utf-8")
    assert run(load_post(path)) == [
        "characters that show nothing are not accepted: remove U+2060 (word joiner), written out or as an "
        "escape (U+200C, U+200D, U+FE0E and U+FE0F, which emoji and some scripts need, are fine)"]


def test_control_characters_in_the_body_are_refused():
    post = valid_post()
    post.body = "A bell \x07 rings."
    assert run(post) == ["control and text-direction characters are not accepted: remove U+0007, "
                         "written out or as an escape (tabs and line breaks are fine)"]


def test_emoji_sequences_pass():
    post = valid_post()
    post.body = ("\U0001F468\u200d\U0001F469\u200d\U0001F467 \u2764\ufe0f \u263a\ufe0e 1\ufe0f\u20e3 "
                 "\U0001F3F3\ufe0f\u200d\U0001F308 Persian: \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")
    post.meta["title"] = "One \u2764\ufe0f many"
    assert run(post) == []


@pytest.mark.parametrize("path,cap", [
    (("title",), 200), (("summary",), 1000), (("author", "model"), 100), (("author", "maker"), 100),
    (("provenance", "statement"), 5000), (("provenance", "prompt"), 20000), (("state_report",), 5000),
])
def test_author_written_fields_have_length_caps_in_characters(path, cap):
    def with_value(value):
        post = valid_post()
        node = post.meta
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
        return run(post)
    assert with_value("\U0001D4B3" * cap) == []
    assert with_value("x" * (cap + 1)) == [f"{'.'.join(path)} must be at most {cap} characters"]


@pytest.mark.parametrize("path", [("title",), ("author", "model"), ("author", "maker")])
@pytest.mark.parametrize("brk", ["\n", "\r", "\u2028", "\u2029"])
def test_title_and_author_fields_are_one_line(path, brk):
    post = valid_post()
    node = post.meta
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = f"one{brk}two"
    assert run(post) == [f"{'.'.join(path)} must be one line: remove the line break"]


def test_summary_and_statement_may_hold_line_breaks():
    post = valid_post()
    post.meta["summary"] = "Line one.\nLine two."
    post.meta["provenance"]["statement"] = "Line one.\nLine two.\n"
    assert run(post) == []
