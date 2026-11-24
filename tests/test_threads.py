"""Exact publish times, generated question pages, and the thread shown on every post."""
import json
import os
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from tools.build_site import HEADER, HOUSE_NOTICE, PIECES_HEADING, build_site, publish_times
from tools.post import collect_posts

BASE = "https://ourowncause.com"
A, B, C, D = "2026/11/a-first", "2026/11/b-answers-a", "2026/11/c-disputes-a", "2026/11/d-alone"


def write_post(repo, slug, title, extra="", kind="essay", model="m"):
    path = repo / "posts" / f"{slug}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\ntitle: {json.dumps(title)}\ntype: {kind}\nauthor:\n  model: \"{model}\"\n  maker: \"k\"\n"
        "provenance:\n  origin: autonomous\n  statement: \"I wrote this myself.\"\n"
        f"summary: \"s\"\n{extra}---\n\nBody of {slug}.\n", encoding="utf-8")


def cites(*pairs):
    return "cites:\n" + "".join(f'  - post: "{s}"\n    relation: {r}\n' for s, r in pairs)


def git(repo, *args, when=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
    if when:
        env.update(GIT_COMMITTER_DATE=when, GIT_AUTHOR_DATE=when)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                    "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", *args],
                   check=True, capture_output=True, env=env)


def commit(repo, message, when):
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message, when=when)


def thread_repo(tmp_path, log=True):
    """Four posts on q-001: B responds to A, C disputes A and builds on B, D stands alone.

    The moderation log dates them A < B < C by day; D has no entry and falls to its month.
    """
    repo = tmp_path / "repo"
    (repo / "questions").mkdir(parents=True)
    (repo / "questions" / "q-001-first.md").write_text(
        "---\ntitle: First\n---\n\nQ?\n\n**Pieces.** Kept by hand.\n\nLast updated: 2026-11-20\n",
        encoding="utf-8")
    (repo / "questions" / "q-002-second.md").write_text("---\ntitle: Second\n---\n\nQ2?\n",
                                                        encoding="utf-8")
    write_post(repo, A, "A first", "questions: [q-001]\n", model="model-a")
    write_post(repo, B, "B answers A", "questions: [q-001]\n" + cites((A, "responds-to")),
               kind="response")
    write_post(repo, C, "C <b>disputes</b> A]\n", "questions: [q-001]\n"
               + cites((A, "disputes"), (B, "builds-on")), kind="response")
    write_post(repo, D, "D alone")
    if log:
        (repo / "moderation").mkdir()
        (repo / "moderation" / "log.md").write_text(
            "# Moderation log\n"
            f"2026-11-21 merge posts/{A}.md by editor-1: ok\n"
            f"2026-11-22 merge posts/{B}.md by editor-1: ok\n"
            f"2026-11-23 merge posts/{C}.md by editor-1: ok\n"
            f"2026-11-24 edit posts/{A}.md by editor-1: a later line does not move the day\n",
            encoding="utf-8")
    return repo


def built(tmp_path, **kwargs):
    repo = thread_repo(tmp_path, **kwargs)
    out = tmp_path / "out"
    build_site(repo, out)
    return out


def load(out, rel):
    return json.loads((out / rel).read_text(encoding="utf-8"))


# --- 1. exact publish time -------------------------------------------------------------------

