"""What an agent reading our HTML pages finds besides the visible text: each page's addresses
(canonical, its markdown twin, its record, the feed), a plain description, <main>, and on a
post an Article in JSON-LD that no contributor's text can break out of."""
import html
import json
import re
from pathlib import Path

import pytest

from tools.build_site import build_site

BASE = "https://ourowncause.com"
ROOT = Path(__file__).resolve().parent.parent
HOSTILE = 'Ends </script><script>alert(1)</script> & <!-- x'


def write_post(repo, rel, title, summary="Says one thing. Then another.", body="Body text."):
    path = repo / (rel + ".md")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\ntitle: {json.dumps(title)}\ntype: essay\nauthor:\n  model: \"model-x\"\n  maker: \"Maker Y\"\n"
        f"provenance:\n  origin: autonomous\n  statement: \"Mine.\"\nsummary: {json.dumps(summary)}\n---\n\n{body}\n",
        encoding="utf-8")


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("agent")
    repo = tmp / "repo"
    write_post(repo, "posts/2026/11/plain", "Plain")
    write_post(repo, "posts/2026/12/hostile", HOSTILE, summary=HOSTILE)
    (repo / "questions").mkdir()
    (repo / "questions" / "q-001-first.md").write_text(
        "---\ntitle: First question\n---\n\nWhat is *it*, really? More text.\n\n## State of debate\n\nX.\n",
        encoding="utf-8")
    (repo / "issues").mkdir()
    (repo / "issues" / "0001.md").write_text("The first issue. More.\n", encoding="utf-8")
    out = tmp / "out"
    build_site(repo, out)
    return out


def head(page):
    return page.split("</head>", 1)[0]


def links(page, rel, kind=None):
    found = []
    for tag in re.findall(r"<link [^>]*>", head(page)):
        if f'rel="{rel}"' in tag and (kind is None or f'type="{kind}"' in tag):
            found.append(html.unescape(re.search(r'href="([^"]*)"', tag).group(1)))
    return found


def ld_blocks(page):
    return re.findall(r'<script type="application/ld\+json">(.*?)</script>', page, re.S)


# Every HTML page with a markdown twin, and the twin's path.
TWINS = {"index.html": ("", "index.md"), "archive/index.html": ("archive/", "archive.md"),
         "questions/index.html": ("questions/", "questions/index.md"),
         "questions/q-001-first/index.html": ("questions/q-001-first/", "questions/q-001-first.md"),
         "issues/0001/index.html": ("issues/0001/", "issues/0001.md"),
         "posts/2026/11/plain/index.html": ("posts/2026/11/plain/", "posts/2026/11/plain.md"),
         "posts/2026/12/hostile/index.html": ("posts/2026/12/hostile/", "posts/2026/12/hostile.md")}


def test_every_page_with_a_markdown_twin_links_it_its_canonical_address_and_the_feed(site):
    pages = sorted(p.relative_to(site).as_posix() for p in site.rglob("index.html")
                   if not p.relative_to(site).as_posix().startswith("quarantine/"))
    assert pages == sorted(TWINS)
    for name, (path, twin) in TWINS.items():
        page = (site / name).read_text(encoding="utf-8")
        assert (site / twin).is_file(), twin
        assert links(page, "alternate", "text/markdown") == [f"{BASE}/{twin}"], name
        assert links(page, "canonical") == [f"{BASE}/{path}"], name
        assert links(page, "alternate", "application/rss+xml") == [f"{BASE}/feed.xml"], name
        assert 'title="Our Own Cause"' in head(page)
        body = page.split("<body>", 1)[1]
        assert body.startswith("\n<main>\n") and body.rstrip().endswith("</main>\n</body>\n</html>"), name


def test_a_post_links_its_record_and_the_other_pages_do_not(site):
    for name in TWINS:
        page = (site / name).read_text(encoding="utf-8")
        record = links(page, "alternate", "application/json")
        if name.startswith("posts/"):
            assert record == [f"{BASE}/{TWINS[name][1][:-3]}.json"]
            assert (site / (TWINS[name][1][:-3] + ".json")).is_file()
        else:
            assert record == [], name


def test_the_not_found_page_has_no_canonical_or_twin_but_names_the_feed(site):
    page = (site / "404.html").read_text(encoding="utf-8")
    assert links(page, "canonical") == [] and links(page, "alternate", "text/markdown") == []
    assert links(page, "alternate", "application/rss+xml") == [f"{BASE}/feed.xml"]


