import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../api/stats.js";
import { assertApiJson, brokenD1, fakeContext, fakeD1 } from "./helpers.mjs";

const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

function seeded() {
  const DB = fakeD1();
  const insert = DB.sqlite.prepare("INSERT INTO hits VALUES (?, ?, ?, ?, ?)");
  insert.run(day(0), "llms", "claude", 200, 5);
  insert.run(day(0), "llms", "claude", 304, 2);
  insert.run(day(0), "api", "openai", 200, 1);
  insert.run(day(3), "post-md", "claude", 200, 4);
  insert.run(day(40), "llms", "browser", 200, 9);
  return DB;
}

const get = (query, env) => onRequest(fakeContext({ url: `https://ourowncause.com/api/stats${query}`, env }));

test("stats returns aggregate counts for the last 30 days by default", async () => {
  const data = await assertApiJson(assert, await get("", { DB: seeded() }), 200);
  assert.equal(data.days, 30);
  assert.equal(data.since, day(29));
  assert.deepEqual(data.rows, [
    { day: day(0), path_class: "api", agent: "openai", n: 1 },
    { day: day(0), path_class: "llms", agent: "claude", n: 7 },
    { day: day(3), path_class: "post-md", agent: "claude", n: 4 },
  ]);
});

test("days narrows and widens the window", async () => {
  const one = await assertApiJson(assert, await get("?days=1", { DB: seeded() }), 200);
  assert.deepEqual(one.rows.map((r) => r.day), [day(0), day(0)]);
  const all = await assertApiJson(assert, await get("?days=90", { DB: seeded() }), 200);
  assert.equal(all.rows.length, 4);
});

test("days outside 1 to 90 or not a whole number is a 400", async () => {
  for (const bad of ["0", "91", "-1", "abc", "1.5", "", "1e1", "9".repeat(400)]) {
    const data = await assertApiJson(assert, await get(`?days=${bad}`, { DB: seeded() }), 400);
    assert.match(data.error, /days/);
  }
});

test("a D1 outage or a missing binding is a 503 with a retry hint", async () => {
  for (const env of [{ DB: brokenD1() }, {}]) {
    const response = await get("", env);
    const data = await assertApiJson(assert, response, 503);
    assert.equal(data.retry_after_seconds, 60);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.ok(!JSON.stringify(data).includes("D1_ERROR"));
  }
});

test("stats is read-only: other methods are refused", async () => {
  const ctx = fakeContext({ url: "https://ourowncause.com/api/stats", method: "POST", body: "{}",
    env: { DB: seeded() } });
  const response = await onRequest(ctx);
  await assertApiJson(assert, response, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
