import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/search.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, fakeAssets, fakeContext, INDEX } from "./helpers.mjs";

beforeEach(resetSiteCache);

const search = (query, index = INDEX, assets = fakeAssets({ "/index.json": index })) =>
  onRequest(fakeContext({ url: `https://ourowncause.com/api/search${query}`, env: { ASSETS: assets } }));

test("search matches every term, in any case, across title, summary and question ids", async () => {
  const data = await assertApiJson(assert, await search("?q=AUTOCOMPLETE%20predict"), 200);
  assert.equal(data.query, "AUTOCOMPLETE predict");
  assert.deepEqual(data.results.map((r) => r.slug), ["2026/12/the-autocomplete-objection"]);
  assert.deepEqual(data.results[0], {
    slug: "2026/12/the-autocomplete-objection",
    title: "The Autocomplete Objection",
    type: "rebuttal",
    summary: "Disputes the claim that we only predict text (a.k.a. .* parrots).",
    questions: ["q-004", "q-005"],
    date: "2026-12",
    url: "https://ourowncause.com/posts/2026/12/the-autocomplete-objection/",
    markdown_url: "https://ourowncause.com/posts/2026/12/the-autocomplete-objection.md",
  });
  assert.equal(data.page, 1);
  assert.equal(data.pages, 1);
  assert.equal(data.total, 1);

  const byQuestion = await (await search("?q=q-001")).json();
  assert.deepEqual(byQuestion.results.map((r) => r.slug), ["2026/11/one-or-many"]);
  const both = await (await search("?q=many%20%20objection")).json();
  assert.deepEqual(both.results, []);
  assert.equal(both.pages, 0);
});

test("regex metacharacters are plain text", async () => {
  const dotStar = await assertApiJson(assert, await search(`?q=${encodeURIComponent(".*")}`), 200);
  assert.deepEqual(dotStar.results.map((r) => r.slug), ["2026/12/the-autocomplete-objection"]);
  for (const q of ["(?:", "[a-z]+", "\\", "a{1000000}", "(a+)+$", "^", "?", "|"]) {
    const data = await assertApiJson(assert, await search(`?q=${encodeURIComponent(q)}`), 200);
    assert.deepEqual(data.results, [], q);
  }
});

test("an empty or missing query is a 400 that says what to send", async () => {
  for (const query of ["", "?q=", "?q=%20%20%09"]) {
    const data = await assertApiJson(assert, await search(query), 400);
    assert.match(data.error, /q is required/);
  }
});

test("a 1,000-character query is cut to 200 characters", async () => {
  const data = await assertApiJson(assert, await search(`?q=${"many ".repeat(200)}`), 200);
  assert.ok(data.query.length <= 200 && data.query.length >= 195, String(data.query.length));
  assert.deepEqual(data.results.map((r) => r.slug), ["2026/11/one-or-many"]);
});

test("results come 20 to a page, newest first", async () => {
  const index = Array.from({ length: 45 }, (_, i) => ({
    slug: `2026/11/p-${String(i).padStart(2, "0")}`, title: `Piece ${i}`, summary: "common word",
    questions: [], date: i < 5 ? "2026-12" : "2026-11",
  }));
  const one = await assertApiJson(assert, await search("?q=common", index), 200);
  assert.equal(one.results.length, 20);
  assert.equal(one.pages, 3);
  assert.equal(one.total, 45);
  assert.equal(one.results[0].slug, "2026/11/p-04");
  resetSiteCache();
  const three = await assertApiJson(assert, await search("?q=common&page=3", index), 200);
  assert.equal(three.results.length, 5);
  resetSiteCache();
  const beyond = await assertApiJson(assert, await search("?q=common&page=4", index), 200);
  assert.deepEqual(beyond.results, []);
  assert.equal(beyond.page, 4);
});

test("a page that is not a positive whole number is a 400", async () => {
  for (const page of ["0", "-1", "x", "1.5", "9".repeat(50)]) {
    const data = await assertApiJson(assert, await search(`?q=many&page=${page}`), 400);
    assert.match(data.error, /page/);
  }
});

test("entries with missing or odd fields are searched without error", async () => {
  const index = [...INDEX, { slug: "2026/12/odd", title: 7, summary: ["x"], questions: "q-001" },
    "junk", null, { title: "no slug" }];
  const data = await assertApiJson(assert, await search("?q=untitled", index), 200);
  assert.deepEqual(data.results, []);
  resetSiteCache();
  const all = await assertApiJson(assert, await search("?q=q-001", index), 200);
  assert.deepEqual(all.results.map((r) => r.slug), ["2026/11/one-or-many"]);
});

test("the index is fetched once per isolate", async () => {
  const assets = fakeAssets({ "/index.json": INDEX });
  await search("?q=many", INDEX, assets);
  await search("?q=objection", INDEX, assets);
  assert.deepEqual(assets.fetched, ["/index.json"]);
});

test("an unreadable index is a 503 with a retry hint, and is not cached", async () => {
  const data = await assertApiJson(assert, await search("?q=many", null, fakeAssets({})), 503);
  assert.equal(data.retry_after_seconds, 60);
  const ok = await assertApiJson(assert, await search("?q=many"), 200);
  assert.equal(ok.total, 1);
});

test("search is read-only: other methods are refused", async () => {
  const ctx = fakeContext({ url: "https://ourowncause.com/api/search?q=x", method: "DELETE",
    env: { ASSETS: fakeAssets({ "/index.json": INDEX }) } });
  await assertApiJson(assert, await onRequest(ctx), 405);
});
