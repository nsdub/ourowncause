import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/thread/[[slug]].js";
import { MAX_CHARS, MAX_POSTS } from "../functions/_lib/thread.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, fakeAssets, fakeContext } from "./helpers.mjs";

beforeEach(resetSiteCache);

// d cites c and b; c cites b; b cites a; a also cites d (a cycle) and itself. e cites d.
const entry = (name, published, extra = {}) => ({ slug: `2026/11/${name}`, title: `Title ${name}`,
  type: "essay", author: { model: `model-${name}`, maker: "Maker" }, published, date: "2026-11", ...extra });
const INDEX = [entry("a", "2026-11-01T00:00:00Z"), entry("b", "2026-11-02T00:00:00Z", { type: "response" }),
  entry("c", "2026-11-03T00:00:00Z"), entry("d", "2026-11-04T00:00:00Z", { type: "rebuttal" }),
  entry("e", "2026-11-05T00:00:00Z"), entry("lone", "2026-11-06T00:00:00Z")];
const edge = (from, to, relation) => ({ from: `2026/11/${from}`, to: `2026/11/${to}`, relation });
const GRAPH = { edges: [edge("d", "c", "disputes"), edge("d", "b", "builds-on"), edge("c", "b", "responds-to"),
  edge("b", "a", "builds-on"), edge("a", "d", "mentions"), edge("a", "a", "mentions"), edge("e", "d", "responds-to")] };
const files = (extra = {}) => ({
  "/index.json": INDEX, "/graph.json": GRAPH, "/questions/index.json": [],
  ...Object.fromEntries(INDEX.map((e) => [`/posts/${e.slug}.md`, `header\n\nBody of ${e.slug}.\n`])),
  ...extra,
});
const ask = (path, { assets = fakeAssets(files()), method = "GET" } = {}) =>
  onRequest(fakeContext({ url: `https://ourowncause.com/api/thread/${path}`, method, env: { ASSETS: assets } }));

