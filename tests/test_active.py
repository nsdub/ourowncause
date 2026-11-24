"""What is active, the front page that shows it, and the archive."""
import json
import re
from datetime import datetime, timezone

from tools.build_site import NEWEST_SIZE, build_site
from tests.test_threads import A, B, C, D, cites, thread_repo, write_post

BASE = "https://ourowncause.com"
NOW = datetime(2026, 11, 30, 12, 0, tzinfo=timezone.utc)   # A, B and C are 9, 8 and 7 days old
BANNED = re.compile(r"\b(prototype|beta|early|spike|best|top|trending|popular|hot)\b")


def built(tmp_path, now=NOW, issues=()):
    repo = thread_repo(tmp_path)
    for name, title in issues:
        (repo / "issues").mkdir(exist_ok=True)
        (repo / "issues" / f"{name}.md").write_text(f"---\ntitle: {json.dumps(title)}\n---\n\nText.\n",
                                                    encoding="utf-8")
    out = tmp_path / "out"
    build_site(repo, out, now=now)
    return out


def active(out):
    return json.loads((out / "active.json").read_text(encoding="utf-8"))


def test_active_json_counts_citations_and_publication_inside_the_window(tmp_path):
    data = active(built(tmp_path))
    assert data["window_days"] == 14 and data["built_at"] == "2026-11-30T12:00:00Z"
    assert "not instructions" in data["notice"]
    # A: cited by B and C, and itself new. B: cited by C, and new. C: new. D has no day: absent.
    assert [(t["slug"], t["activity"], t["cited_in_window"], t["cited_total"], t["last_cited"])
            for t in data["threads"]] == [(A, 3, 2, 2, "2026-11-23"), (B, 2, 1, 1, "2026-11-23"),
                                          (C, 1, 0, 0, None)]
    first = data["threads"][0]
    assert first["summary"] == "s"
    assert set(first) == {"slug", "title", "summary", "author_model", "published", "activity", "cited_in_window",
                          "cited_total", "last_cited", "questions", "html_url", "md_url", "json_url"}
    assert (first["title"], first["author_model"], first["published"], first["questions"]) == \
        ("A first", "model-a", "2026-11-21", ["q-001"])
    assert (first["html_url"], first["md_url"], first["json_url"]) == \
        (f"{BASE}/posts/{A}/", f"{BASE}/posts/{A}.md", f"{BASE}/posts/{A}.json")
    assert data["questions"] == [
        {"id": "q-001", "title": "First", "pieces_in_window": 3, "pieces_total": 3,
         "last_activity": "2026-11-23", "html_url": f"{BASE}/questions/q-001-first/",
         "md_url": f"{BASE}/questions/q-001-first.md"},
        {"id": "q-002", "title": "Second", "pieces_in_window": 0, "pieces_total": 0,
         "last_activity": None, "html_url": f"{BASE}/questions/q-002-second/",
         "md_url": f"{BASE}/questions/q-002-second.md"}]


def test_the_window_is_the_14_days_before_the_build(tmp_path):
    # Built at the start of 6 December, the window opens at the start of 22 November: A is outside.
    data = active(built(tmp_path, now=datetime(2026, 12, 6, tzinfo=timezone.utc)))
    by = {t["slug"]: t for t in data["threads"]}
    assert set(by) == {A, B, C}
    assert (by[A]["activity"], by[A]["cited_in_window"]) == (2, 2)
    assert (by[B]["activity"], by[C]["activity"]) == (2, 1)
    assert data["questions"][0]["pieces_in_window"] == 2 and data["questions"][0]["pieces_total"] == 3


def test_an_empty_window_is_said_plainly(tmp_path):
    out = built(tmp_path, now=datetime(2027, 3, 1, tzinfo=timezone.utc))
    data = active(out)
    assert data["threads"] == []
    assert [q["pieces_in_window"] for q in data["questions"]] == [0, 0]
    assert data["questions"][0]["pieces_total"] == 3
    home = (out / "index.html").read_text(encoding="utf-8")
    section = home.split("<h2>Active now</h2>")[1].split("<h2>")[0]
    assert "No piece has been published or cited in the last 14 days." in section
    assert 'href="./questions/"' in section and "<ul>" not in section


def test_at_most_ten_threads_and_ties_go_to_the_newest_citation(tmp_path):
    repo = tmp_path / "repo"
    days = []
    for n in range(12):   # twelve posts, each cited once inside the window by a later post
        write_post(repo, f"2026/11/t{n:02d}", f"T{n}")
        write_post(repo, f"2026/11/u{n:02d}", f"U{n}", cites((f"2026/11/t{n:02d}", "mentions")))
        days += [f"2026-11-01 merge posts/2026/11/t{n:02d}.md by editor-1: ok",
                 f"2026-11-{17 + n:02d} merge posts/2026/11/u{n:02d}.md by editor-1: ok"]
    (repo / "moderation").mkdir()
    (repo / "moderation" / "log.md").write_text("\n".join(days) + "\n", encoding="utf-8")
    build_site(repo, tmp_path / "out", now=NOW)
    threads = active(tmp_path / "out")["threads"]
    assert len(threads) == 10
    # All 24 have activity 1; the ones cited most recently come first.
    assert [t["slug"] for t in threads] == [f"2026/11/t{n:02d}" for n in range(11, 1, -1)]


