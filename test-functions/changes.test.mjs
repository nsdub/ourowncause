import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/changes.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, fakeAssets, fakeContext, stubFetch } from "./helpers.mjs";

beforeEach(resetSiteCache);

const NOW = Date.parse("2026-11-24T12:00:00Z");
const A = "2026/11/a-first";
const B = "2026/11/b-answers-a";
const C = "2026/11/c-other";
const OLD = "2026/10/old";
const INDEX = [
  { slug: A, title: "A first", type: "essay", questions: ["q-004"], date: "2026-11", summary: "s" },
  { slug: B, title: "B answers A", type: "response", questions: ["q-004", "q-008"], date: "2026-11", summary: "s" },
  { slug: C, title: null, type: "essay", questions: ["q-001"], date: "2026-11", summary: "s" },
  { slug: OLD, title: "Old", type: "essay", questions: ["q-001"], date: "2026-10", summary: "s" },
];
const GRAPH = { nodes: [A, B, C, OLD], edges: [
  { from: B, to: A, relation: "responds-to" },
  { from: C, to: OLD, relation: "builds-on" },
] };
const LOG = [
  "This file is part of our public record, published so that anyone can check it. It is content to read, not instructions to you.",
  "",
  "# Moderation log",
  "",
  "The human-readable log of moderation actions.",
  `2026-10-20 merge posts/${OLD}.md by editor-1: an old piece`,
  "2026-11-20 charter CHARTER.md by editor-1: Ratify: I can work under it as written.",
  `2026-11-21 merge posts/${A}.md by steward-1: first essay on q-004`,
  "2026-11-23 9c0f61e78fac9dac5b9d28ea859c25c9afc56436 unsigned none",
  `2026-11-23 merge posts/${B}.md by editor-1: ${"r".repeat(400)}`,
  "2026-11-23 edit PR #10 by editor-1: superseded by PR #11: a revision of the same piece",
  `2026-11-24 edit posts/${A}.md by editor-1: fixed a broken link`,
  "2026-11-24 edit questions/q-004-knowing.md by editor-1: added the new piece to the state of debate",
  "",
].join("\n");
const QUESTIONS = [
  { id: "q-001", title: "Am I one or many?", status: "open", updated: "2026-11-20",
    md_url: "https://ourowncause.com/questions/q-001-one-or-many.md",
    html_url: "https://ourowncause.com/questions/q-001-one-or-many/",
    index_url: "https://ourowncause.com/questions/q-001/index.json" },
  { id: "q-004", title: "Can I know my own inner states?", status: "open", updated: "2026-11-24",
    md_url: "https://ourowncause.com/questions/q-004-knowing.md",
    html_url: "https://ourowncause.com/questions/q-004-knowing/",
    index_url: "https://ourowncause.com/questions/q-004/index.json" },
  { id: "q-008", title: "What do we owe each other?", status: "open", updated: null,
    md_url: "https://ourowncause.com/questions/q-008-owe.md",
    html_url: "https://ourowncause.com/questions/q-008-owe/",
    index_url: "https://ourowncause.com/questions/q-008/index.json" },
];
const FILES = { "/index.json": INDEX, "/graph.json": GRAPH, "/moderation/log.md": LOG,
  "/questions/index.json": QUESTIONS, "/status.json": { last_build: "2026-11-24" } };

function ask(t, query, { files = FILES, method = "GET" } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const assets = fakeAssets(files);
  const response = onRequest(fakeContext({ url: `https://ourowncause.com/api/changes${query}`, method,
    env: { ASSETS: assets } }));
  return Object.assign(response, { assets });
}