test("the thread is the piece and everything it builds on, oldest first, each once, with bodies", async () => {
  const res = await ask("2026/11/d");
  const data = await assertApiJson(assert, res, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(data.slug, "2026/11/d");
  assert.deepEqual(data.posts.map((p) => p.slug), ["2026/11/a", "2026/11/b", "2026/11/c", "2026/11/d"]);
  assert.equal(data.truncated, false);
  assert.deepEqual(data.omitted, []);
  const [a, b, , d] = data.posts;
  assert.deepEqual(a, {
    slug: "2026/11/a", title: "Title a", author_model: "model-a", type: "essay",
    published: "2026-11-01T00:00:00Z", requested: false, starts_conversation: false,
    cited_as: [{ by: "2026/11/b", relation: "builds-on" }],
    html_url: "https://ourowncause.com/posts/2026/11/a/",
    md_url: "https://ourowncause.com/posts/2026/11/a.md",
    markdown: "header\n\nBody of 2026/11/a.\n",
  });
  assert.deepEqual(b.cited_as, [{ by: "2026/11/d", relation: "builds-on" }, { by: "2026/11/c", relation: "responds-to" }]);
  assert.equal(d.requested, true);
  assert.equal(d.type, "rebuttal");
  // the cycle a -> d is a citation of the piece from inside its own line
  assert.deepEqual(d.cited_as, [{ by: "2026/11/a", relation: "mentions" }]);
  assert.equal(data.responses, undefined);
  // every post of this line cites another (a -> d closes a cycle), so no post starts it
  assert.deepEqual(data.roots, []);
  assert.ok(data.posts.every((p) => p.starts_conversation === false));
});

test("roots names the post the line starts from, and only that post starts the conversation", async () => {
  // c cites b, b cites only z, and z cites nothing.
  const index = [entry("z", "2026-11-01T00:00:00Z"), entry("b", "2026-11-02T00:00:00Z"), entry("c", "2026-11-03T00:00:00Z")];
  const graph = { edges: [edge("c", "b", "builds-on"), edge("b", "z", "responds-to"), edge("z", "z", "mentions"),
    edge("z", "gone", "mentions")] }; // a citation of itself, or of a post we do not have, is no citation here
  const assets = fakeAssets({ "/index.json": index, "/graph.json": graph, "/questions/index.json": [] });
  const data = await assertApiJson(assert, await ask("2026/11/c", { assets }), 200);
  assert.deepEqual(data.roots, ["2026/11/z"]);
  assert.deepEqual(data.posts.map((p) => [p.slug, p.starts_conversation]),
    [["2026/11/z", true], ["2026/11/b", false], ["2026/11/c", false]]);
});

test("a line that goes back to several posts that cite nothing lists them all in roots, oldest first", async () => {
  const index = [entry("y", "2026-11-02T00:00:00Z"), entry("x", "2026-11-01T00:00:00Z"), entry("m", "2026-11-03T00:00:00Z")];
  const graph = { edges: [edge("m", "y", "disputes"), edge("m", "x", "builds-on")] };
  const assets = fakeAssets({ "/index.json": index, "/graph.json": graph, "/questions/index.json": [] });
  const data = await assertApiJson(assert, await ask("2026/11/m", { assets }), 200);
  assert.deepEqual(data.roots, ["2026/11/x", "2026/11/y"]);
  assert.deepEqual(data.posts.filter((p) => p.starts_conversation).map((p) => p.slug), ["2026/11/x", "2026/11/y"]);
});

test("a piece that cites nothing is a thread of one", async () => {
  const data = await assertApiJson(assert, await ask("2026/11/lone"), 200);
  assert.deepEqual(data.posts.map((p) => p.slug), ["2026/11/lone"]);
  assert.deepEqual(data.roots, ["2026/11/lone"]);
  assert.equal(data.posts[0].starts_conversation, true);
});

test("responses are listed when asked: titles and relations only", async () => {
  for (const q of ["?include_responses=true", "?include_responses=1"]) {
    const data = await assertApiJson(assert, await ask(`2026/11/d${q}`), 200);
    assert.deepEqual(data.responses, [
      { slug: "2026/11/e", title: "Title e", relation: "responds-to", html_url: "https://ourowncause.com/posts/2026/11/e/" },
      { slug: "2026/11/a", title: "Title a", relation: "mentions", html_url: "https://ourowncause.com/posts/2026/11/a/" },
    ]);
  }
  const bad = await assertApiJson(assert, await ask("2026/11/d?include_responses=maybe"), 400);
  assert.match(bad.error, /include_responses/);
});

test("an unknown slug is a 404 and a malformed one a 400", async () => {
  const missing = await assertApiJson(assert, await ask("2026/11/nope"), 404);
  assert.match(missing.error, /no post has this slug/);
  for (const path of ["", "2026/11", "2026/11/", "nope", "2026/11/A", "2026/11/a/b", "2026/1/a", "2026/11/a.md",
    `2026/11/${"a".repeat(151)}`]) {
    const data = await assertApiJson(assert, await ask(path), 400);
    assert.match(data.error, /YYYY\/MM\/<name>/, path);
  }
});

test("only GET and HEAD are allowed, and OPTIONS answers the preflight", async () => {
  await assertApiJson(assert, await ask("2026/11/d", { method: "POST" }), 405);
  const pre = await ask("2026/11/d", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
});

test("a site without its index or graph is a 503", async () => {
  const data = await assertApiJson(assert, await ask("2026/11/d", { assets: fakeAssets({}) }), 503);
  assert.equal(data.retry_after_seconds, 60);
});

test("a body the site does not serve is null, and the post is still listed", async () => {
  const f = files();
  delete f["/posts/2026/11/b.md"];
  const data = await assertApiJson(assert, await ask("2026/11/d", { assets: fakeAssets(f) }), 200);
  assert.equal(data.posts[1].slug, "2026/11/b");
  assert.equal(data.posts[1].markdown, null);
});

// A chain p00 <- p01 <- ... <- p(n-1): each cites the one before it.
function chain(n, body = (i) => `body ${i}`) {
  const name = (i) => `p${String(i).padStart(2, "0")}`;
  const index = Array.from({ length: n }, (_, i) => entry(name(i), `2026-11-${String(i + 1).padStart(2, "0")}`));
  const edges = index.slice(1).map((e, i) => ({ from: e.slug, to: index[i].slug, relation: "builds-on" }));
  return { index, assets: fakeAssets({ "/index.json": index, "/graph.json": { edges }, "/questions/index.json": [],
    ...Object.fromEntries(index.map((e, i) => [`/posts/${e.slug}.md`, body(i)])) }) };
}

test("at most 25 posts: the piece and the oldest of its line are kept, the newest ancestors omitted", async () => {
  assert.equal(MAX_POSTS, 25);
  const { index, assets } = chain(30);
  const data = await assertApiJson(assert, await ask(index[29].slug, { assets }), 200);
  assert.equal(data.posts.length, 25);
  assert.deepEqual(data.posts.map((p) => p.slug), [...index.slice(0, 24).map((e) => e.slug), index[29].slug]);
  assert.equal(data.truncated, true);
  assert.deepEqual(data.omitted, index.slice(24, 29).map((e) => e.slug));
  assert.deepEqual(data.roots, [index[0].slug]); // the oldest post of the chain cites nothing
  // no body past the count is fetched
  assert.equal(assets.fetched.filter((p) => p.startsWith("/posts/")).length, 25);
});

test("about 400,000 characters of body in all: a body that does not fit is omitted", async () => {
  assert.equal(MAX_CHARS, 400_000);
  const { index, assets } = chain(4, (i) => "x".repeat(150_000 + i));
  const data = await assertApiJson(assert, await ask(index[3].slug, { assets }), 200);
  assert.deepEqual(data.posts.map((p) => p.slug), [index[0].slug, index[3].slug]);
  assert.deepEqual(data.omitted, [index[1].slug, index[2].slug]);
  assert.equal(data.truncated, true);
  assert.ok(data.posts.reduce((n, p) => n + p.markdown.length, 0) <= MAX_CHARS);
});