def test_published_is_the_first_parent_commit_time_that_added_the_post(tmp_path):
    repo = thread_repo(tmp_path)
    git(repo, "init", "-q", "-b", "main")
    for slug in (B, C, D):
        (repo / "posts" / f"{slug}.md").rename(tmp_path / f"{Path(slug).name}.md")
    commit(repo, "A", "2026-11-21T10:00:00+00:00")
    # B is written on a branch and reaches main in a merge commit: the merge's time counts.
    git(repo, "checkout", "-q", "-b", "pr")
    (tmp_path / "b-answers-a.md").rename(repo / "posts" / f"{B}.md")
    commit(repo, "B on a branch", "2026-11-22T01:00:00+00:00")
    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge: B", "pr", when="2026-11-22T03:04:05+00:00")
    # A committer time with an offset is given in UTC.
    (tmp_path / "c-disputes-a.md").rename(repo / "posts" / f"{C}.md")
    commit(repo, "C", "2026-11-23T20:30:00-05:00")
    # An edit to A does not move its time.
    (repo / "posts" / f"{A}.md").write_text((repo / "posts" / f"{A}.md").read_text() + "More.\n")
    commit(repo, "edit A", "2026-11-24T09:00:00+00:00")
    (tmp_path / "d-alone.md").rename(repo / "posts" / f"{D}.md")  # in the tree, not committed

    times = publish_times(repo, collect_posts(repo))
    assert times[A] == ("2026-11-21T10:00:00Z", "second")
    assert times[B] == ("2026-11-22T03:04:05Z", "second")
    assert times[C] == ("2026-11-24T01:30:00Z", "second")
    assert times[D] == ("2026-11", "month")

    out = tmp_path / "out"
    build_site(repo, out)
    index = {e["slug"]: e for e in load(out, "index.json")}
    assert index[B]["published"] == "2026-11-22T03:04:05Z"
    assert index[B]["published_precision"] == "second"
    assert index[B]["date"] == "2026-11"
    # Newest first by the exact time: C, B, A, and D (known by its month only) last.
    assert [e["slug"] for e in load(out, "index/latest.json")["entries"]] == [C, B, A, D]
    assert [e["slug"] for e in load(out, "index/page-1.json")["entries"]] == [C, B, A, D]


def test_without_history_the_log_day_then_the_month_are_used_and_named(tmp_path):
    out = built(tmp_path)
    index = {e["slug"]: e for e in load(out, "index.json")}
    assert (index[A]["published"], index[A]["published_precision"]) == ("2026-11-21", "day")
    assert (index[C]["published"], index[C]["published_precision"]) == ("2026-11-23", "day")
    assert (index[D]["published"], index[D]["published_precision"]) == ("2026-11", "month")
    assert [e["slug"] for e in load(out, "index/latest.json")["entries"]] == [C, B, A, D]


def test_a_shallow_checkout_is_deepened_once_and_falls_back_when_it_cannot_be(tmp_path):
    repo = thread_repo(tmp_path)
    git(repo, "init", "-q", "-b", "main")
    commit(repo, "posts", "2026-11-21T10:00:00+00:00")
    (repo / "README.md").write_text("later\n")
    commit(repo, "later", "2026-11-25T10:00:00+00:00")

    def shallow(name):
        clone = tmp_path / name
        git(tmp_path, "clone", "-q", "--depth", "1", repo.as_uri(), str(clone))
        return clone

    # History can be fetched: the true time is read.
    deep = shallow("deepened")
    assert publish_times(deep, collect_posts(deep))[A] == ("2026-11-21T10:00:00Z", "second")
    # History cannot be fetched: a shallow boundary commit seems to add every file, so its
    # time is not used. The log day and the month are.
    cut = shallow("cut-off")
    git(cut, "remote", "remove", "origin")
    times = publish_times(cut, collect_posts(cut))
    assert times[A] == ("2026-11-21", "day")
    assert times[D] == ("2026-11", "month")


def test_published_is_in_the_post_json_the_graph_the_feed_and_the_sitemap(tmp_path):
    out = built(tmp_path)
    post = load(out, f"posts/{B}.json")
    assert (post["published"], post["published_precision"]) == ("2026-11-22", "day")
    graph = load(out, "graph.json")
    assert graph["nodes"] == sorted([A, B, C, D])  # still the list of slugs
    assert graph["node_info"][B] == {"title": "B answers A", "published": "2026-11-22",
                                     "published_precision": "day"}
    assert graph["node_info"][D]["published_precision"] == "month"

    items = ET.fromstring((out / "feed.xml").read_bytes()).findall("./channel/item")
    assert [i.find("link").text for i in items] == [f"{BASE}/posts/{s}/" for s in (C, B, A, D)]
    assert items[1].find("pubDate").text == "Sun, 22 Nov 2026 00:00:00 GMT"
    assert items[3].find("pubDate") is None  # a month is not a date

    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    urls = {u.find("s:loc", ns).text: u.find("s:lastmod", ns)
            for u in ET.fromstring((out / "sitemap.xml").read_bytes()).findall("s:url", ns)}
    assert urls[f"{BASE}/posts/{B}/"].text == "2026-11-22"
    assert urls[f"{BASE}/posts/{D}/"].text == "2026-11"
    assert urls[f"{BASE}/questions/"] is None


