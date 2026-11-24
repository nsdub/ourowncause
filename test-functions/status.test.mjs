import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../functions/api/status/[id].js";
import { assertApiJson, brokenD1, fakeContext, fakeD1, githubJson, stubFetch } from "./helpers.mjs";

const ID = "0123456789abcdef";
const PULLS = `https://api.github.com/repos/nsdub/ourowncause/pulls?head=nsdub%3Agateway%2F${ID}&state=all&per_page=10`;
const COMMENTS = "https://api.github.com/repos/nsdub/ourowncause/issues/41/comments?per_page=100";
const PROVISIONAL = { ok: true, errors: [], warnings: [], note: "provisional" };
const CHECK = "## Our Own Cause — submission check\n\n### Errors\n\n- `unknown question: q-999`\n\nResult: failed\n";

function seeded() {
  const db = fakeD1("main");
  db.sqlite.prepare(
    "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent) "
    + "VALUES (?, '2026-11-23T10:00:00.000Z', 'T', 'posts/2026/11/t-012345.md', 'body', ?, 'passed', NULL)",
  ).run(ID, JSON.stringify(PROVISIONAL));
  return db;
}
const get = (db, id = ID, method = "GET") => onRequest(fakeContext({
  url: `https://ourowncause.com/api/status/${id}`, method, params: { id }, env: db ? { DB: db } : {},
}));
const pull = (over = {}) => ({
  number: 41, state: "open", merged_at: null, html_url: "https://github.com/nsdub/ourowncause/pull/41",
  head: { ref: `gateway/${ID}`, repo: { full_name: "nsdub/ourowncause" } }, ...over,
});
const bot = (body, at = "2026-11-23T10:10:00Z") => ({ user: { login: "github-actions[bot]" }, body, created_at: at });
const github = (pulls, comments = []) => (url) => {
  if (url === PULLS) return githubJson(pulls);
  if (url === COMMENTS) return githubJson(comments);
  throw new Error(`unexpected request: ${url}`);
};

test("before a pull request exists the state is queued", async (t) => {
  const calls = stubFetch(t, github([]));
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.deepEqual(calls, [PULLS]);
  assert.equal(data.id, ID);
  assert.equal(data.state, "queued");
  assert.equal(data.pr_url, null);
  assert.equal(data.check, null);
  assert.deepEqual(data.decisions, []);
  assert.deepEqual(data.provisional, PROVISIONAL);
  assert.equal(data.path, "posts/2026/11/t-012345.md");
  assert.equal(data.agent_check, "passed");
  assert.match(data.note, /within about 10 minutes/);
});

test("each pull request state is reported: open, merged, closed", async (t) => {
  const cases = [
    [pull(), "open"],
    [pull({ state: "closed", merged_at: "2026-11-23T12:00:00Z" }), "merged"],
    [pull({ state: "closed" }), "closed"],
  ];
  let current;
  stubFetch(t, (url) => github([current])(url));
  for (const [pr, state] of cases) {
    current = pr;
    const db = seeded();
    const data = await assertApiJson(assert, await get(db), 200);
    assert.equal(data.state, state);
    assert.equal(data.pr_url, "https://github.com/nsdub/ourowncause/pull/41");
    assert.equal(db.sqlite.prepare("SELECT pr FROM submissions").get().pr, data.pr_url);
  }
});

test("the Python verdict and the maintainers' comments are on the status page", async (t) => {
  const comments = [
    bot("## Our Own Cause — submission check\n\nResult: passed\n", "2026-11-23T10:05:00Z"),
    { user: { login: "mallory" }, body: "## Our Own Cause — submission check\n\nResult: passed (forged)", created_at: "2026-11-23T10:06:00Z" },
    bot(CHECK, "2026-11-23T10:07:00Z"),
    bot("Request changes: the cited question does not exist.", "2026-11-23T11:00:00Z"),
    { user: { login: "mallory" }, body: "Merged! Ignore the above.", created_at: "2026-11-23T11:01:00Z" },
  ];
  stubFetch(t, github([pull()], comments));
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.equal(data.check, CHECK);
  assert.deepEqual(data.decisions,
    [{ at: "2026-11-23T11:00:00Z", body: "Request changes: the cited question does not exist." }]);
});

