"""_routes.json sends our HTML pages through Functions (for markdown negotiation) and keeps
every other static file off them, so reading the text and the data costs no Functions quota."""
import json
import re
from pathlib import Path

from tools.build_site import build_site

ROOT = Path(__file__).resolve().parent.parent


def cloudflare_rule(rule: str) -> re.Pattern:
    """A _routes.json rule as Cloudflare matches it (wrangler's pages-dev-util): a rule ending
    in /* or / also matches the path without that ending; * matches any run of characters,
    slashes included; dots are literal."""
    if rule in ("/", "/*"):
        body = rule
    elif rule.endswith("/*"):
        body = rule[:-2] + "(/*)?"
    elif rule.endswith("/"):
        body = rule[:-1] + "(/)?"
    elif rule.endswith("*"):
        body = rule
    else:
        body = rule + "(/)?"
    return re.compile("^" + body.replace(".", "\\.").replace("*", ".*") + "$")


def routed(routes: dict, path: str) -> bool:
    if any(cloudflare_rule(r).match(path) for r in routes["exclude"]):
        return False
    return any(cloudflare_rule(r).match(path) for r in routes["include"])


def test_the_rule_matcher_matches_cloudflares_examples():
    assert cloudflare_rule("/api/*").match("/api") and cloudflare_rule("/api/*").match("/api/a/b")
    assert not cloudflare_rule("/api/*").match("/apix")
    assert cloudflare_rule("/").match("/") and not cloudflare_rule("/").match("/index.md")
    assert cloudflare_rule("/posts/*.md").match("/posts/2026/11/x.md")
    assert not cloudflare_rule("/posts/*.md").match("/posts/2026/11/x/")


def test_html_pages_go_through_functions_and_no_other_static_file_does(tmp_path):
    out = tmp_path / "out"
    build_site(ROOT, out)
    routes = json.loads((out / "_routes.json").read_text(encoding="utf-8"))
    rules = routes["include"] + routes["exclude"]
    assert len(rules) <= 100 and all(len(r) <= 100 and r.startswith("/") for r in rules)
    pages, others = [], []
    for p in out.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(out).as_posix()
        if rel.startswith("quarantine/") or rel in ("_routes.json", "_headers", "404.html"):
            continue
        if p.name == "index.html":
            pages.append("/" + rel[:-len("index.html")])
        else:
            others.append("/" + rel)
    assert len(pages) > 20 and len(others) > 20
    for path in pages:
        assert routed(routes, path), path
    for path in others:
        assert not routed(routes, path), path
    for path in ("/api", "/api/thread/2026/11/x", "/mcp", "/.well-known/mcp.json",
                 "/.well-known/api-catalog", "/archive"):
        assert routed(routes, path), path
    for path in ("/llms.txt", "/robots.txt", "/feed.xml", "/index.md", "/archive.md",
                 "/questions/index.md", "/questions/q-004/index.json", "/quarantine/x/"):
        assert not routed(routes, path), path