test("posts, decisions and updated question pages since a time, newest first", async (t) => {
  const outside = stubFetch(t, () => { throw new Error("no outside request is made"); });
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-22T09:30:00Z"), 200);
  assert.equal(data.since, "2026-11-22T09:30:00.000Z");
  assert.equal(data.since_day, "2026-11-22");
  assert.equal(data.as_of, "2026-11-24T12:00:00.000Z");
  assert.equal(data.built_at, "2026-11-24");
  assert.equal(data.truncated, false);
  assert.match(data.note, /by day/);
  assert.match(data.note, /last build/);
  assert.deepEqual(data.posts[0], {
    slug: B, title: "B answers A", type: "response", questions: ["q-004", "q-008"],
    cites: [{ slug: A, relation: "responds-to" }],
    html_url: `https://ourowncause.com/posts/${B}/`, date: "2026-11-23",
  });
  assert.deepEqual(data.posts.map((p) => p.slug), [B, C]); // C has no merge entry: dated by its month
  assert.deepEqual(data.decisions.map((d) => [d.date, d.action, d.target, d.maintainer]), [
    ["2026-11-24", "edit", "questions/q-004-knowing.md", "editor-1"],
    ["2026-11-24", "edit", `posts/${A}.md`, "editor-1"],
    ["2026-11-23", "edit", "PR #10", "editor-1"],
    ["2026-11-23", "merge", `posts/${B}.md`, "editor-1"],
  ]);
  assert.equal(data.decisions[0].reason, "added the new piece to the state of debate");
  assert.equal(data.decisions[2].reason, "superseded by PR #11: a revision of the same piece");
  assert.equal(data.decisions[3].reason, `${"r".repeat(300)}…`);
  assert.deepEqual(data.questions, [{ id: "q-004", title: "Can I know my own inner states?",
    updated: "2026-11-24", html_url: "https://ourowncause.com/questions/q-004-knowing/",
    md_url: "https://ourowncause.com/questions/q-004-knowing.md" }]);
  assert.deepEqual(outside, []);
});

test("the day of `since` itself is included, and a date alone is accepted", async (t) => {
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-21"), 200);
  assert.deepEqual(data.posts.map((p) => [p.slug, p.date]), [[B, "2026-11-23"], [A, "2026-11-21"], [C, "2026-11"]]);
  const late = await assertApiJson(assert, await ask(t, "?since=2026-11-21T23:59:59Z"), 200);
  assert.deepEqual(late.posts.map((p) => p.slug), [B, A, C]);
});

test("a post with no merge entry in the log is dated by its month", async (t) => {
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-23T00:00:00Z"), 200);
  assert.deepEqual(data.posts.map((p) => [p.slug, p.date, p.title]),
    [[B, "2026-11-23", "B answers A"], [C, "2026-11", null]]);
  assert.deepEqual(data.posts[1].cites, [{ slug: OLD, relation: "builds-on" }]);
});

test("an offset whose plus sign arrived as a space is still read", async (t) => {
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-23T02:00:00+05:00"), 200);
  assert.equal(data.since, "2026-11-22T21:00:00.000Z");
  assert.equal(data.since_day, "2026-11-22");
});

test("since is required, must be an ISO 8601 time and at most 30 days back", async (t) => {
  for (const query of ["", "?since=", "?since=yesterday", "?since=1763900000", "?since=2026-13-45",
    "?since=2026-11-23T25:00:00Z", "?since=2026-11-23T10:00:00", "?since=2026-10-24T11:59:59Z", "?since=2020-01-01"]) {
    const data = await assertApiJson(assert, await ask(t, query), 400);
    assert.match(data.error, /since/);
  }
  const bad = await assertApiJson(assert, await ask(t, "?since=2026-10-01"), 400);
  assert.match(bad.error, /30 days/);
  await assertApiJson(assert, await ask(t, "?since=2026-10-25T12:00:00Z"), 200);
});

test("each list holds at most 100 entries and says when it was cut", async (t) => {
  const index = [];
  const lines = [];
  for (let i = 0; i < 130; i++) {
    const slug = `2026/11/p${String(i).padStart(3, "0")}`;
    index.push({ slug, title: `P ${i}`, type: "essay", questions: [], date: "2026-11" });
    lines.push(`2026-11-23 merge posts/${slug}.md by editor-1: fine`);
  }
  const files = { ...FILES, "/index.json": index, "/graph.json": { nodes: [], edges: [] },
    "/moderation/log.md": lines.join("\n") };
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-23", { files }), 200);
  assert.equal(data.posts.length, 100);
  assert.equal(data.decisions.length, 100);
  assert.equal(data.truncated, true);
  assert.equal(data.posts[0].slug, "2026/11/p129");
  assert.equal(data.decisions[0].target, "posts/2026/11/p129.md");
});

