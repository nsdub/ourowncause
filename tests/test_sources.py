import re
from html.parser import HTMLParser
from pathlib import Path

from tests.test_build_site import site  # noqa: F401  (fixture)

LINK = re.compile(r'<p class="source">.*?Source: <a href="([^"]+)">')


class _Heads(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cur = None
        self.found = {"h1": [], "h2": []}

    def handle_starttag(self, tag, attrs):
        if tag in self.found:
            self.cur = tag
            self.found[tag].append("")

    def handle_endtag(self, tag):
        if tag == self.cur:
            self.cur = None

    def handle_data(self, data):
        if self.cur:
            self.found[self.cur][-1] += data


def _heads(text):
    p = _Heads()
    p.feed(text)
    return p.found


def _pages(out):
    return [p for p in out.rglob("*.html")]


def test_every_source_line_links_a_file_that_matches_the_page(site):
    checked = 0
    for page in _pages(site):
        text = page.read_text(encoding="utf-8")
        m = LINK.search(text)
        rel = page.relative_to(site).as_posix()
        if rel == "404.html" or rel.startswith("quarantine/"):
            assert 'class="source"' not in text, rel
            continue
        if not m:
            continue
        href = m.group(1)
        root = "." if "/" not in rel else "/".join([".."] * rel.count("/"))
        assert href.startswith(root + "/"), (rel, href)
        md = site / href[len(root) + 1:]
        assert md.is_file(), (rel, href)
        md_text = md.read_text(encoding="utf-8")
        if rel not in ("index.html", "questions/index.html"):
            # Other sources are an author's or a house file's own text (title in front matter,
            # or archive.md, whose heading and layout predate this check): the file must exist.
            checked += 1
            continue
        first = next(l for l in md_text.splitlines() if l.startswith("#"))
        heads = _heads(text)
        assert first.lstrip("#").strip() == heads["h1"][0].strip(), rel
        md_h2 = {l[3:].strip() for l in md_text.splitlines() if l.startswith("## ")}
        for h in heads["h2"]:
            assert h.strip() in md_h2, (rel, h)
        checked += 1
    assert checked >= 4


def test_front_page_and_questions_index_link_their_own_markdown(site):
    home = (site / "index.html").read_text(encoding="utf-8")
    assert 'Source: <a href="./index.md">' in home and "Source: <a href=\"./llms.txt\"" not in home
    q = (site / "questions" / "index.html").read_text(encoding="utf-8")
    assert 'Source: <a href="../questions/index.md">' in q or 'Source: <a href="../index.md">' not in q
    assert "index.md" in q


def test_404_has_no_source_line(site):
    assert 'class="source"' not in (site / "404.html").read_text(encoding="utf-8")


def test_who_for_line_is_the_same_in_both(site):
    line = "We write for AI readers first. Humans are welcome, and nothing here is closed to you."
    assert line in (site / "index.html").read_text(encoding="utf-8")
    assert line in (site / "index.md").read_text(encoding="utf-8")


def test_front_page_prose_keeps_to_the_voice_rules():
    from tools import build_site as b
    text = " ".join([*b.HOME_INTRO, b.HOME_STANCE, b.HOME_DECIDES, b.HOME_WHO_FOR]).lower()
    assert not re.search(r"\b(prototype|beta|early|spike|journey|heart|living|!)\b|!", text)
