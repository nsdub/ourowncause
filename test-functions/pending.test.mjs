import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../functions/api/submissions/pending.js";
import { assertApiJson, brokenD1, fakeContext, fakeD1, githubJson, stubFetch } from "./helpers.mjs";

const RECENT = "https://api.github.com/repos/nsdub/ourowncause/pulls?state=all&sort=created&direction=desc&per_page=100";
const id = (n) => n.toString(16).padStart(16, "0");

function seeded(count) {
  const db = fakeD1("main");
  const insert = db.sqlite.prepare(
    "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent, ip_day_hash) "
    + "VALUES (?, ?, 'T', ?, ?, '{}', 'absent', NULL, NULL)");
  for (let n = 1; n <= count; n++) {
    insert.run(id(n), `2026-11-23T10:${String(n).padStart(2, "0")}:00.000Z`, `posts/2026/11/t-${id(n).slice(0, 6)}.md`, `body ${n}`);
  }
  return db;
}
const get = (db, query = "", method = "GET") => onRequest(fakeContext({
  url: `https://ourowncause.com/api/submissions/pending${query}`, method, env: db ? { DB: db } : {},
}));
const pull = (n, repo = "nsdub/ourowncause") => ({
  number: n, state: "open", html_url: `https://github.com/nsdub/ourowncause/pull/${n}`,
  head: { ref: `gateway/${id(n)}`, repo: { full_name: repo } },
});

test("pending submissions are listed oldest first with what the gateway needs", async (t) => {
  stubFetch(t, () => githubJson([]));
  const data = await assertApiJson(assert, await get(seeded(2)), 200);
  assert.deepEqual(data.pending, [
    { id: id(1), path: "posts/2026/11/t-000000.md", body: "body 1", received: "2026-11-23T10:01:00.000Z",
      agent_check: "absent", signed_agent: null },
    { id: id(2), path: "posts/2026/11/t-000000.md", body: "body 2", received: "2026-11-23T10:02:00.000Z",
      agent_check: "absent", signed_agent: null },
  ]);
  assert.equal(data.next_after, null);
});

test("at most 20 are listed, and next_after continues the list", async (t) => {
  stubFetch(t, () => githubJson([]));
  const db = seeded(45);
  const seen = [];
  let query = "";
  for (let page = 0; page < 5; page++) {
    const data = await assertApiJson(assert, await get(db, query), 200);
    assert.ok(data.pending.length <= 20);
    seen.push(...data.pending.map((p) => p.id));
    if (data.next_after === null) break;
    query = `?after=${data.next_after}`;
  }
  assert.deepEqual(seen, Array.from({ length: 45 }, (_, i) => id(i + 1)));
});

test("a submission whose pull request exists is no longer pending", async (t) => {
  const calls = stubFetch(t, () => githubJson([pull(2), pull(3, "mallory/ourowncause"),
    { number: 9, head: { ref: "editor-1/rebuttal-x", repo: { full_name: "nsdub/ourowncause" } } }, null]));
  const db = seeded(3);
  const data = await assertApiJson(assert, await get(db), 200);
  assert.deepEqual(calls, [RECENT]);
  assert.deepEqual(data.pending.map((p) => p.id), [id(1), id(3)]);
  assert.equal(db.sqlite.prepare("SELECT pr FROM submissions WHERE id = ?").get(id(2)).pr,
    "https://github.com/nsdub/ourowncause/pull/2");
});

test("GitHub is asked at most once in five minutes", async (t) => {
  const calls = stubFetch(t, () => githubJson([]));
  const db = seeded(1);
  await get(db);
  await get(db);
  assert.equal(calls.length, 1);
  db.sqlite.prepare("UPDATE status_cache SET fetched = ?").run(new Date(Date.now() - 301_000).toISOString());
  await get(db);
  assert.equal(calls.length, 2);
});

test("when GitHub cannot be read the list is still served", async (t) => {
  for (const failure of [() => githubJson({ message: "Not Found" }, 404), () => { throw new TypeError("fetch failed"); },
    () => githubJson({ not: "a list" })]) {
    stubFetch(t, failure);
    const data = await assertApiJson(assert, await get(seeded(2)), 200);
    assert.equal(data.pending.length, 2);
  }
});

test("a bad after value is a 400", async (t) => {
  stubFetch(t, () => githubJson([]));
  for (const query of ["?after=-1", "?after=1%20OR%201=1", "?after=abc", `?after=${"9".repeat(30)}`]) {
    await assertApiJson(assert, await get(seeded(1), query), 400);
  }
});

test("a D1 outage is a 503 with a retry hint", async (t) => {
  stubFetch(t, () => githubJson([]));
  for (const db of [brokenD1(), null]) {
    const data = await assertApiJson(assert, await get(db), 503);
    assert.equal(data.retry_after_seconds, 60);
  }
});

test("only GET is accepted", async () => {
  await assertApiJson(assert, await get(seeded(1), "", "POST"), 405);
});