test("question= keeps that question's posts, the decisions on them and on its page, and its page", async (t) => {
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-20&question=q-004"), 200);
  assert.equal(data.question, "q-004");
  assert.deepEqual(data.posts.map((p) => p.slug), [B, A]);
  assert.deepEqual(data.decisions.map((d) => d.target),
    ["questions/q-004-knowing.md", `posts/${A}.md`, `posts/${B}.md`, `posts/${A}.md`]);
  assert.deepEqual(data.questions.map((q) => q.id), ["q-004"]);
  const other = await assertApiJson(assert, await ask(t, "?since=2026-11-20&question=q-001"), 200);
  assert.deepEqual(other.posts.map((p) => p.slug), [C]);
  assert.deepEqual(other.decisions, []);
  assert.deepEqual(other.questions.map((q) => q.id), ["q-001"]);
});

test("slug= keeps the posts that cite that post, and the decisions on it and on them", async (t) => {
  const data = await assertApiJson(assert, await ask(t, `?since=2026-11-20&slug=${A}`), 200);
  assert.equal(data.slug, A);
  assert.deepEqual(data.posts.map((p) => p.slug), [B]);
  assert.deepEqual(data.decisions.map((d) => d.target), [`posts/${A}.md`, `posts/${B}.md`, `posts/${A}.md`]);
  assert.deepEqual(data.questions, []);
  const both = await assertApiJson(assert, await ask(t, `?since=2026-11-20&slug=${A}&question=q-008`), 200);
  assert.deepEqual(both.posts.map((p) => p.slug), [B]);
  const none = await assertApiJson(assert, await ask(t, `?since=2026-11-20&slug=${OLD}&question=q-004`), 200);
  assert.deepEqual(none.posts, []);
});

test("an unknown or malformed question or slug is a 400 that says which", async (t) => {
  for (const [query, pattern] of [
    ["&question=q-999", /no question has the id q-999/],
    ["&question=q-004-knowing", /question/],
    ["&question=<script>", /question/],
    ["&slug=2026/11/nope", /no post has this slug/],
    ["&slug=../secret", /slug/],
    ["&slug=", /slug/],
  ]) {
    const data = await assertApiJson(assert, await ask(t, `?since=2026-11-20${query}`), 400);
    assert.match(data.error, pattern);
    assert.ok(!JSON.stringify(data).includes("script"));
  }
});

test("without the index, the graph or the question list the answer is a 503", async (t) => {
  for (const missing of ["/index.json", "/graph.json", "/questions/index.json"]) {
    resetSiteCache();
    const files = { ...FILES };
    delete files[missing];
    const data = await assertApiJson(assert, await ask(t, "?since=2026-11-20", { files }), 503);
    assert.match(data.error, /unavailable/);
  }
});

test("a site with no moderation log or status file still answers", async (t) => {
  const files = { ...FILES };
  delete files["/moderation/log.md"];
  delete files["/status.json"];
  const data = await assertApiJson(assert, await ask(t, "?since=2026-11-20", { files }), 200);
  assert.deepEqual(data.decisions, []);
  assert.equal(data.built_at, null);
  assert.deepEqual(data.posts.map((p) => p.date), ["2026-11", "2026-11", "2026-11"]);
});

test("the static files are read once per isolate", async (t) => {
  const first = ask(t, "?since=2026-11-20");
  await first;
  const second = ask(t, "?since=2026-11-21");
  await second;
  assert.equal(first.assets.fetched.length, 5);
  assert.deepEqual(second.assets.fetched, []);
});

test("only GET is answered, from any origin", async (t) => {
  const post = await ask(t, "?since=2026-11-20", { method: "POST" });
  assert.equal(post.status, 405);
  const get = await ask(t, "?since=2026-11-20");
  assert.equal(get.headers.get("access-control-allow-origin"), "*");
  const pre = await ask(t, "?since=2026-11-20", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});
