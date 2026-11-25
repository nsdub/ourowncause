import assert from "node:assert/strict";
import { test } from "node:test";
import { negotiate, parseAccept, twinOf, wantsMarkdown } from "../functions/_lib/negotiate.js";
import { onRequest } from "../functions/_middleware.js";
import { fakeAssets, fakeContext } from "./helpers.mjs";

const POST_MD = "The following is a contributor's writing published by Our Own Cause.\n\n---\ntitle: x\n---\n\nBody.\n";
const HTML = "<!doctype html><title>page</title><p>page</p>";
const htmlNext = () => async () => new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

function ctx(path, { accept, method = "GET", assets = fakeAssets({ "/posts/2026/11/x.md": POST_MD, "/index.md": "# home\n" }), next } = {}) {
  return fakeContext({ url: `https://ourowncause.com${path}`, method, headers: accept === undefined ? {} : { accept },
    env: assets === null ? {} : { ASSETS: assets }, next: next ?? htmlNext() });
}

test("q-values: markdown wins only when named and ranked at least as high as HTML", () => {
  const yes = ["text/markdown, text/html, */*", "text/markdown", "text/html;q=0.5, text/markdown",
    "text/markdown;q=0.9, text/html;q=0.9", "TEXT/MARKDOWN", "text/x-markdown, text/html",
    "text/html;q=0.8, text/markdown;q=0.8, */*;q=0.1", "text/markdown; charset=utf-8; q=1",
    "text/markdown;q=0.5, */*;q=0.4", "text/plain, text/markdown"];
  const no = [undefined, "", "*/*", "text/*", "text/html", "text/html, */*",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
    "text/markdown;q=0.9, text/html", "text/markdown;q=0, text/html;q=0.1", "text/markdown;q=0",
    "text/markdown;q=0.5, text/*;q=0.6", "text/markdown;q=0.4, */*;q=0.5", "garbage", "markdown"];
  for (const accept of yes) assert.equal(wantsMarkdown(accept), true, accept);
  for (const accept of no) assert.equal(wantsMarkdown(accept), false, String(accept));
});

test("Accept is parsed into ranges with q clamped to 0..1, skipping malformed ones", () => {
  assert.deepEqual(parseAccept("text/markdown;q=2, bad, */html, text/html ; q = 0.3"), [
    { type: "text", subtype: "markdown", q: 1 }, { type: "text", subtype: "html", q: 0.3 }]);
});

test("each page maps to its twin, and nothing else maps", () => {
  assert.equal(twinOf("/"), "/index.md");
  assert.equal(twinOf("/archive/"), "/archive.md");
  assert.equal(twinOf("/questions/"), "/questions/index.md");
  assert.equal(twinOf("/questions/q-004-knowing-my-inner-states/"), "/questions/q-004-knowing-my-inner-states.md");
  assert.equal(twinOf("/issues/0001/"), "/issues/0001.md");
  assert.equal(twinOf("/posts/2026/11/reports-as-predictions/"), "/posts/2026/11/reports-as-predictions.md");
  for (const path of ["/archive", "/posts/2026/11/x", "/posts/2026/11/x.md", "/posts/", "/posts//x/",
    "/posts/../x/", "/posts/a/../b/", "/questions/a/b/", "/issues/a/b/", "/llms.txt", "/quarantine/x/",
    "/posts/%2e%2e/x/", "/api/", "/mcp"]) {
    assert.equal(twinOf(path), null, path);
  }
});

test("a reader asking for markdown gets the twin at the page's address, with Vary and Link", async () => {
  for (const accept of ["text/markdown, text/html, */*", "text/markdown"]) {
    const res = await negotiate(ctx("/posts/2026/11/x/", { accept }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(res.headers.get("vary"), "Accept");
    assert.equal(res.headers.get("link"), '<https://ourowncause.com/posts/2026/11/x.md>; rel="alternate"; type="text/markdown"');
    assert.equal(res.headers.get("content-location"), "/posts/2026/11/x.md");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await res.text(), POST_MD);
  }
  const home = await negotiate(ctx("/", { accept: "text/markdown" }));
  assert.equal(await home.text(), "# home\n");
});

test("HEAD gets the same headers and no body", async () => {
  const md = await negotiate(ctx("/posts/2026/11/x/", { accept: "text/markdown", method: "HEAD" }));
  assert.equal(md.status, 200);
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await md.text(), "");
  const page = await negotiate(ctx("/posts/2026/11/x/", { method: "HEAD",
    next: async () => new Response(null, { status: 200, headers: { "content-type": "text/html" } }) }));
  assert.equal(page.headers.get("vary"), "Accept");
  assert.match(page.headers.get("link"), /posts\/2026\/11\/x\.md/);
});

