import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/_middleware.js";
import { addHit, FLUSH_COUNT, FLUSH_MS, resetHits } from "../functions/_lib/hits.js";
import { brokenD1, fakeContext, fakeD1, MIGRATIONS } from "./helpers.mjs";

beforeEach(resetHits);

const rows = (db) => db.sqlite.prepare("SELECT * FROM hits ORDER BY path_class, agent, status").all()
  .map((r) => ({ ...r }));
const today = () => new Date().toISOString().slice(0, 10);

async function request(env, { url = "https://ourowncause.com/", headers = {}, status = 200 } = {}) {
  const ctx = fakeContext({ url, headers, env, next: async () => new Response("static", { status }) });
  const response = await onRequest(ctx);
  await ctx.settled();
  return { response, ctx };
}

test("counts live in their own database: STATS has only hits, DB has no hits", () => {
  const tables = (db) => db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((r) => r.name);
  assert.deepEqual(tables(fakeD1("stats")), ["hits"]);
  assert.deepEqual(tables(fakeD1("main")), ["challenges", "ratelimit", "settings", "status_cache", "submissions"]);
  assert.ok(!/\bhits\b/.test(readFileSync(MIGRATIONS.main, "utf8").replace(/^--.*$/gm, "")));
});

test("the first request in an isolate is written at once, by day, path class, agent and status", async () => {
  const STATS = fakeD1("stats");
  const { response } = await request({ STATS }, {
    url: "https://ourowncause.com/llms.txt?secret=query", headers: { "user-agent": "ClaudeBot/1.0" } });
  assert.equal(await response.text(), "static");
  assert.deepEqual(rows(STATS), [{ day: today(), path_class: "llms", agent: "claude", status: 200, n: 1 }]);
});

test("after that, counts wait in memory and are written 50 at a time in one statement", async () => {
  const STATS = fakeD1("stats");
  await request({ STATS });
  assert.equal(STATS.writes(), 1);
  for (let i = 0; i < FLUSH_COUNT - 1; i++) {
    await request({ STATS }, { url: "https://ourowncause.com/api/search?q=x", headers: { "user-agent": "curl/8" } });
  }
  assert.equal(STATS.writes(), 1, "49 more requests write nothing");
  await request({ STATS }, { url: "https://ourowncause.com/nope", status: 404 });
  assert.equal(STATS.writes(), 2, "the 50th pending count flushes all 50 in one statement");
  assert.deepEqual(rows(STATS).map((r) => [r.path_class, r.agent, r.status, r.n]),
    [["api", "other-bot", 200, 49], ["other", "unknown", 200, 1], ["other", "unknown", 404, 1]]);
});

test("a flood of requests costs one write per 50, and none of them touch DB", async () => {
  const STATS = fakeD1("stats");
  const DB = { prepare: () => { throw new Error("the middleware must not use DB"); } };
  for (let i = 0; i < 1001; i++) await request({ STATS, DB });
  assert.equal(STATS.writes(), 21);
  assert.equal(rows(STATS)[0].n, 1001);
});

test("pending counts are written once 60 seconds have passed since the last write", () => {
  const hit = { day: "2026-11-23", pathClass: "llms", agent: "claude", status: 200 };
  const t0 = 1_800_000_000_000;
  assert.deepEqual(addHit(hit, t0), [{ ...hit, n: 1 }], "first hit flushes");
  assert.equal(addHit(hit, t0 + 1), null);
  assert.equal(addHit({ ...hit, status: 304 }, t0 + FLUSH_MS - 1), null);
  assert.deepEqual(addHit(hit, t0 + FLUSH_MS), [{ ...hit, n: 2 }, { ...hit, status: 304, n: 1 }]);
  assert.equal(addHit(hit, t0 + FLUSH_MS + 1), null, "the clock restarts after a flush");
});

test("repeat writes add to the stored count", async () => {
  const STATS = fakeD1("stats");
  for (let i = 0; i < 1 + 2 * FLUSH_COUNT; i++) await request({ STATS });
  assert.deepEqual(rows(STATS).map((r) => r.n), [101]);
});

test("a batch with more than 20 distinct rows is written in full", async () => {
  const STATS = fakeD1("stats");
  await request({ STATS });
  for (let i = 0; i < FLUSH_COUNT; i++) await request({ STATS }, { status: 400 + i });
  assert.equal(rows(STATS).reduce((sum, r) => sum + r.n, 0), 51);
  assert.equal(rows(STATS).length, 51);
});

test("nothing personal is stored: no IP, no user agent, no query string", async () => {
  const STATS = fakeD1("stats");
  await request({ STATS }, {
    url: "https://ourowncause.com/posts/2026/11/x.md?token=SECRETQUERY",
    headers: { "user-agent": "Mozilla/5.0 UNIQUEUA", "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "203.0.113.9" },
  });
  const stored = JSON.stringify(rows(STATS));
  for (const secret of ["203.0.113.9", "UNIQUEUA", "SECRETQUERY", "2026/11/x"]) {
    assert.ok(!stored.includes(secret), secret);
  }
  assert.deepEqual(Object.keys(rows(STATS)[0]).sort(), ["agent", "day", "n", "path_class", "status"]);
});

test("the response is returned before the write finishes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const STATS = { prepare: () => ({ bind: () => ({ run: () => gate }) }) };
  const ctx = fakeContext({ env: { STATS } });
  const response = await onRequest(ctx);
  assert.equal(response.status, 200);
  assert.equal(ctx.pending.length, 1);
  release();
  await ctx.settled();
});

test("a D1 outage never breaks static serving, and failed counts are dropped, not kept", async () => {
  for (let i = 0; i < 500; i++) {
    const { response, ctx } = await request({ STATS: brokenD1() }, { url: "https://ourowncause.com/posts/a.md" });
    assert.equal(await response.text(), "static");
    assert.ok((await ctx.settled()).every((r) => r.status === "fulfilled"), "logging must not reject");
  }
  const STATS = fakeD1("stats");
  for (let i = 0; i < FLUSH_COUNT; i++) await request({ STATS });
  assert.ok(rows(STATS).reduce((sum, r) => sum + r.n, 0) < 2 * FLUSH_COUNT, "no backlog from the outage");
});

test("a binding that throws synchronously never breaks static serving", async () => {
  const STATS = { prepare: () => { throw new Error("boom"); } };
  const { response, ctx } = await request({ STATS });
  assert.equal(response.status, 200);
  assert.ok((await ctx.settled()).every((r) => r.status === "fulfilled"));
});

test("a missing STATS binding or a broken waitUntil is skipped quietly", async () => {
  const { response, ctx } = await request({});
  assert.equal(response.status, 200);
  assert.equal(ctx.pending.length, 0);

  const odd = fakeContext({ env: { STATS: fakeD1("stats") } });
  odd.waitUntil = () => { throw new Error("no waitUntil"); };
  assert.equal((await onRequest(odd)).status, 200);
});