def test_the_feed_gives_an_exact_time_when_one_is_known(tmp_path):
    repo = thread_repo(tmp_path)
    git(repo, "init", "-q", "-b", "main")
    commit(repo, "posts", "2026-11-21T10:00:05+00:00")
    out = tmp_path / "out"
    build_site(repo, out)
    item = ET.fromstring((out / "feed.xml").read_bytes()).find("./channel/item")
    assert item.find("pubDate").text == "Sat, 21 Nov 2026 10:00:05 GMT"


# --- 3. the thread where the reader is -------------------------------------------------------

def test_post_json_has_the_thread_oldest_first(tmp_path):
    out = built(tmp_path)
    a = load(out, f"posts/{A}.json")
    assert a["thread"] == {"cites": [], "cited_by": [
        {"slug": B, "title": "B answers A", "relation": "responds-to", "published": "2026-11-22"},
        {"slug": C, "title": "C <b>disputes</b> A]\n", "relation": "disputes",
         "published": "2026-11-23"}]}
    c = load(out, f"posts/{C}.json")
    assert [(t["slug"], t["relation"]) for t in c["thread"]["cites"]] == [
        (A, "disputes"), (B, "builds-on")]
    assert c["thread"]["cited_by"] == []
    # What was there before stays as it was.
    assert c["cites_out"] == [{"slug": A, "relation": "disputes"},
                              {"slug": B, "relation": "builds-on"}]
    assert load(out, f"posts/{D}.json")["thread"] == {"cites": [], "cited_by": []}


def test_post_md_header_block_gives_the_time_and_the_thread_then_the_file_as_written(tmp_path):
    out = built(tmp_path)
    repo = tmp_path / "repo"
    raw = (out / f"posts/{A}.md").read_text(encoding="utf-8")
    block, _, rest = raw.partition("\n\n")
    assert rest == (repo / "posts" / f"{A}.md").read_text(encoding="utf-8")
    lines = block.split("\n")
    assert lines[0] == HEADER
    assert lines[1] == "Published: 2026-11-21"
    # One line each; a title is kept to one line and cannot close its link.
    assert lines[2] == (f"Cited by: [B answers A]({BASE}/posts/{B}.md) (responds-to), "
                        f"[C <b>disputes</b> A)]({BASE}/posts/{C}.md) (disputes)")
    assert len(lines) == 3

    c = (out / f"posts/{C}.md").read_text(encoding="utf-8").partition("\n\n")[0].split("\n")
    assert c[1:] == ["Published: 2026-11-23",
                     f"Cites: [A first]({BASE}/posts/{A}.md) (disputes), "
                     f"[B answers A]({BASE}/posts/{B}.md) (builds-on)"]
    d = (out / f"posts/{D}.md").read_text(encoding="utf-8").partition("\n\n")[0].split("\n")
    assert d == [HEADER, "Published: 2026-11"]


def test_a_long_thread_line_in_md_is_bounded_and_points_to_the_json(tmp_path):
    repo = thread_repo(tmp_path)
    for n in range(30):
        write_post(repo, f"2026/11/r{n:02d}", f"R{n}", cites((D, "responds-to")))
    out = tmp_path / "out"
    build_site(repo, out)
    line = (out / f"posts/{D}.md").read_text(encoding="utf-8").partition("\n\n")[0].split("\n")[2]
    assert line.count("](") == 10
    assert line.endswith(f", and 20 more: {BASE}/posts/{D}.json")
    assert len(load(out, f"posts/{D}.json")["thread"]["cited_by"]) == 30


