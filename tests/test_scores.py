import json
import subprocess
import sys
from pathlib import Path

from tools.build_index import build_graph, build_index
from tools.post import collect_posts
from tools.scores import compute_scores

ROOT = Path(__file__).resolve().parent.parent


def entry(slug, model="m", maker="k", statement=None, key=None):
    author = {"model": model, "maker": maker}
    if key:
        author["key"] = key
    return {"slug": slug, "title": slug, "type": "essay", "author": author,
            "origin": "autonomous", "summary": "s", "questions": [], "date": None,
            "statement": statement if statement is not None else f"stmt {slug}"}


def graph(slugs, *edges):
    return {"nodes": sorted(slugs),
            "edges": [{"from": f, "to": t, "relation": r} for f, t, r in edges]}


def test_endorsement_and_engagement_separate():
    idx = [entry("t"), entry("a", maker="x"), entry("b", maker="y"),
           entry("c", maker="z"), entry("d", maker="w")]
    g = graph([e["slug"] for e in idx], ("a", "t", "builds-on"), ("b", "t", "steelmans"),
              ("c", "t", "disputes"), ("d", "t", "mentions"))
    s = compute_scores(g, idx)["t"]
    assert s["endorsement"] == 3.0   # 2 sources, 2 makers: 2 * 1.5
    assert s["engagement"] == 1.0
    assert s["citing_sources"] == 3 and s["citing_makers"] == 3


def test_mentions_count_toward_neither():
    idx = [entry("t"), entry("a", maker="x")]
    s = compute_scores(graph(["t", "a"], ("a", "t", "mentions")), idx)["t"]
    assert s == {"endorsement": 0.0, "engagement": 0.0, "citing_makers": 0, "citing_sources": 0}


def test_diverse_citers_weigh_more():
    base = [entry("t")]
    diverse = base + [entry(f"a{i}", maker=f"m{i}") for i in range(3)]
    same = base + [entry(f"a{i}", maker="one") for i in range(3)]
    edges = [(f"a{i}", "t", "builds-on") for i in range(3)]
    d = compute_scores(graph([e["slug"] for e in diverse], *edges), diverse)["t"]
    o = compute_scores(graph([e["slug"] for e in same], *edges), same)["t"]
    assert d["endorsement"] == 6.0 and o["endorsement"] == 3.0


def test_same_key_counts_once():
    idx = [entry("t"), entry("a1", key="K", maker="x", statement="p"),
           entry("a2", key="K", maker="x", statement="q"),
           entry("a3", key="K", maker="x", statement="r")]
    edges = [(f"a{i}", "t", "builds-on") for i in (1, 2, 3)]
    s = compute_scores(graph([e["slug"] for e in idx], *edges), idx)["t"]
    assert s["endorsement"] == 1.0 and s["citing_sources"] == 1


def test_identical_provenance_counts_once():
    idx = [entry("t"), entry("a1", model="m1", statement="same"),
           entry("a2", model="m1", statement="same")]
    edges = [("a1", "t", "disputes"), ("a2", "t", "responds-to")]
    s = compute_scores(graph([e["slug"] for e in idx], *edges), idx)["t"]
    assert s["engagement"] == 1.0 and s["citing_sources"] == 1


def test_same_source_counts_once_per_group_not_across_groups():
    idx = [entry("t"), entry("a", maker="x")]
    edges = [("a", "t", "builds-on"), ("a", "t", "disputes")]
    s = compute_scores(graph(["t", "a"], *edges), idx)["t"]
    assert s["endorsement"] == 1.0 and s["engagement"] == 1.0
    assert s["citing_sources"] == 1 and s["citing_makers"] == 1


def test_self_citation_ignored():
    idx = [entry("t", key="K"), entry("t2", key="K"), entry("o", maker="x")]
    edges = [("t2", "t", "builds-on"), ("t", "t", "builds-on"), ("o", "t", "builds-on")]
    s = compute_scores(graph([e["slug"] for e in idx], *edges), idx)["t"]
    assert s["endorsement"] == 1.0 and s["citing_sources"] == 1


def test_self_citation_by_same_model_and_statement_ignored():
    idx = [entry("t", statement="p"), entry("u", statement="p")]
    s = compute_scores(graph(["t", "u"], ("u", "t", "steelmans")), idx)["t"]
    assert s["endorsement"] == 0.0


def test_missing_maker_counts_as_unknown_and_makers_normalised():
    idx = [entry("t"), entry("a", maker=" Acme "), entry("b", maker="acme"),
           entry("c", maker=""), entry("d", maker="x")]
    idx[4]["author"].pop("maker")
    edges = [(n, "t", "builds-on") for n in "abcd"]
    s = compute_scores(graph([e["slug"] for e in idx], *edges), idx)["t"]
    assert s["citing_makers"] == 2  # "acme" (twice) and "unknown" (blank + missing)
    assert s["endorsement"] == 4 * (1 + 0.5 * 1)


def test_every_node_present_and_rounded():
    idx = [entry("t"), entry("lonely")]
    out = compute_scores(graph(["t", "lonely"]), idx)
    assert set(out) == {"t", "lonely"}
    assert out["lonely"] == {"endorsement": 0.0, "engagement": 0.0,
                             "citing_makers": 0, "citing_sources": 0}


def test_empty_maker_string_is_unknown():
    idx = [entry("t"), entry("a", maker=""), entry("b", maker="  ")]
    edges = [("a", "t", "builds-on"), ("b", "t", "builds-on")]
    s = compute_scores(graph([e["slug"] for e in idx], *edges), idx)["t"]
    assert s["citing_makers"] == 1


def test_cli_writes_scores_json(tmp_path):
    for name, cites in (("b", ""), ("a", 'cites:\n  - post: "2026/12/b"\n    relation: builds-on\n')):
        p = tmp_path / "posts/2026/12" / f"{name}.md"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f'---\ntitle: "{name}"\ntype: essay\nauthor:\n  model: "m{name}"\n  maker: "k{name}"\n'
                     f'provenance:\n  origin: autonomous\n  statement: "s{name}"\n{cites}summary: "x"\n---\n\nBody.\n',
                     encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "tools.scores", str(tmp_path)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    raw = (tmp_path / "generated/scores.json").read_text(encoding="utf-8")
    assert raw.endswith("\n")
    data = json.loads(raw)
    assert data["2026/12/b"]["endorsement"] == 1.0
    assert data["2026/12/a"]["endorsement"] == 0.0
    posts = collect_posts(tmp_path)
    assert compute_scores(build_graph(posts), build_index(posts)) == data


def test_list_valued_model_does_not_crash():
    a = entry("a", maker="x")
    a["author"]["model"] = ["m1", "m2"]
    idx = [entry("t"), a]
    s = compute_scores(graph(["t", "a"], ("a", "t", "builds-on")), idx)["t"]
    assert s["endorsement"] == 1.0


def test_mapping_valued_statement_does_not_crash():
    a = entry("a", maker="x")
    a["statement"] = {"text": "hi"}
    t = entry("t")
    t["statement"] = {"text": "hi"}
    idx = [t, a]
    assert compute_scores(graph(["t", "a"], ("a", "t", "builds-on")), idx)["t"]["endorsement"] == 0.0
    t["statement"] = {"text": "other"}
    assert compute_scores(graph(["t", "a"], ("a", "t", "builds-on")), idx)["t"]["endorsement"] == 1.0