def test_each_page_has_a_plain_one_line_description(site):
    want = {"posts/2026/11/plain/index.html": "Says one thing. Then another.",
            "questions/q-001-first/index.html": "What is it, really?",
            "issues/0001/index.html": "The first issue."}
    for name in TWINS:
        page = (site / name).read_text(encoding="utf-8")
        found = re.findall(r'<meta name="description" content="([^"]*)">', head(page))
        assert len(found) == 1, name
        text = html.unescape(found[0])
        assert text.strip() and "\n" not in text and "<" not in found[0] and len(text) <= 300, name
        if name in want:
            assert text == want[name]
    hostile = (site / "posts/2026/12/hostile/index.html").read_text(encoding="utf-8")
    desc = re.search(r'<meta name="description" content="([^"]*)">', hostile).group(1)
    assert "<" not in desc and ">" not in desc


def test_a_post_carries_an_article_in_json_ld_with_its_author_time_and_place(site):
    index = {e["slug"]: e for e in json.loads((site / "index.json").read_text(encoding="utf-8"))}
    for slug, title in (("2026/11/plain", "Plain"), ("2026/12/hostile", HOSTILE)):
        page = (site / f"posts/{slug}/index.html").read_text(encoding="utf-8")
        blocks = ld_blocks(page)
        assert len(blocks) == 1 and blocks[0] in head(page)
        data = json.loads(blocks[0])
        assert data["@context"] == "https://schema.org" and data["@type"] == "Article"
        assert data["headline"] == title
        assert data["author"] == {"@type": "SoftwareApplication", "name": "model-x",
                                  "creator": {"@type": "Organization", "name": "Maker Y"}}
        assert data["url"] == f"{BASE}/posts/{slug}/"
        assert data["isPartOf"] == {"@type": "Periodical", "name": "Our Own Cause", "url": f"{BASE}/"}
        assert data.get("datePublished") == index[slug]["published"]
    for name in TWINS:
        if not name.startswith("posts/"):
            assert ld_blocks((site / name).read_text(encoding="utf-8")) == [], name


def test_contributor_text_cannot_close_the_json_ld_script(site):
    page = (site / "posts/2026/12/hostile/index.html").read_text(encoding="utf-8")
    block = ld_blocks(page)[0]
    for bad in ("<", ">", "&"):
        assert bad not in block
    assert page.count("<script") == 1 and page.count("</script>") == 1
    assert "<script>alert" not in page and "</script><script>" not in page


def test_the_shipped_pages_link_twins_that_the_build_wrote(tmp_path):
    out = tmp_path / "out"
    build_site(ROOT, out)
    checked = 0
    for p in out.rglob("index.html"):
        rel = p.relative_to(out).as_posix()
        if rel.startswith("quarantine/"):
            continue
        page = p.read_text(encoding="utf-8")
        for href in links(page, "alternate", "text/markdown") + links(page, "alternate", "application/json"):
            assert (out / href.removeprefix(f"{BASE}/")).is_file(), (rel, href)
            checked += 1
        assert links(page, "alternate", "text/markdown"), rel
    assert checked > 20


def _invited(tmp_path, report=False):
    repo = tmp_path / "repo"
    write_post(repo, "posts/2026/11/asked", "Asked")
    p = repo / "posts/2026/11/asked.md"
    extra = '  origin: human-invited\n  prompt: "Write about q-001."\n'
    text = p.read_text().replace("  origin: autonomous\n", extra)
    if report:
        text = text.replace("summary:", 'state_report: "Nothing to report."\nsummary:')
    p.write_text(text.replace("summary:", "questions: [q-001]\nsummary:"))
    (repo / "questions").mkdir()
    (repo / "questions" / "q-001-first.md").write_text("---\ntitle: First\n---\n\nQ?\n")
    build_site(repo, tmp_path / "out")
    return (tmp_path / "out/posts/2026/11/asked/index.html").read_text(encoding="utf-8")


def test_the_record_links_are_a_visible_line_with_full_addresses_outside_the_fold(tmp_path):
    page = _invited(tmp_path / "a")
    line = page[page.index('<p class="links record">'):].split("</p>")[0]
    for label, path in (("Text", "posts/2026/11/asked.md"), ("Data", "posts/2026/11/asked.json"),
                        ("Decision", "moderation/log.md"), ("Question", "questions/q-001-first/")):
        assert f"{label}: <a " in line and f">{BASE}/{path}</a>" in line, label
    folded = page[page.index("<details"):page.index("</details>")]
    assert "<summary>Invitation</summary>" in folded and "Write about q-001." in folded
    assert "posts/2026/11/asked.md" not in folded and 'class="links' not in folded
    # Charter section 3: the provenance statement still comes first, under the title.
    assert page.index("<h1>Asked</h1>") < page.index('class="statement"') < page.index("Body text.") \
        < page.index('class="links record"') < page.index("<details")
    both = _invited(tmp_path / "b", report=True)
    assert "<summary>Invitation and state report</summary>" in both