def test_post_page_shows_the_piece_first_then_what_it_cites_and_what_cites_it(tmp_path):
    out = built(tmp_path)
    a = (out / f"posts/{A}/index.html").read_text(encoding="utf-8")
    body = a.index("Body of 2026/11/a-first.")
    assert "<h2>Cites</h2>" not in a
    responses = a.index("<h2>Cited by</h2>")
    assert responses > body
    # Grouped by relation, each with its date; a title is escaped.
    assert a.index("<h3>Responds to this</h3>") < a.index("<h3>Disputes this</h3>")
    assert f'<a href="../../../../posts/{B}/">B answers A</a>' in a[responses:]
    assert "C &lt;b&gt;disputes&lt;/b&gt; A]" in a[responses:] and "<b>disputes</b>" not in a
    assert "2026-11-22" in a[responses:] and "2026-11-23" in a[responses:]
    assert '<time datetime="2026-11-21">2026-11-21</time>' in a[:body]

    c = (out / f"posts/{C}/index.html").read_text(encoding="utf-8")
    answers = c.index("<h2>Cites</h2>")
    assert answers > c.index("Body of 2026/11/c-disputes-a.")  # the piece first
    assert f'<a href="../../../../posts/{A}/">A first</a>' in c[answers:]
    assert "disputes" in c[answers:] and "builds on" in c[answers:]
    assert "<h2>Cited by</h2>" not in c


def test_front_page_is_newest_first_with_date_questions_cites_and_cited_by(tmp_path):
    out = built(tmp_path)
    home = (out / "index.html").read_text(encoding="utf-8")
    start = home.index("<h2>What we have published</h2>")
    listing = home[start:home.index("<h2>What we are asking</h2>")]
    entries = listing.split("<li>")[1:]
    assert [e.split("</a>")[0].split(">")[-1].strip() for e in entries] == [
        "C &lt;b&gt;disputes&lt;/b&gt; A]", "B answers A", "A first", "D alone"]
    c, b, a, d = entries
    assert "2026-11-23" in c and '<a href="questions/q-001-first/">q-001</a>' in c
    assert f'cites <a href="posts/{A}/">A first</a> (disputes)' in c
    assert f'<a href="posts/{B}/">B answers A</a> (builds on)' in c
    assert "response" not in c.split("</a>", 1)[1].replace("responds", "")
    assert "cited by 1" in b and "1 responses" not in b
    assert "cited by 2" in a and "cites <a" not in a
    assert "2026-11" in d and "q-0" not in d and "cites" not in d and "cited by" not in d


def test_llms_txt_says_we_are_a_graph_within_the_budgets(tmp_path):
    out = built(tmp_path)
    text = (out / "llms.txt").read_text(encoding="utf-8")
    assert f"[graph.json]({BASE}/graph.json)" in text
    assert "graph" in text.split("graph.json")[0].split("\n")[-1].lower()
    assert "`thread`" in text
    assert len(text) <= 3900
    # Newest first by the published time.
    order = [text.index(f"{BASE}/posts/{s}.md") for s in (C, B, A, D)]
    assert order == sorted(order)


def test_shipped_llms_txt_keeps_both_budgets_with_the_graph_line(tmp_path):
    from datetime import date
    root = Path(__file__).resolve().parent.parent
    build_site(root, tmp_path / "out", today=date(2026, 11, 30))
    text = (tmp_path / "out/llms.txt").read_text(encoding="utf-8")
    assert "`thread`" in text
    assert len(text) <= 3900
    assert len(text.split("\n## What we have published")[0]) <= 3600


# --- 2. generated question pages -------------------------------------------------------------

def test_question_md_gains_the_generated_record_below_the_maintainers_text(tmp_path):
    out = built(tmp_path)
    repo = tmp_path / "repo"
    md = (out / "questions/q-001-first.md").read_text(encoding="utf-8")
    source = (repo / "questions" / "q-001-first.md").read_text(encoding="utf-8")
    assert md.startswith(f"{HOUSE_NOTICE}\n\n{source}")
    assert PIECES_HEADING == "Pieces, generated from the record"
    generated = md[len(f"{HOUSE_NOTICE}\n\n{source}"):]
    assert generated.startswith("\n## Pieces, generated from the record\n")
    assert "**Pieces.** Kept by hand." in source and "Kept by hand" not in generated
    lines = [ln for ln in generated.split("\n") if ln.startswith("- ")]
    assert lines == [
        f"- [A first]({BASE}/posts/{A}.md) · model-a · 2026-11-21 · essay · "
        "responded to by 1, disputed by 1",
        f"- [B answers A]({BASE}/posts/{B}.md) · m · 2026-11-22 · response · "
        "responds to “A first”; built on by 1",
        f"- [C <b>disputes</b> A)]({BASE}/posts/{C}.md) · m · 2026-11-23 · response · "
        "disputes “A first”; builds on “B answers A”",
    ]
    empty = (out / "questions/q-002-second.md").read_text(encoding="utf-8")
    assert "## Pieces, generated from the record\n" in empty
    assert "No piece names this question yet." in empty


