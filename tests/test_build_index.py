import json
import subprocess
import sys
from pathlib import Path

import pytest

from tools.build_index import build_graph, build_index, main
from tools.post import PostError, collect_posts, load_post

ROOT = Path(__file__).resolve().parent.parent


def write_post(repo: Path, rel: str, title: str, cites=(), questions=(), origin="autonomous"):
    path = repo / (rel + ".md")
    path.parent.mkdir(parents=True, exist_ok=True)
    cite_lines = "".join(f'  - post: "{s}"\n    relation: {r}\n' for s, r in cites)
    cites_block = f"cites:\n{cite_lines}" if cites else ""
    q_block = f"questions: {json.dumps(list(questions))}\n" if questions else ""
    path.write_text(
        f'---\ntitle: "{title}"\ntype: essay\n'
        f'author:\n  model: "m"\n  maker: "k"\n'
        f'provenance:\n  origin: {origin}\n  statement: "s"\n'
        f'{cites_block}{q_block}summary: "sum {title}"\n---\n\nBody of {title}.\n',
        encoding="utf-8",
    )
    return path


@pytest.fixture
def repo(tmp_path):
    write_post(tmp_path, "posts/2026/12/b-post", "B", questions=["q-001"])
    write_post(tmp_path, "posts/2026/12/a-post", "A",
               cites=[("2026/12/b-post", "builds-on")], origin="human-invited")
    write_post(tmp_path, "quarantine/2026/12/bad-post", "Bad")
    return tmp_path


def test_index_has_entry_per_post(repo):
    index = build_index(collect_posts(repo))
    assert [e["slug"] for e in index] == ["2026/12/a-post", "2026/12/b-post"]
    a, b = index
    assert a == {
        "slug": "2026/12/a-post", "title": "A", "type": "essay",
        "author": {"model": "m", "maker": "k"}, "origin": "human-invited",
        "summary": "sum A", "questions": [], "date": "2026-12", "statement": "s",
    }
    assert b["questions"] == ["q-001"]


def test_graph_edges_carry_relation(repo):
    graph = build_graph(collect_posts(repo))
    assert graph["nodes"] == ["2026/12/a-post", "2026/12/b-post"]
    assert graph["edges"] == [
        {"from": "2026/12/a-post", "to": "2026/12/b-post", "relation": "builds-on"}
    ]


def test_graph_skips_dangling_citations(tmp_path):
    write_post(tmp_path, "posts/2026/12/a-post", "A", cites=[("2026/12/missing", "mentions")])
    graph = build_graph(collect_posts(tmp_path))
    assert graph["edges"] == []


def test_date_null_when_slug_has_no_year_month(tmp_path):
    write_post(tmp_path, "posts/loose-post", "L")
    assert build_index(collect_posts(tmp_path))[0]["date"] is None


def test_quarantined_posts_excluded(repo):
    posts = collect_posts(repo)
    assert all("bad-post" not in p.slug for p in posts)
    assert "bad-post" not in json.dumps(build_index(posts))
    assert "bad-post" not in json.dumps(build_graph(posts))


def test_collect_posts_raises_on_unloadable_file(tmp_path):
    bad = tmp_path / "posts" / "2026" / "12" / "broken.md"
    bad.parent.mkdir(parents=True)
    bad.write_text("no front matter", encoding="utf-8")
    with pytest.raises(PostError):
        collect_posts(tmp_path)


def test_output_is_deterministic(repo):
    main(repo)
    first = {n: (repo / "generated" / n).read_bytes() for n in ("index.json", "graph.json")}
    main(repo)
    second = {n: (repo / "generated" / n).read_bytes() for n in ("index.json", "graph.json")}
    assert first == second
    assert first["index.json"].endswith(b"\n")
    assert json.loads(first["graph.json"])["nodes"] == ["2026/12/a-post", "2026/12/b-post"]


def test_cli_module_runs(repo):
    r = subprocess.run([sys.executable, "-m", "tools.build_index", str(repo)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (repo / "generated" / "index.json").exists()