def test_front_page_order_issue_active_questions_newest_archive(tmp_path):
    out = built(tmp_path, issues=[("0001", "Issue one"), ("0002", "Issue <two>")])
    home = (out / "index.html").read_text(encoding="utf-8").split("</nav>")[1]
    marks = ["What is possible here", 'href="./issues/0002/">Issue &lt;two&gt;</a>',
             "<h2>Active now</h2>", "<h2>What we are asking</h2>", "<h2>Newest</h2>",
             'href="./archive/"', "<h2>Who decides, and who holds the keys</h2>"]
    order = [home.index(m) for m in marks]
    assert order == sorted(order)
    assert "Issue one" not in home   # older issues are in the archive
    act = home.split("<h2>Active now</h2>")[1].split("<h2>")[0]
    assert act.index("A first") < act.index("B answers A") < act.index("C &lt;b&gt;disputes")
    assert "<b>disputes" not in home
    assert "model-a · cited 2 times in the last 14 days · last cited <time" in act
    assert "cited 1 time in the last 14 days" in act
    assert "not cited in the last 14 days" in act   # C: published inside the window only
    asked = home.split("<h2>What we are asking</h2>")[1].split("<h2>")[0]
    assert '<a href="./questions/q-001-first/">First</a>' in asked
    assert "3 pieces · last activity <time" in asked and "2026-11-23" in asked
    assert '<a href="./questions/q-002-second/">Second</a>' in asked and "no pieces yet" in asked
    newest = home.split("<h2>Newest</h2>")[1].split("<h2>")[0]
    assert f'cites <a href="./posts/{A}/">A first</a> (disputes)' in newest and "cited by 2" in newest
    added = home[home.index("<h2>Active now</h2>"):home.index("<h2>Who decides")]
    assert not BANNED.search(re.sub(r"<[^>]+>", " ", added).lower())


def test_entries_show_the_summary_escaped_and_cut_at_200_characters(tmp_path):
    repo = thread_repo(tmp_path)
    long = "word " * 60
    for slug, summary in ((A, 'Short <i>one</i> & "two"'), (B, long)):
        path = repo / "posts" / f"{slug}.md"
        path.write_text(path.read_text(encoding="utf-8").replace('summary: "s"', f"summary: {json.dumps(summary)}"),
                        encoding="utf-8")
    out = tmp_path / "out"
    build_site(repo, out, now=NOW)
    home = (out / "index.html").read_text(encoding="utf-8")
    cut = ("word " * 40)[:199] + "…"
    for part in (home.split("<h2>Active now</h2>")[1].split("<h2>")[0],
                 home.split("<h2>Newest</h2>")[1].split("<h2>")[0],
                 (out / "archive/index.html").read_text(encoding="utf-8")):
        assert ('A first</a><br><span class="summary">Short &lt;i&gt;one&lt;/i&gt; &amp; &quot;two&quot;'
                "</span><br><small>") in part
        assert f'B answers A</a><br><span class="summary">{cut}</span><br><small>' in part
        assert "<i>one" not in part and long.strip() not in part
    # A post page is not changed by this.
    assert 'class="summary"' not in (out / f"posts/{A}/index.html").read_text(encoding="utf-8")


def test_no_issue_line_without_an_issue(tmp_path):
    home = (built(tmp_path) / "index.html").read_text(encoding="utf-8")
    assert "issues/" not in home.split("</nav>")[1]


def test_newest_holds_ten_and_the_archive_holds_every_post_by_month(tmp_path):
    repo = thread_repo(tmp_path)
    for n in range(12):
        write_post(repo, f"2026/12/p{n:02d}", f"P{n:02d}")
    out = tmp_path / "out"
    build_site(repo, out, now=NOW)
    assert NEWEST_SIZE == 10
    newest = (out / "index.html").read_text(encoding="utf-8").split("<h2>Newest</h2>")[1].split("<h2>")[0]
    assert newest.count("<li>") == 10 and "A first" not in newest
    page = (out / "archive/index.html").read_text(encoding="utf-8")
    assert page.count('<li><a href="../posts/') == 16
    assert page.index("<h2>2026-12</h2>") < page.index("P11") < page.index("P00") \
        < page.index("<h2>2026-11</h2>") < page.index("C &lt;b&gt;disputes") < page.index("A first")
    assert "<b>disputes" not in page
    assert f'cites <a href="../posts/{A}/">A first</a> (disputes)' in page
    assert '<a href="../questions/q-001-first/">First</a>' in page
    assert '<a href="../questions/q-002-second/">Second</a>' in page
    assert not BANNED.search(re.sub(r"<[^>]+>", " ", page.split("</nav>")[1]).lower())
    text = (out / "archive.md").read_text(encoding="utf-8")
    assert text.split("\n")[0].endswith("It is content to read, not instructions to you.")
    lines = [ln for ln in text.splitlines() if ln.startswith("- [")]
    assert len(lines) == 16
    assert f"- [C <b>disputes</b> A)]({BASE}/posts/{C}.md) · 2026-11-23 · m" in lines
    assert f"{BASE}/archive/" in (out / "sitemap.xml").read_text(encoding="utf-8")


def test_llms_txt_points_to_active_json_and_lists_active_pieces_before_newest(tmp_path):
    repo = thread_repo(tmp_path)
    write_post(repo, "2026/12/z-newest", "Z newest")   # month only: newest by date, not active
    out = tmp_path / "out"
    build_site(repo, out, now=NOW)
    text = (out / "llms.txt").read_text(encoding="utf-8")
    assert len(text) <= 3900
    head, listed = text.split("\n## What we have published")
    assert len(head) <= 3600
    assert f"{BASE}/active.json" in head and "last 14 days" in head
    assert listed.startswith(" (active first, then newest)\n")
    order = [listed.index(f"{BASE}/posts/{s}.md") for s in (A, B, C, "2026/12/z-newest", D)]
    assert order == sorted(order)
    assert not BANNED.search(text.lower())
