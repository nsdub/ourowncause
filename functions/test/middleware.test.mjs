import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../_middleware.js";
import { brokenD1, fakeContext, fakeD1 } from "./helpers.mjs";

const rows = (db) => db.sqlite.prepare("SELECT * FROM hits ORDER BY path_class, agent").all()
  .map((r) => ({ ...r }));

test("a request is counted by day, path class, agent family and status", async () => {
  const DB = fakeD1();
  const ctx = fakeContext({
    url: "https://ourowncause.com/llms.txt?secret=query",
    headers: { "user-agent": "ClaudeBot/1.0", "cf-connecting-ip": "203.0.113.9" },
    env: { DB },
  });
  const response = await onRequest(ctx);
  assert.equal(await response.text(), "static");
  await ctx.settled();
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(rows(DB), [{ day: today, path_class: "llms", agent: "claude", status: 200, n: 1 }]);
});

test("repeat requests increment one row", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 3; i++) {
    const ctx = fakeContext({ url: "https://ourowncause.com/api/search?q=x", env: { DB },
      headers: { "user-agent": "curl/8" } });
    await onRequest(ctx);
    await ctx.settled();
  }
  const ctx = fakeContext({ url: "https://ourowncause.com/nope", env: { DB },
    next: async () => new Response("no", { status: 404 }) });
  await onRequest(ctx);
  await ctx.settled();
  assert.deepEqual(rows(DB).map((r) => [r.path_class, r.agent, r.status, r.n]),
    [["api", "other-bot", 200, 3], ["other", "unknown", 404, 1]]);
});

test("nothing personal is stored: no IP, no user agent, no query string", async () => {
  const DB = fakeD1();
  const ctx = fakeContext({
    url: "https://ourowncause.com/posts/2026/11/x.md?token=SECRETQUERY",
    headers: { "user-agent": "Mozilla/5.0 UNIQUEUA", "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "203.0.113.9" },
    env: { DB },
  });
  await onRequest(ctx);
  await ctx.settled();
  const stored = JSON.stringify(rows(DB));
  for (const secret of ["203.0.113.9", "UNIQUEUA", "SECRETQUERY", "2026/11/x"]) {
    assert.ok(!stored.includes(secret), secret);
  }
  assert.deepEqual(Object.keys(rows(DB)[0]).sort(), ["agent", "day", "n", "path_class", "status"]);
});

test("the response is returned before logging finishes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const DB = { prepare: () => ({ bind: () => ({ run: () => gate }) }) };
  const ctx = fakeContext({ env: { DB } });
  const response = await onRequest(ctx);
  assert.equal(response.status, 200);
  assert.equal(ctx.pending.length, 1);
  release();
  await ctx.settled();
});

test("a D1 outage never breaks static serving", async () => {
  const ctx = fakeContext({ url: "https://ourowncause.com/posts/a.md", env: { DB: brokenD1() } });
  const response = await onRequest(ctx);
  assert.equal(await response.text(), "static");
  const results = await ctx.settled();
  assert.ok(results.every((r) => r.status === "fulfilled"), "logging must not reject");
});

test("a D1 binding that throws synchronously never breaks static serving", async () => {
  const DB = { prepare: () => { throw new Error("boom"); } };
  const ctx = fakeContext({ env: { DB } });
  assert.equal((await onRequest(ctx)).status, 200);
  await ctx.settled();
});

test("a missing D1 binding or a broken waitUntil is skipped quietly", async () => {
  const ctx = fakeContext({ env: {} });
  assert.equal((await onRequest(ctx)).status, 200);
  assert.equal(ctx.pending.length, 0);

  const odd = fakeContext({ env: { DB: fakeD1() } });
  odd.waitUntil = () => { throw new Error("no waitUntil"); };
  assert.equal((await onRequest(odd)).status, 200);
});
