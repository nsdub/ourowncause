import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/status/[id].js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, fakeAssets, fakeContext, fakeD1, githubJson, stubFetch } from "./helpers.mjs";

beforeEach(resetSiteCache);

const ID = "0123456789abcdef";
const SLUG = "2026/11/t-012345";
const PULL = { number: 41, state: "closed", merged_at: "2026-11-23T12:00:00Z",
  html_url: "https://github.com/nsdub/ourowncause/pull/41",
  head: { ref: `gateway/${ID}`, repo: { full_name: "nsdub/ourowncause" } } };
const INDEX = [
  { slug: SLUG, title: "T", type: "essay", questions: ["q-001"], date: "2026-11" },
  { slug: "2026/11/reply-one", title: "Reply one", type: "response", questions: ["q-001"], date: "2026-11" },
  { slug: "2026/12/reply-two", title: null, type: "rebuttal", questions: ["q-001"], date: "2026-12" },
  { slug: "2026/11/unrelated", title: "Unrelated", type: "essay", questions: [], date: "2026-11" },
];
const GRAPH = { nodes: INDEX.map((e) => e.slug), edges: [
  { from: "2026/11/reply-one", to: SLUG, relation: "responds-to" },
  { from: "2026/12/reply-two", to: SLUG, relation: "disputes" },
  { from: "2026/11/unrelated", to: "2026/11/reply-one", relation: "builds-on" },
] };
const LOG = `2026-11-24 merge posts/${SLUG}.md by editor-1: fine\n`
  + "2026-11-25 merge posts/2026/11/reply-one.md by editor-1: fine\n";
const FILES = { "/index.json": INDEX, "/graph.json": GRAPH, "/moderation/log.md": LOG, "/questions/index.json": [] };

function seeded(path = `posts/${SLUG}.md`) {
  const db = fakeD1("main");
  db.sqlite.prepare(
    "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent) "
    + "VALUES (?, '2026-11-23T10:00:00.000Z', 'T', ?, 'body', '{}', 'absent', NULL)",
  ).run(ID, path);
  return db;
}
const get = (db, files, pull = PULL, t) => {
  if (t) stubFetch(t, (url) => githubJson(url.includes("/pulls?") ? [pull] : []));
  return onRequest(fakeContext({ url: `https://ourowncause.com/api/status/${ID}`, params: { id: ID },
    env: { DB: db, ...(files ? { ASSETS: fakeAssets(files) } : {}) } }));
};

test("a merged submission names where the post is published and the posts that cite it", async (t) => {
  const data = await assertApiJson(assert, await get(seeded(), FILES, PULL, t), 200);
  assert.equal(data.state, "merged");
  assert.deepEqual(data.published, {
    slug: SLUG,
    html_url: `https://ourowncause.com/posts/${SLUG}/`,
    md_url: `https://ourowncause.com/posts/${SLUG}.md`,
    json_url: `https://ourowncause.com/posts/${SLUG}.json`,
  });
  assert.deepEqual(data.responses, [
    { slug: "2026/12/reply-two", title: null, relation: "disputes",
      html_url: "https://ourowncause.com/posts/2026/12/reply-two/" },
    { slug: "2026/11/reply-one", title: "Reply one", relation: "responds-to",
      html_url: "https://ourowncause.com/posts/2026/11/reply-one/" },
  ]);
  assert.equal(data.note, undefined);
});

test("responses are read afresh although the merged state is cached for good", async (t) => {
  const db = seeded();
  const calls = stubFetch(t, (url) => githubJson(url.includes("/pulls?") ? [PULL] : []));
  const first = await (await get(db, { ...FILES, "/graph.json": { nodes: [], edges: [] } })).json();
  assert.deepEqual(first.responses, []);
  const asked = calls.length;
  resetSiteCache(); // a new deployment starts new isolates
  const second = await (await get(db, FILES)).json();
  assert.equal(second.responses.length, 2);
  assert.equal(calls.length, asked);
  assert.ok(!db.sqlite.prepare("SELECT json FROM status_cache").get().json.includes("responses"));
});

test("at most 50 responses are listed, newest first", async (t) => {
  const index = [...INDEX];
  const edges = [];
  const lines = [];
  for (let i = 0; i < 60; i++) {
    const slug = `2026/12/r${String(i).padStart(2, "0")}`;
    index.push({ slug, title: `R${i}`, type: "response", questions: [], date: "2026-12" });
    edges.push({ from: slug, to: SLUG, relation: "responds-to" });
    lines.push(`2026-12-${String(1 + (i % 28)).padStart(2, "0")} merge posts/${slug}.md by editor-1: fine`);
  }
  const files = { ...FILES, "/index.json": index, "/graph.json": { nodes: [], edges }, "/moderation/log.md": lines.join("\n") };
  const data = await (await get(seeded(), files, PULL, t)).json();
  assert.equal(data.responses.length, 50);
  assert.equal(data.responses[0].slug, "2026/12/r55"); // 2026-12-28, the later of the two that day
  assert.equal(data.responses[1].slug, "2026/12/r27");
});

test("a merged post that is not in the index at the receipt's path has no `published`, and a note says so", async (t) => {
  const data = await assertApiJson(assert, await get(seeded("posts/2026/11/moved-elsewhere.md"), FILES, PULL, t), 200);
  assert.equal(data.state, "merged");
  assert.equal(data.published, undefined);
  assert.equal(data.responses, undefined);
  assert.match(data.note, /not in our index at the receipt's path/);
  assert.match(data.note, /\/api\/search/);
});

test("when the site's own files cannot be read, the merged state still comes back with a note", async (t) => {
  for (const files of [undefined, { "/index.json": INDEX }]) {
    resetSiteCache();
    const data = await assertApiJson(assert, await get(seeded(), files, PULL, t), 200);
    assert.equal(data.state, "merged");
    assert.equal(data.published, undefined);
    assert.match(data.note, /could not be read/);
  }
});

test("a submission that is not merged has neither field and reads no site file", async (t) => {
  const assets = fakeAssets(FILES);
  stubFetch(t, (url) => githubJson(url.includes("/pulls?") ? [{ ...PULL, merged_at: null, state: "open" }] : []));
  const res = await onRequest(fakeContext({ url: `https://ourowncause.com/api/status/${ID}`, params: { id: ID },
    env: { DB: seeded(), ASSETS: assets } }));
  const data = await res.json();
  assert.equal(data.state, "open");
  assert.ok(!("published" in data) && !("responses" in data));
  assert.deepEqual(assets.fetched, []);
});