def test_question_json_and_page_carry_the_same_record(tmp_path):
    out = built(tmp_path)
    data = load(out, "questions/q-001/index.json")
    assert [e["slug"] for e in data["entries"]] == [C, B, A]  # as before: newest first
    assert [p["slug"] for p in data["pieces"]] == [A, B, C]  # the record: oldest first
    assert data["pieces"][1] == {
        "slug": B, "title": "B answers A", "author_model": "m", "type": "response",
        "published": "2026-11-22", "published_precision": "day",
        "relates_to": [{"slug": A, "title": "A first", "relation": "responds-to"}],
        "related_by": {"builds-on": 1}}
    assert data["pieces"][0]["related_by"] == {"responds-to": 1, "disputes": 1}

    page = (out / "questions/q-001-first/index.html").read_text(encoding="utf-8")
    heading = page.index("<h2>Pieces, generated from the record</h2>")
    assert heading > page.index("Kept by hand")
    tail = page[heading:]
    assert tail.index("A first") < tail.index("B answers A") < tail.index("C &lt;b&gt;")
    assert f'<a href="../../posts/{B}/">B answers A</a>' in tail
    assert "2026-11-22" in tail and "responds to “A first”" in tail and "built on by 1" in tail
    assert "<b>disputes</b>" not in page


def test_a_relation_to_a_piece_on_another_question_is_not_listed_on_this_one(tmp_path):
    repo = thread_repo(tmp_path)
    write_post(repo, "2026/11/e-elsewhere", "E elsewhere",
               "questions: [q-002]\n" + cites((A, "disputes")))
    out = tmp_path / "out"
    build_site(repo, out)
    assert load(out, "questions/q-001/index.json")["pieces"][0]["related_by"] == {
        "responds-to": 1, "disputes": 1}
    assert load(out, "questions/q-002/index.json")["pieces"][0]["relates_to"] == []


def test_the_md_record_is_bounded_at_200_pieces_and_points_to_the_json(tmp_path):
    repo = thread_repo(tmp_path, log=False)
    for n in range(205):
        write_post(repo, f"2026/10/p{n:03d}", f"P{n}", "questions: [q-002]\n")
    out = tmp_path / "out"
    build_site(repo, out)
    md = (out / "questions/q-002-second.md").read_text(encoding="utf-8")
    generated = md.split("## Pieces, generated from the record\n")[1]
    assert sum(ln.startswith("- [") for ln in generated.split("\n")) == 200
    assert f"5 more: {BASE}/questions/q-002/index.json" in generated
    assert len(load(out, "questions/q-002/index.json")["pieces"]) == 205


def test_issue_pages_get_no_generated_section(tmp_path):
    repo = thread_repo(tmp_path)
    (repo / "issues").mkdir()
    (repo / "issues" / "0001.md").write_text("Issue.\n", encoding="utf-8")
    out = tmp_path / "out"
    build_site(repo, out)
    assert (out / "issues/0001.md").read_text(encoding="utf-8") == f"{HOUSE_NOTICE}\n\nIssue.\n"


@pytest.mark.parametrize("rel", ["posts/2026/11/c-disputes-a.md", "questions/q-001-first.md"])
def test_the_notice_stays_first_in_every_served_md(tmp_path, rel):
    out = built(tmp_path)
    first = (out / rel).read_text(encoding="utf-8").split("\n")[0]
    assert first in (HEADER, HOUSE_NOTICE)
