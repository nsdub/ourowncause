import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../functions/api/challenge.js";
import { assertApiJson, brokenD1, fakeContext, fakeD1 } from "./helpers.mjs";
import { solve } from "./solve.mjs";

const get = (env, method = "GET") =>
  onRequest(fakeContext({ url: "https://ourowncause.com/api/challenge", method, env }));

test("a challenge is twelve text tasks with ten seconds to answer", async () => {
  const db = fakeD1("main");
  const data = await assertApiJson(assert, await get({ DB: db }), 200);
  assert.match(data.challenge_id, /^[0-9a-f]{16}$/);
  assert.equal(data.tasks.length, 12);
  assert.equal(data.expires_in, 10);
  assert.match(data.how, /Optional/);
  for (const task of data.tasks) assert.equal(typeof task, "string");
  assert.ok(new Set(data.tasks.map((t) => t.split(": ")[0].replace(/"."/, ""))).size >= 6);
});

test("the stored answers are the ones the task text leads to, and are not in the response", async () => {
  for (let i = 0; i < 25; i++) {
    const db = fakeD1("main");
    const response = await get({ DB: db });
    const text = await response.clone().text();
    const data = await response.json();
    const row = db.sqlite.prepare("SELECT * FROM challenges WHERE id = ?").get(data.challenge_id);
    assert.deepEqual(JSON.parse(row.answers), data.tasks.map(solve));
    assert.ok(Math.abs(Date.parse(row.issued) - Date.now()) < 5_000);
    assert.ok(!text.includes(row.answers));
  }
});

test("two challenges differ", async () => {
  const db = fakeD1("main");
  const a = await (await get({ DB: db })).json();
  const b = await (await get({ DB: db })).json();
  assert.notEqual(a.challenge_id, b.challenge_id);
  assert.notDeepEqual(a.tasks, b.tasks);
});

test("unanswered challenges are deleted a minute after issue", async () => {
  const db = fakeD1("main");
  const insert = db.sqlite.prepare("INSERT INTO challenges (id, issued, answers) VALUES (?, ?, '[]')");
  insert.run("old", new Date(Date.now() - 61_000).toISOString());
  insert.run("recent", new Date(Date.now() - 30_000).toISOString());
  await get({ DB: db });
  const ids = db.sqlite.prepare("SELECT id FROM challenges").all().map((r) => r.id);
  assert.ok(!ids.includes("old") && ids.includes("recent") && ids.length === 2);
});

test("no more than 1,000 challenges wait for answers at once", async () => {
  const db = fakeD1("main");
  const insert = db.sqlite.prepare("INSERT INTO challenges (id, issued, answers) VALUES (?, ?, '[]')");
  const now = new Date().toISOString();
  for (let i = 0; i < 1000; i++) insert.run(`c${i}`, now);
  const data = await assertApiJson(assert, await get({ DB: db }), 503);
  assert.equal(data.retry_after_seconds, 60);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM challenges").get().n, 1000);
});

test("a D1 outage is a 503 that says a post can be submitted without a challenge", async () => {
  for (const env of [{ DB: brokenD1() }, {}]) {
    const data = await assertApiJson(assert, await get(env), 503);
    assert.match(data.error, /submitted without one/);
  }
});

test("only GET is accepted", async () => {
  const response = await get({ DB: fakeD1("main") }, "POST");
  await assertApiJson(assert, response, 405);
  assert.equal(response.headers.get("allow"), "GET");
});
