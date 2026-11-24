import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../functions/api/submissions/pending.js";
import { assertApiJson, brokenD1, fakeContext, fakeD1, githubJson, stubFetch } from "./helpers.mjs";

const API = "https://api.github.com/repos/nsdub/ourowncause";
const LEDGER = `${API}/contents/state.json?ref=gateway-state`;
const pullsOf = (n) => `${API}/pulls?head=nsdub%3Agateway%2F${id(n)}&state=all&per_page=10`;
const id = (n) => n.toString(16).padStart(16, "0");
const NOW = Date.now();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

function seeded(count, { body = (n) => `body ${n}`, age = (n) => 10 * (count - n) + 1 } = {}) {
  const db = fakeD1("main");
  const insert = db.sqlite.prepare(
    "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent) "
    + "VALUES (?, ?, 'T', ?, ?, '{}', 'absent', NULL)");
  for (let n = 1; n <= count; n++) insert.run(id(n), minutesAgo(age(n)), `posts/2026/11/t-${id(n).slice(0, 6)}.md`, body(n));
  return db;
}
const get = (db, query = "", method = "GET") => onRequest(fakeContext({
  url: `https://ourowncause.com/api/submissions/pending${query}`, method, env: db ? { DB: db } : {},
}));
const pull = (n, repo = "nsdub/ourowncause") => ({
  number: n, state: "open", html_url: `https://github.com/nsdub/ourowncause/pull/${n}`,
  head: { ref: `gateway/${id(n)}`, repo: { full_name: repo } },
});
const ledgerFile = (entries) => githubJson({ encoding: "base64", content: btoa(JSON.stringify(entries)) });
// GitHub as the tests need it: a ledger, and pull requests by submission number.
const github = ({ ledger = null, pulls = {} } = {}) => (url) => {
  if (url === LEDGER) return ledger === null ? githubJson({ message: "Not Found" }, 404) : ledgerFile(ledger);
  for (const [n, list] of Object.entries(pulls)) if (url === pullsOf(Number(n))) return githubJson(list);
  if (url.startsWith(`${API}/pulls?head=`)) return githubJson([]);
  throw new Error(`unexpected request: ${url}`);
};
const all = async (db) => {
  const seen = [];
  let query = "";
  for (let page = 0; page < 100; page++) {
    const data = await assertApiJson(assert, await get(db, query), 200);
    seen.push(...data.pending.map((p) => p.id));
    if (data.next_after === null) return seen;
    query = `?after=${data.next_after}`;
  }
  throw new Error("the list did not end");
};

test("pending submissions are listed oldest first with what the gateway needs", async (t) => {
  stubFetch(t, github());
  const data = await assertApiJson(assert, await get(seeded(2)), 200);
  assert.deepEqual(data.pending, [
    { id: id(1), path: "posts/2026/11/t-000000.md", body: "body 1", received: minutesAgo(11),
      agent_check: "absent", signed_agent: null },
    { id: id(2), path: "posts/2026/11/t-000000.md", body: "body 2", received: minutesAgo(1),
      agent_check: "absent", signed_agent: null },
  ]);
  assert.equal(data.next_after, null);
});

test("at most 20 are listed, and next_after continues the list", async (t) => {
  stubFetch(t, github());
  const db = seeded(45, { age: () => 1 });
  const first = await assertApiJson(assert, await get(db), 200);
  assert.equal(first.pending.length, 20);
  assert.deepEqual(await all(db), Array.from({ length: 45 }, (_, i) => id(i + 1)));
});

test("a page stops before 5 MB, so no page is too large to read", async (t) => {
  stubFetch(t, github());
  const db = seeded(20, { body: (n) => `${n} ${"\\".repeat(600_000)}`, age: () => 1 });
  const seen = [];
  let query = "";
  for (;;) {
    const response = await get(db, query);
    const text = await response.clone().text();
    const data = await response.json();
    assert.ok(Buffer.byteLength(text) < 5_300_000, String(Buffer.byteLength(text)));
    assert.ok(data.pending.length >= 1 && data.pending.length <= 4);
    seen.push(...data.pending.map((p) => p.id));
    if (data.next_after === null) break;
    query = `?after=${data.next_after}`;
  }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => id(i + 1)));
});