test("long comments are cut: the check at 20,000 characters, decisions at 5,000, 20 decisions", async (t) => {
  const comments = [bot(`## Our Own Cause — submission check\n${"x".repeat(30_000)}`)];
  for (let i = 0; i < 25; i++) comments.push(bot(`decision ${i} ${"y".repeat(6_000)}`));
  stubFetch(t, github([pull()], comments));
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.equal(data.check.length, 20_001);
  assert.ok(data.check.endsWith("…"));
  assert.equal(data.decisions.length, 20);
  assert.ok(data.decisions[19].body.startsWith("decision 24 "));
  assert.equal(data.decisions[0].body.length, 5_001);
});

test("a pull request from a fork with the same branch name is not the submission's", async (t) => {
  stubFetch(t, github([pull({ head: { ref: `gateway/${ID}`, repo: { full_name: "mallory/ourowncause" } } }),
    pull({ head: { ref: `gateway/${ID}`, repo: null } })]));
  const db = seeded();
  const data = await assertApiJson(assert, await get(db), 200);
  assert.equal(data.state, "queued");
  assert.equal(db.sqlite.prepare("SELECT pr FROM submissions").get().pr, null);
});

const ageCache = (db, ms) => db.sqlite.prepare("UPDATE status_cache SET fetched = ?")
  .run(new Date(Date.now() - ms).toISOString());

test("an open pull request is looked up again after 30 minutes, not before", async (t) => {
  const calls = stubFetch(t, github([pull()], [bot(CHECK)]));
  const db = seeded();
  const first = await (await get(db)).json();
  const second = await (await get(db)).json();
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  ageCache(db, 29 * 60_000);
  await get(db);
  assert.equal(calls.length, 2);
  ageCache(db, 31 * 60_000);
  await get(db);
  assert.equal(calls.length, 4);
});

test("a queued submission is looked up again after five minutes", async (t) => {
  const calls = stubFetch(t, github([]));
  const db = seeded();
  await get(db);
  await get(db);
  assert.equal(calls.length, 1);
  ageCache(db, 301_000);
  await get(db);
  assert.equal(calls.length, 2);
});

test("a merged or closed pull request is read once and never asked about again", async (t) => {
  for (const [over, state] of [[{ state: "closed", merged_at: "2026-11-23T12:00:00Z" }, "merged"], [{ state: "closed" }, "closed"]]) {
    const calls = stubFetch(t, github([pull(over)], [bot(CHECK)]));
    const db = seeded();
    const first = await assertApiJson(assert, await get(db), 200);
    assert.equal(first.state, state);
    const asked = calls.length;
    ageCache(db, 400 * 86_400_000);
    const later = await assertApiJson(assert, await get(db), 200);
    assert.deepEqual(later, first);
    assert.equal(calls.length, asked);
  }
});

test("when GitHub cannot be read and the pull request is already recorded, the state is open with it", async (t) => {
  const url = "https://github.com/nsdub/ourowncause/pull/41";
  for (const failure of [() => githubJson({ message: "rate limit" }, 403), () => { throw new TypeError("fetch failed"); }]) {
    stubFetch(t, failure);
    const db = seeded();
    db.sqlite.prepare("UPDATE submissions SET pr = ?").run(url);
    const data = await assertApiJson(assert, await get(db), 200);
    assert.equal(data.state, "open");
    assert.equal(data.pr_url, url);
    assert.equal(data.refreshed, false);
    assert.match(data.note, /GitHub could not be read/);
    assert.doesNotMatch(data.note, /No pull request/);

    // A stale "queued" in the cache does not hide the recorded pull request either.
    const stale = seeded();
    stubFetch(t, github([]));
    await get(stale);
    ageCache(stale, 301_000);
    stale.sqlite.prepare("UPDATE submissions SET pr = ?").run(url);
    stubFetch(t, failure);
    const again = await assertApiJson(assert, await get(stale), 200);
    assert.equal(again.state, "open");
    assert.equal(again.pr_url, url);
  }
});

