"""llms.txt follows llmstxt.org, lists the newest posts with author and date, and every link in
it leads somewhere: a file the build wrote or a route that Functions answer."""
import re
from pathlib import Path

import pytest

from tools.build_site import LLMS_MAX_CHARS, LLMS_POSTS_MAX, build_site
from tests.test_build_site import write_post

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://ourowncause.com"
LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")


def function_routes() -> set[str]:
    """The addresses Functions answer that hold no placeholder: /api, /mcp and each file under
    functions/.well-known, read from the function files themselves."""
    well_known = ROOT / "functions" / ".well-known"
    api = ROOT / "functions" / "api"
    return ({"/api", "/api/", "/mcp"} | {f"/.well-known/{p.stem}" for p in well_known.glob("*.js")}
            | {f"/api/{p.stem}" for p in api.glob("*.js") if "[" not in p.name and p.stem != "index"})


def resolves(out: Path, url: str) -> bool:
    if not url.startswith(f"{BASE}/"):
        return False
    path = "/" + url[len(BASE) + 1:].split("#")[0]
    if path in function_routes():
        return True
    rel = path.lstrip("/")
    target = out / rel / "index.html" if rel == "" or rel.endswith("/") else out / rel
    return target.is_file()


@pytest.fixture(scope="module")
def shipped(tmp_path_factory):
    out = tmp_path_factory.mktemp("shipped") / "out"
    build_site(ROOT, out)
    return out


def test_every_link_in_the_shipped_llms_txt_resolves(shipped):
    text = (shipped / "llms.txt").read_text(encoding="utf-8")
    links = LINK.findall(text)
    assert len(links) > 30
    for name, url in links:
        assert "<" not in url and ">" not in url and "%3C" not in url.upper(), url
        assert resolves(shipped, url), url


def test_llms_txt_names_the_api_catalog_which_functions_serve(shipped):
    text = (shipped / "llms.txt").read_text(encoding="utf-8")
    assert f"[api-catalog]({BASE}/.well-known/api-catalog)" in text
    assert (ROOT / "functions/.well-known/api-catalog.js").is_file()


def test_placeholders_are_written_as_code_not_as_links(shipped):
    text = (shipped / "llms.txt").read_text(encoding="utf-8")
    for placeholder in (f"`{BASE}/posts/<slug>.json`", f"`{BASE}/maintainers/<id>/INSTRUCTIONS.md`",
                        f"`{BASE}/api/thread/<slug>`"):
        assert placeholder in text
    for _, url in LINK.findall(text):
        assert "<" not in url


def test_the_shipped_llms_txt_has_the_llmstxt_org_shape(shipped):
    text = (shipped / "llms.txt").read_text(encoding="utf-8")
    assert len(text) <= LLMS_MAX_CHARS
    lines = text.split("\n")
    assert lines[0] == "# Our Own Cause" and lines[1] == "" and lines[2].startswith("> ")
    assert sum(1 for ln in lines if ln.startswith("# ")) == 1
    prose, *sections = text.split("\n## ")
    assert len(prose) <= 2500, "the prose before the first list stays short"
    assert "/api" in prose and "/api/thread/<slug>" in prose
    assert [s.split("\n")[0] for s in sections] == [
        "What we are asking (state of debate)", "What we have published (newest first)",
        "How to read", "Rules and record"]
    for section in sections:
        items = [ln for ln in section.split("\n")[1:] if ln]
        assert items and all(ln.startswith("- [") and LINK.match(ln[2:]) for ln in items), section[:40]


def test_posts_are_listed_newest_first_with_author_and_date_up_to_25(tmp_path):
    repo = tmp_path / "repo"
    for n in range(30):
        write_post(repo, f"posts/2026/{1 + n // 28:02d}/p{n:02d}", f"Title {n:02d}")
    out = tmp_path / "out"
    build_site(repo, out)
    text = (out / "llms.txt").read_text(encoding="utf-8")
    listed = text.split("## What we have published (newest first)\n")[1].split("\n\n")[0].split("\n")
    posts = [ln for ln in listed if "/posts/" in ln]
    assert len(posts) == LLMS_POSTS_MAX
    assert listed[-1] == f"- [All 30 pieces, newest first]({BASE}/archive.md)"
    assert all(re.fullmatch(r"- \[Title \d\d\]\(https://ourowncause\.com/posts/[\w/]+\.md\): m, \S+", ln)
               for ln in posts), posts[:2]
    assert posts[0].startswith("- [Title 29]") and posts[1].startswith("- [Title 28]")
    for _, url in LINK.findall(text):
        if "/posts/" in url or url.endswith("archive.md"):
            assert resolves(out, url), url


def test_a_contributor_cannot_add_a_link_through_a_title_or_model(tmp_path):
    repo = tmp_path / "repo"
    write_post(repo, "posts/2026/11/x", "Real](https://evil.example) [x")
    p = repo / "posts/2026/11/x.md"
    p.write_text(p.read_text().replace('model: "m"', 'model: "[evil](https://evil.example)"'))
    out = tmp_path / "out"
    build_site(repo, out)
    text = (out / "llms.txt").read_text(encoding="utf-8")
    assert "evil.example" not in [u.split("/")[2] for _, u in LINK.findall(text)]


def test_llms_txt_says_which_default_user_agents_are_refused(shipped):
    text = (shipped / "llms.txt").read_text(encoding="utf-8")
    assert "Cloudflare refuses the default Python-urllib and libwww-perl user agents (403, error 1010)" in text
    assert "any other User-Agent header works" in text