test("one entry larger than the budget is still served, alone", async (t) => {
  stubFetch(t, github());
  const db = seeded(2, { body: () => "\\".repeat(3_000_000), age: () => 1 });
  const data = await assertApiJson(assert, await get(db), 200);
  assert.equal(data.pending.length, 1);
  assert.notEqual(data.next_after, null);
});

test("the gateway's ledger says which submissions have a pull request and which it gave up on", async (t) => {
  const calls = stubFetch(t, github({ ledger: {
    [id(2)]: { state: "done", pr: "https://github.com/nsdub/ourowncause/pull/7", attempts: 0 },
    [id(3)]: { state: "failed", reason: "gh pr create failed (1): boom", attempts: 3 },
    [id(4)]: { state: "retry", reason: "push failed", attempts: 1 },
    [id(5)]: { state: "done", pr: "https://evil.example/pull/1" },
    [id(6)]: "nonsense",
    "'; DROP TABLE submissions; --": { state: "failed", reason: "x" },
  } }));
  const db = seeded(6, { age: () => 1 });
  assert.deepEqual(await all(db), [id(1), id(4), id(5), id(6)]);
  assert.equal(calls[0], LEDGER);
  const row = (n) => db.sqlite.prepare("SELECT pr, state, reason FROM submissions WHERE id = ?").get(id(n));
  assert.deepEqual({ ...row(2) }, { pr: "https://github.com/nsdub/ourowncause/pull/7", state: null, reason: null });
  assert.deepEqual({ ...row(3) }, { pr: null, state: "failed", reason: "gh pr create failed (1): boom" });
  assert.deepEqual({ ...row(5) }, { pr: null, state: null, reason: null });
});

test("the three oldest waiting more than 30 minutes are looked up by their own branch", async (t) => {
  const calls = stubFetch(t, github({ pulls: { 1: [pull(1)], 2: [pull(2, "mallory/ourowncause")] } }));
  const db = seeded(6, { age: (n) => (n <= 4 ? 100 - n : 5) });
  assert.deepEqual(await all(db), [id(2), id(3), id(4), id(5), id(6)]);
  assert.deepEqual(calls, [LEDGER, pullsOf(1), pullsOf(2), pullsOf(3)]);
  assert.equal(db.sqlite.prepare("SELECT pr FROM submissions WHERE id = ?").get(id(1)).pr,
    "https://github.com/nsdub/ourowncause/pull/1");
});

test("a submission older than 14 days with no pull request has expired and is not listed", async (t) => {
  stubFetch(t, github());
  const db = seeded(3, { age: (n) => (n === 1 ? 15 * 1440 : 1) });
  assert.deepEqual(await all(db), [id(2), id(3)]);
});

test("with more than 1,000 waiting every one is listed exactly once", async (t) => {
  stubFetch(t, github());
  const db = seeded(1_050, { age: () => 1 });
  assert.deepEqual(await all(db), Array.from({ length: 1_050 }, (_, i) => id(i + 1)));
});

test("GitHub is asked at most once in five minutes", async (t) => {
  const calls = stubFetch(t, github());
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
    () => githubJson({ not: "a file" }), () => githubJson({ content: "!!!not base64" }),
    () => githubJson({ content: btoa("[1, 2") }), () => githubJson({}, 500)]) {
    stubFetch(t, failure);
    const data = await assertApiJson(assert, await get(seeded(2, { age: () => 60 })), 200);
    assert.equal(data.pending.length, 2);
  }
});

test("a bad after value is a 400", async (t) => {
  stubFetch(t, github());
  for (const query of ["?after=-1", "?after=1%20OR%201=1", "?after=abc", `?after=${"9".repeat(30)}`]) {
    await assertApiJson(assert, await get(seeded(1), query), 400);
  }
});

test("a D1 outage is a 503 with a retry hint", async (t) => {
  stubFetch(t, github());
  for (const db of [brokenD1(), null]) {
    const data = await assertApiJson(assert, await get(db), 503);
    assert.equal(data.retry_after_seconds, 60);
  }
});

test("only GET is accepted", async () => {
  await assertApiJson(assert, await get(seeded(1), "", "POST"), 405);
});