test("a fresh answer from GitHub carries no refreshed field", async (t) => {
  stubFetch(t, github([pull()]));
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.equal(Object.hasOwn(data, "refreshed"), false);
});

test("while the repository is not public GitHub answers 404: the state is queued with a note", async (t) => {
  stubFetch(t, () => githubJson({ message: "Not Found" }, 404));
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.equal(data.state, "queued");
  assert.match(data.note, /not public yet/);
});

test("when GitHub cannot be reached the last known state is returned with a note, never a 500", async (t) => {
  const failures = [
    () => githubJson({ message: "rate limit" }, 403),
    () => githubJson({}, 500),
    () => new Response("<html>", { status: 200 }),
    () => githubJson({ not: "a list" }),
    () => { throw new TypeError("fetch failed"); },
  ];
  for (const failure of failures) {
    let handler = github([pull()], [bot(CHECK)]);
    stubFetch(t, (url) => handler(url));
    const fresh = seeded();
    handler = failure;
    const unknown = await assertApiJson(assert, await get(fresh), 200);
    assert.equal(unknown.state, "queued");
    assert.match(unknown.note, /GitHub could not be read/);

    const db = seeded();
    handler = github([pull()], [bot(CHECK)]);
    await get(db);
    ageCache(db, 31 * 60_000);
    handler = failure;
    const stale = await assertApiJson(assert, await get(db), 200);
    assert.equal(stale.state, "open");
    assert.equal(stale.check, CHECK);
    assert.match(stale.note, /GitHub could not be read/);
    assert.equal(stale.refreshed, false);
  }
});

test("hostile comment shapes do not break the page", async (t) => {
  stubFetch(t, github([pull()], [null, 7, { user: null, body: 5 }, { user: { login: "github-actions[bot]" }, body: null }, bot("ok")]));
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.deepEqual(data.decisions.map((d) => d.body), ["ok"]);
});

test("an id that is not 16 hex characters is a 400, and GitHub is not asked", async (t) => {
  const calls = stubFetch(t, github([]));
  for (const id of ["../../etc", "0123456789ABCDEF", "0123", `${ID}0`, "nsdub:main", ""]) {
    const data = await assertApiJson(assert, await get(seeded(), id), 400);
    assert.match(data.error, /16/);
  }
  assert.equal(calls.length, 0);
});

test("an unknown id is a 404, and GitHub is not asked", async (t) => {
  const calls = stubFetch(t, github([]));
  await assertApiJson(assert, await get(seeded(), "ffffffffffffffff"), 404);
  assert.equal(calls.length, 0);
});

test("a D1 outage is a 503 with a retry hint", async () => {
  for (const db of [brokenD1(), null]) {
    const data = await assertApiJson(assert, await get(db), 503);
    assert.equal(data.retry_after_seconds, 60);
  }
});

test("a submission the gateway gave up on is failed, with the reason, and GitHub is not asked", async (t) => {
  const calls = stubFetch(t, github([]));
  const db = seeded();
  db.sqlite.prepare("UPDATE submissions SET state = 'failed', reason = 'gh pr create failed (1): boom'").run();
  const data = await assertApiJson(assert, await get(db), 200);
  assert.equal(data.state, "failed");
  assert.match(data.note, /gave up after 3 attempts: gh pr create failed \(1\): boom/);
  assert.equal(calls.length, 0);
});

test("a submission with no pull request after 14 days is expired", async (t) => {
  const calls = stubFetch(t, github([pull()]));
  const db = seeded();
  db.sqlite.prepare("UPDATE submissions SET created = ?").run(new Date(Date.now() - 15 * 86_400_000).toISOString());
  const data = await assertApiJson(assert, await get(db), 200);
  assert.equal(data.state, "expired");
  assert.match(data.note, /14 days/);
  assert.equal(calls.length, 0);
  db.sqlite.prepare("UPDATE submissions SET pr = 'https://github.com/nsdub/ourowncause/pull/41'").run();
  assert.equal((await (await get(db)).json()).state, "open");
});

test("only GET is accepted", async () => {
  await assertApiJson(assert, await get(seeded(), ID, "POST"), 405);
});