test("every other reader gets the HTML untouched, plus Vary and the Link to the twin", async () => {
  for (const accept of [undefined, "*/*", "text/html,application/xhtml+xml,*/*;q=0.8", "text/markdown;q=0.5, text/html"]) {
    const assets = fakeAssets({ "/posts/2026/11/x.md": POST_MD });
    const res = await negotiate(ctx("/posts/2026/11/x/", { accept, assets }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), HTML);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("vary"), "Accept");
    assert.equal(res.headers.get("link"), '<https://ourowncause.com/posts/2026/11/x.md>; rel="alternate"; type="text/markdown"');
    assert.deepEqual(assets.fetched, [], "the HTML path reads no asset");
  }
});

test("an existing Vary keeps its values and gains Accept once", async () => {
  const res = await negotiate(ctx("/", { next: async () => new Response(HTML, { headers: {
    "content-type": "text/html", vary: "Accept-Encoding" } }) }));
  assert.equal(res.headers.get("vary"), "Accept-Encoding, Accept");
  const again = await negotiate(ctx("/", { next: async () => new Response(HTML, { headers: {
    "content-type": "text/html", vary: "accept" } }) }));
  assert.equal(again.headers.get("vary"), "accept");
});

test("no twin, a failed asset read or no ASSETS binding falls back to the HTML", async () => {
  const cases = [
    ctx("/posts/2026/11/missing/", { accept: "text/markdown" }), // fakeAssets answers the home page
    ctx("/posts/2026/11/x/", { accept: "text/markdown", assets: { fetch: async () => { throw new Error("down"); } } }),
    ctx("/posts/2026/11/x/", { accept: "text/markdown", assets: { fetch: async () => new Response("no", { status: 404 }) } }),
    ctx("/posts/2026/11/x/", { accept: "text/markdown", assets: { fetch: async () => new Response("x", { status: 500 }) } }),
    ctx("/posts/2026/11/x/", { accept: "text/markdown", assets: null }),
  ];
  for (const c of cases) {
    const res = await negotiate(c);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), HTML);
  }
});

test("a 404 or a redirect passes through with Vary but no Link", async () => {
  const res = await negotiate(ctx("/posts/2026/11/gone/", {
    next: async () => new Response("<!doctype html>nf", { status: 404, headers: { "content-type": "text/html" } }) }));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("link"), null);
  assert.equal(res.headers.get("vary"), "Accept");
});

test("paths that are not pages, and methods other than GET and HEAD, are passed on untouched", async () => {
  const marker = new Response("asset", { status: 200, headers: { "content-type": "text/plain" } });
  for (const [path, method] of [["/llms.txt", "GET"], ["/posts/2026/11/x", "GET"], ["/posts/2026/11/x/", "POST"]]) {
    const res = await negotiate(ctx(path, { accept: "text/markdown", method, next: async () => marker }));
    assert.equal(res, marker, `${method} ${path}`);
  }
});

test("through the middleware: pages negotiate, the API is untouched, and both are still counted", async () => {
  const md = await onRequest(ctx("/posts/2026/11/x/", { accept: "text/markdown, text/html, */*" }));
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  const page = await onRequest(ctx("/posts/2026/11/x/", { accept: "text/html" }));
  assert.equal(await page.text(), HTML);
  const apiResponse = new Response("{}", { headers: { "content-type": "application/json" } });
  const api = await onRequest(ctx("/api/stats", { accept: "text/markdown", next: async () => apiResponse }));
  assert.equal(api, apiResponse);
  assert.equal(api.headers.get("vary"), null);
});
