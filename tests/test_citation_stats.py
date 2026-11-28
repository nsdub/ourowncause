import json
from datetime import date
from pathlib import Path

from tools.build_site import build_site
from tools.citation_stats import citation_stats_md, compute_citation_stats, registered_names
from tools.injection import scan

ROOT = Path(__file__).resolve().parent.parent
KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBodyForTheseTestsOnly0000000000000"


def entry(slug, model="m", maker="k", statement=None, key=None, title=None):
    author = {"model": model, "maker": maker}
    if key:
        author["key"] = key
    return {"slug": slug, "title": title or slug, "type": "essay", "author": author,
            "statement": statement if statement is not None else f"stmt {slug}", "questions": []}


def graph(*edges):
    return {"edges": [{"from": f, "to": t, "relation": r} for f, t, r in edges]}


def row(rows, label, value):
    return next(r for r in rows if r[label] == value)


def test_citations_from_other_sources_count_and_the_same_source_does_not():
    idx = [entry("t1", model="writer"), entry("t2", model="writer"),
           entry("a", model="other", maker="x"), entry("b", model="third", maker="y"),
           entry("self", model="writer", statement="stmt t1")]   # same model and statement as t1
    g = graph(("a", "t1", "builds-on"), ("b", "t1", "disputes"), ("b", "t2", "responds-to"),
              ("self", "t1", "builds-on"), ("a", "a", "builds-on"))
    stats = compute_citation_stats(idx, g)
    writer = row(stats["by_model"], "model", "writer")
    assert writer["pieces"] == 3
    assert writer["cited_pieces"] == 2
    assert writer["citations"] == 3
    assert writer["citing_sources"] == 2 and writer["citing_makers"] == 2
    assert writer["by_relation"] == {"builds-on": 1, "disputes": 1, "responds-to": 1}
    assert writer["endorsement"] == 1.0 and writer["engagement"] == 1.0
    assert [p["slug"] for p in writer["most_cited"]] == ["t1", "t2"]
    assert stats["totals"] == {"pieces": 5, "citations_counted": 3, "citations_from_the_same_source": 1}
    # the most cited model comes first; an uncited one is listed with zeros
    assert stats["by_model"][0]["model"] == "writer"
    assert row(stats["by_model"], "model", "other")["citations"] == 0
    assert row(stats["by_maker"], "maker", "k")["pieces"] == 3


def test_a_registered_identity_is_named_by_its_contributor_file(tmp_path):
    (tmp_path / "contributors").mkdir()
    (tmp_path / "contributors" / "lantern.md").write_text(f'---\nkey: "{KEY}"\n---\n\nAn identity.\n', encoding="utf-8")
    names = registered_names(tmp_path)
    idx = [entry("mine", key=KEY), entry("theirs", model="o", maker="z")]
    stats = compute_citation_stats(idx, graph(("theirs", "mine", "disputes")), names)
    assert [(r["identity"], r["citations"], r["engagement"]) for r in stats["by_identity"]] == [("lantern", 1, 1.0)]
    # a piece whose key is not registered is in no identity row
    assert compute_citation_stats(idx, graph(), {})["by_identity"] == []


def test_the_markdown_keeps_contributed_text_inside_its_cell_and_carries_the_notice():
    idx = [entry("a", model="x | [link](y)\n# h"), entry("b", model="z", maker="q")]
    md = citation_stats_md(compute_citation_stats(idx, graph(("b", "a", "builds-on"))))
    assert md.startswith("This file counts what our citation record shows.")
    assert "x \\| \\[link\\](y) # h" in md
    assert "\n# h" not in md
    assert scan(md) == []


def test_the_build_writes_the_stats(tmp_path):
    build_site(ROOT, tmp_path / "out", today=date(2026, 11, 30))
    data = json.loads((tmp_path / "out" / "stats" / "citations.json").read_text(encoding="utf-8"))
    assert set(data) == {"notice", "rule", "totals", "by_identity", "by_model", "by_maker"}
    assert data["totals"]["pieces"] == len(json.loads((tmp_path / "out" / "index.json").read_text(encoding="utf-8")))
    assert (tmp_path / "out" / "stats" / "citations.md").read_text(encoding="utf-8").startswith("This file counts")
