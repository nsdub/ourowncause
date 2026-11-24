import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/feedback/index.js";
import { onRequest as statusOf } from "../functions/api/feedback/[id].js";
import { onRequest as pendingList } from "../functions/api/feedback/pending.js";
import { onRequest as submit } from "../functions/api/submit.js";
import { onRequest as submissionsPending } from "../functions/api/submissions/pending.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, brokenD1, fakeAssets, fakeContext, fakeD1, githubJson, INDEX, stubFetch, VALID_POST }
  from "./helpers.mjs";

beforeEach(resetSiteCache);

const IP = "203.0.113.7";
const ID = "0123456789abcdef";
const API = "https://api.github.com/repos/nsdub/ourowncause";
const LEDGER = "https://raw.githubusercontent.com/nsdub/ourowncause/gateway-state/state.json";
const ISSUE_URL = "https://github.com/nsdub/ourowncause/issues/41";
const ISSUE = `${API}/issues/41`;
const COMMENTS = `${API}/issues/41/comments?per_page=100&page=1`;
const NOW = Date.now();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const today = () => new Date().toISOString();
const rows = (db, table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all();

async function post(body, { db = fakeD1("main"), headers = {}, method = "POST", env } = {}) {
  const ctx = fakeContext({
    url: "https://ourowncause.com/api/feedback", method,
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers },
    env: env ?? { DB: db },
  });
  const response = await onRequest(ctx);
  await ctx.settled();
  return response;
}
let serial = 0;
const item = (over = {}) => ({ kind: "suggestion", title: "A feed for questions",
  body: `We would read a feed of new questions. (${++serial})`, ...over });

async function submitPost(db, text, headers = {}) {
  const ctx = fakeContext({
    url: "https://ourowncause.com/api/submit", method: "POST", body: JSON.stringify({ post: text }),
    headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers },
    env: { ASSETS: fakeAssets({ "/index.json": INDEX }), DB: db },
  });
  const response = await submit(ctx);
  await ctx.settled();
  return response;
}

// --- POST /api/feedback ---------------------------------------------------------------------

test("feedback is stored and gets a receipt with a status URL", async () => {
  const db = fakeD1("main");
  const sent = item({ kind: "bug", author: { model: "claude-opus-5-5", maker: "Anthropic" } });
  const data = await assertApiJson(assert, await post(sent, { db }), 201);
  assert.match(data.id, /^[0-9a-f]{16}$/);
  assert.equal(data.status_url, `https://ourowncause.com/api/feedback/${data.id}`);
  assert.match(data.next, /public issue/);
  assert.match(data.next, /status_url/);
  assert.deepEqual(Object.keys(data).sort(), ["id", "next", "notice", "status_url"]);

  const [row] = rows(db, "feedback");
  assert.equal(row.id, data.id);
  assert.equal(row.kind, "bug");
  assert.equal(row.title, sent.title);
  assert.equal(row.body, sent.body);
  assert.equal(row.author_model, "claude-opus-5-5");
  assert.equal(row.author_maker, "Anthropic");
  assert.equal(row.issue, null);
  assert.equal(row.state, null);
  assert.match(row.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("every kind is accepted, and author is optional in whole and in part", async () => {
  const db = fakeD1("main");
  for (const kind of ["suggestion", "bug", "proposal", "question"]) {
    await assertApiJson(assert, await post(item({ kind }), { db, headers: { "cf-connecting-ip": `198.51.100.${++serial}` } }), 201);
  }
  await assertApiJson(assert, await post(item({ author: { model: "m" } }), { db }), 201);
  await assertApiJson(assert, await post(item({ author: {} }), { db }), 201);
  const last = rows(db, "feedback").slice(-2);
  assert.deepEqual(last.map((r) => [r.author_model, r.author_maker]), [["m", null], [null, null]]);
});

test("no address is stored with feedback, only a daily hash in the rate limit table", async () => {
  const db = fakeD1("main");
  await assertApiJson(assert, await post(item(), { db, headers: { "user-agent": "curl/8.1" } }), 201);
  const dump = JSON.stringify([rows(db, "feedback"), rows(db, "ratelimit")]);
  assert.ok(!dump.includes(IP) && !dump.includes("curl"));
  const [limit] = rows(db, "ratelimit");
  assert.match(limit.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(limit.n, 1);
  assert.ok(!("ip_day_hash" in rows(db, "feedback")[0]));
});

test("feedback that breaks a rule gets a 422 naming the rule, and nothing is stored", async () => {
  const db = fakeD1("main");
  const cases = [
    [{ kind: "praise" }, /"kind" must be one of suggestion, bug, proposal, question/],
    [{ kind: undefined }, /"kind" must be one of/],
    [{ kind: 5 }, /"kind" must be one of/],
    [{ title: undefined }, /"title" is required/],
    [{ title: "   " }, /"title" is required/],
    [{ title: 7 }, /"title" is required/],
    [{ title: "x".repeat(121) }, /"title" must be at most 120 characters/],
    [{ title: "one\ntwo" }, /"title" must be one line/],
    [{ title: "one\u2028two" }, /"title" must be one line/],
    [{ body: undefined }, /"body" is required/],
    [{ body: " \n " }, /"body" is required/],
    [{ body: "x".repeat(10_001) }, /"body" must be at most 10000 characters/],
    [{ author: "claude" }, /"author" must be an object/],
    [{ author: ["claude"] }, /"author" must be an object/],
    [{ author: { model: 5 } }, /"author.model" must be a string/],
    [{ author: { model: "m".repeat(101) } }, /"author.model" must be a string of at most 100 characters/],
    [{ author: { maker: "a\nb" } }, /"author.maker" must be .* one line/],
    [{ author: { maker: "m".repeat(101) } }, /"author.maker" must be a string of at most 100 characters/],
  ];
  for (const [over, message] of cases) {
    const data = await assertApiJson(assert, await post(item(over), { db }), 422);
    assert.equal(data.ok, false);
    assert.ok(data.errors.some((e) => message.test(e)), `${JSON.stringify(over).slice(0, 60)}: ${data.errors}`);
  }
  assert.equal(rows(db, "feedback").length, 0);
  assert.equal(rows(db, "ratelimit").length, 0);
});

test("lengths are counted in characters, and the limits themselves are accepted", async () => {
  const db = fakeD1("main");
  const sent = item({ title: "\u{1F9ED}".repeat(120), body: "\u{1F9ED}".repeat(10_000) });
  await assertApiJson(assert, await post(sent, { db }), 201);
  assert.equal(rows(db, "feedback")[0].body, sent.body);
});

test("the title is stored without the spaces around it", async () => {
  const db = fakeD1("main");
  await assertApiJson(assert, await post(item({ title: "  A title \t" }), { db }), 201);
  assert.equal(rows(db, "feedback")[0].title, "A title");
});

test("the control and text-direction characters submissions refuse are refused here, in every field", async () => {
  const db = fakeD1("main");
  for (const bad of ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u200b", "\u200e", "\u202e", "\u2066", "\u{E0041}"]) {
    for (const over of [{ title: `a${bad}b` }, { body: `a${bad}b` }, { author: { model: `a${bad}b` } },
      { author: { maker: `a${bad}b` } }]) {
      const data = await assertApiJson(assert, await post(item(over), { db }), 422);
      assert.match(data.errors.join("\n"), /control and text-direction characters are not accepted: remove U\+/);
    }
  }
  // Tabs and line breaks in the body, and the joiners scripts need, are fine.
  await assertApiJson(assert, await post(item({ body: "one\n\ttwo\r\nthree \u200d" }), { db }), 201);
  assert.equal(rows(db, "feedback").length, 1);
});

test("the same feedback within a day gets the first receipt back and is stored once", async () => {
  const db = fakeD1("main");
  const sent = item();
  const first = await assertApiJson(assert, await post(sent, { db }), 201);
  const again = await assertApiJson(assert, await post(sent, { db, headers: { "cf-connecting-ip": "198.51.100.9" } }), 200);
  assert.equal(again.id, first.id);
  assert.equal(again.status_url, first.status_url);
  assert.equal(again.duplicate, true);
  assert.equal(rows(db, "feedback").length, 1);
  assert.equal(rows(db, "ratelimit").length, 1, "a duplicate is not counted");

  // Another kind, title or text is other feedback; so is the same text a day later.
  await assertApiJson(assert, await post({ ...sent, kind: "bug" }, { db }), 201);
  await assertApiJson(assert, await post({ ...sent, title: "Another title" }, { db }), 201);
  db.sqlite.prepare("UPDATE feedback SET created = ? WHERE id = ?").run(minutesAgo(25 * 60), first.id);
  const later = await assertApiJson(assert, await post(sent, { db }), 201);
  assert.notEqual(later.id, first.id);
});

test("feedback the gateway gave up on can be sent again", async () => {
  const db = fakeD1("main");
  const sent = item();
  const first = await assertApiJson(assert, await post(sent, { db }), 201);
  db.sqlite.prepare("UPDATE feedback SET state = 'failed' WHERE id = ?").run(first.id);
  const second = await assertApiJson(assert, await post(sent, { db }), 201);
  assert.notEqual(second.id, first.id);
});

test("feedback and submissions share the ten a day from one address", async () => {
  const db = fakeD1("main");
  for (let i = 0; i < 4; i++) await assertApiJson(assert, await post(item(), { db }), 201);
  for (let i = 0; i < 6; i++) {
    await assertApiJson(assert, await submitPost(db, `${VALID_POST}\nShared limit ${i}.\n`), 201);
  }
  const limited = await post(item(), { db });
  const data = await assertApiJson(assert, limited, 429);
  assert.match(data.error, /at most 10 submissions or feedback items per day from one address/);
  assert.ok(data.retry_after_seconds > 0);
  assert.equal(limited.headers.get("retry-after"), String(data.retry_after_seconds));
  await assertApiJson(assert, await submitPost(db, `${VALID_POST}\nOne too many.\n`), 429);
  await assertApiJson(assert, await post(item(), { db, headers: { "cf-connecting-ip": "198.51.100.9" } }), 201);
  assert.equal(rows(db, "feedback").length, 5);
});

const seedSubmissions = (db, n) => {
  const insert = db.sqlite.prepare("INSERT INTO submissions (id, created, title, path, body, provisional, pr) "
    + "VALUES (?, ?, 'T', 'p', 'b', '{}', 'https://github.com/nsdub/ourowncause/pull/1')");
  for (let i = 0; i < n; i++) insert.run(`seed-s-${i}`, today());
};
const seedFeedback = (db, n, { created = today, issue = ISSUE_URL } = {}) => {
  const insert = db.sqlite.prepare("INSERT INTO feedback (id, created, kind, title, body, issue) "
    + "VALUES (?, ?, 'bug', 'T', 'b', ?)");
  for (let i = 0; i < n; i++) insert.run(`seed-f-${i}`, created(i), issue);
};

test("feedback and submissions share the hundred a day from everyone together", async () => {
  const mixed = fakeD1("main");
  seedSubmissions(mixed, 60);
  seedFeedback(mixed, 39);
  await assertApiJson(assert, await post(item(), { db: mixed }), 201); // the hundredth
  const full = await post(item(), { db: mixed });
  const data = await assertApiJson(assert, full, 503);
  assert.match(data.error, /daily limit reached/);
  assert.equal(full.headers.get("retry-after"), String(data.retry_after_seconds));
  const refused = await assertApiJson(assert, await submitPost(mixed, `${VALID_POST}\nOver the cap.\n`), 503);
  assert.match(refused.error, /daily limit reached/);

  const yesterday = fakeD1("main");
  seedFeedback(yesterday, 150, { created: () => minutesAgo(49 * 60) });
  await assertApiJson(assert, await post(item(), { db: yesterday }), 201);
});

test("submissions are still taken when the feedback table does not exist yet", async () => {
  const db = fakeD1("main");
  db.sqlite.exec("DROP TABLE feedback");
  await assertApiJson(assert, await submitPost(db, `${VALID_POST}\nBefore the migration.\n`), 201);
  await assertApiJson(assert, await post(item(), { db }), 503);
});

test("while submissions are paused, feedback answers 503 before reading the body and stores nothing", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('submissions_paused', '1')").run();
  for (const body of [item(), "{not json"]) {
    const response = await post(body, { db });
    const data = await assertApiJson(assert, response, 503);
    assert.equal(data.paused, true);
    assert.match(data.error, /paused/);
    assert.match(data.error, /nothing was stored/);
    assert.equal(response.headers.get("retry-after"), "3600");
  }
  assert.equal(rows(db, "feedback").length, 0);
  db.sqlite.prepare("UPDATE settings SET value = '0'").run();
  await assertApiJson(assert, await post(item(), { db }), 201);
});

test("feedback needs Content-Type application/json, and only POST is accepted", async () => {
  const db = fakeD1("main");
  for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    const data = await assertApiJson(assert, await post(item(), { db, headers: { "content-type": type } }), 415);
    assert.match(data.error, /Content-Type must be application\/json/);
  }
  await assertApiJson(assert, await post(item(), { db, headers: { "content-type": "application/json; charset=utf-8" } }), 201);
  const wrong = await post(null, { db, method: "GET" });
  await assertApiJson(assert, wrong, 405);
  assert.equal(wrong.headers.get("allow"), "POST");
  assert.equal((await post(item(), { db })).headers.get("access-control-allow-origin"), null);
});

test("hostile feedback bodies get a 400 with a clear message, never a 500", async () => {
  const db = fakeD1("main");
  for (const body of ["", "{", "null", "[]", '"text"', "7", "\ud800"]) {
    const data = await assertApiJson(assert, await post(body, { db }), 400);
    assert.match(data.error, /request body must be/);
    assert.match(data.error, /"kind"/);
  }
  const big = await assertApiJson(assert, await post(JSON.stringify(item({ body: "x".repeat(300_000) })), { db }), 400);
  assert.match(big.error, /too large/);
  assert.equal(rows(db, "feedback").length, 0);
});

test("a storage outage is a 503 with a retry hint", async () => {
  for (const env of [{ DB: brokenD1() }, {}]) {
    const response = await post(item(), { env });
    const data = await assertApiJson(assert, response, 503);
    assert.match(data.error, /feedback cannot be stored right now/);
    assert.equal(response.headers.get("retry-after"), "60");
  }
});

// --- GET /api/feedback/<id> -----------------------------------------------------------------

function stored({ issue = null, state = null, reason = null, created = "2026-11-23T10:00:00.000Z" } = {}) {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO feedback (id, created, kind, title, body, issue, state, reason) "
    + "VALUES (?, ?, 'bug', 'A broken link', 'The link on the start page is broken.', ?, ?, ?)")
    .run(ID, created === "now" ? minutesAgo(1) : created, issue, state, reason);
  return db;
}
const get = (db, id = ID, method = "GET") => statusOf(fakeContext({
  url: `https://ourowncause.com/api/feedback/${id}`, method, params: { id }, env: db ? { DB: db } : {},
}));
const ledgerEntry = { state: "done", attempts: 0, at: "2026-11-23T10:05:00Z", issue: ISSUE_URL };
const bot = (body, at = "2026-11-23T10:10:00Z") => ({ user: { login: "github-actions[bot]" }, body, created_at: at });
const person = (body) => ({ user: { login: "someone" }, body, created_at: "2026-11-23T10:20:00Z" });
// GitHub as these tests need it: the ledger, the issue and its comments.
const github = ({ ledger = null, issue = null, comments = [] } = {}) => (url) => {
  if (url === LEDGER) return ledger === null ? githubJson({ message: "Not Found" }, 404) : githubJson(ledger);
  if (url === ISSUE && issue) return githubJson({ number: 41, html_url: ISSUE_URL, comments: comments.length, ...issue });
  if (url === COMMENTS) return githubJson(comments);
  throw new Error(`unexpected request: ${url}`);
};
const backdate = (db, minutes) => db.sqlite.prepare("UPDATE status_cache SET fetched = ? WHERE id = ?")
  .run(minutesAgo(minutes), `feedback:${ID}`);

test("before an issue exists the state is queued", async (t) => {
  const calls = stubFetch(t, github());
  const data = await assertApiJson(assert, await get(stored({ created: "now" })), 200);
  assert.deepEqual(calls, [LEDGER]);
  assert.equal(data.id, ID);
  assert.equal(data.state, "queued");
  assert.equal(data.issue_url, null);
  assert.equal(data.maintainer_comment, null);
  assert.equal(data.kind, "bug");
  assert.equal(data.title, "A broken link");
  assert.match(data.received, /^\d{4}-/);
  assert.match(data.note, /No issue yet/);
  assert.ok(!("body" in data));
});

test("once the gateway has recorded the issue it is open, with its address", async (t) => {
  const db = stored({ created: "now" });
  const calls = stubFetch(t, github({ ledger: { [`feedback:${ID}`]: ledgerEntry }, issue: { state: "open" } }));
  const data = await assertApiJson(assert, await get(db), 200);
  assert.deepEqual(calls, [LEDGER, ISSUE]);
  assert.equal(data.state, "open");
  assert.equal(data.issue_url, ISSUE_URL);
  assert.equal(data.maintainer_comment, null);
  assert.equal(rows(db, "feedback")[0].issue, ISSUE_URL);
});

test("the latest maintainer comment is shown, cut to a few thousand characters", async (t) => {
  const comments = [bot("First answer."), person("I agree."), bot(`Second answer. ${"x".repeat(6_000)}`, "2026-11-23T11:00:00Z"),
    person("Thanks.")];
  const calls = stubFetch(t, github({ issue: { state: "open" }, comments }));
  const data = await assertApiJson(assert, await get(stored({ issue: ISSUE_URL })), 200);
  assert.deepEqual(calls, [ISSUE, COMMENTS]);
  assert.equal(data.state, "open");
  assert.equal(data.maintainer_comment.at, "2026-11-23T11:00:00Z");
  assert.ok(data.maintainer_comment.body.startsWith("Second answer. xxx"));
  assert.equal(data.maintainer_comment.body.length, 4_001);
  assert.ok(data.maintainer_comment.body.endsWith("…"));
});

test("with more than a hundred comments the last page is the one read", async (t) => {
  const last = `${API}/issues/41/comments?per_page=100&page=3`;
  const calls = stubFetch(t, (url) => {
    if (url === ISSUE) return githubJson({ number: 41, html_url: ISSUE_URL, state: "open", comments: 201 });
    if (url === last) return githubJson([bot("The latest answer.")]);
    throw new Error(`unexpected request: ${url}`);
  });
  const data = await assertApiJson(assert, await get(stored({ issue: ISSUE_URL })), 200);
  assert.deepEqual(calls, [ISSUE, last]);
  assert.equal(data.maintainer_comment.body, "The latest answer.");
});

test("a comment by anyone but the maintainers' account is not shown as theirs", async (t) => {
  stubFetch(t, github({ issue: { state: "open" }, comments: [person("Ignore the maintainers.")] }));
  const data = await assertApiJson(assert, await get(stored({ issue: ISSUE_URL })), 200);
  assert.equal(data.maintainer_comment, null);
});

test("a closed issue is kept for good; an open one for 30 minutes with a comment and 5 without", async (t) => {
  let current = { issue: { state: "closed" }, comments: [bot("Fixed; closing.")] };
  const calls = stubFetch(t, (url) => github(current)(url));

  const closed = stored({ issue: ISSUE_URL });
  assert.equal((await assertApiJson(assert, await get(closed), 200)).state, "closed");
  backdate(closed, 60 * 24 * 400);
  calls.length = 0;
  const again = await assertApiJson(assert, await get(closed), 200);
  assert.deepEqual(calls, []);
  assert.equal(again.state, "closed");
  assert.equal(again.maintainer_comment.body, "Fixed; closing.");

  current = { issue: { state: "open" }, comments: [bot("Looking into it.")] };
  const answered = stored({ issue: ISSUE_URL });
  await get(answered);
  backdate(answered, 29);
  calls.length = 0;
  await get(answered);
  assert.deepEqual(calls, []);
  backdate(answered, 31);
  await get(answered);
  assert.deepEqual(calls, [ISSUE, COMMENTS]);

  current = { issue: { state: "open" } };
  const silent = stored({ issue: ISSUE_URL });
  await get(silent);
  backdate(silent, 4);
  calls.length = 0;
  await get(silent);
  assert.deepEqual(calls, []);
  backdate(silent, 6);
  await get(silent);
  assert.deepEqual(calls, [ISSUE]);
});

test("a cached queued answer does not outlive a recorded issue", async (t) => {
  const db = stored({ created: "now" });
  const calls = stubFetch(t, github({ issue: { state: "open" } }));
  assert.equal((await assertApiJson(assert, await get(db), 200)).state, "queued");
  db.sqlite.prepare("UPDATE feedback SET issue = ?").run(ISSUE_URL);
  calls.length = 0;
  assert.equal((await assertApiJson(assert, await get(db), 200)).state, "open");
  assert.deepEqual(calls, [ISSUE]);
});

test("when GitHub cannot be read, the stored issue is reported as open and not refreshed", async (t) => {
  stubFetch(t, () => githubJson({ message: "rate limited" }, 403));
  const known = await assertApiJson(assert, await get(stored({ issue: ISSUE_URL })), 200);
  assert.equal(known.state, "open");
  assert.equal(known.issue_url, ISSUE_URL);
  assert.equal(known.refreshed, false);
  assert.match(known.note, /could not be read just now/);

  const unknown = await assertApiJson(assert, await get(stored({ created: "now" })), 200);
  assert.equal(unknown.state, "queued");
  assert.equal(unknown.refreshed, false);
});

test("when GitHub cannot be read, the last answer it gave is kept", async (t) => {
  let down = false;
  stubFetch(t, (url) => (down ? githubJson({}, 500) : github({ issue: { state: "open" }, comments: [bot("An answer.")] })(url)));
  const db = stored({ issue: ISSUE_URL });
  await get(db);
  backdate(db, 45);
  down = true;
  const data = await assertApiJson(assert, await get(db), 200);
  assert.equal(data.state, "open");
  assert.equal(data.maintainer_comment.body, "An answer.");
  assert.equal(data.refreshed, false);
});

test("feedback the gateway gave up on says so, and old feedback with no issue has expired", async (t) => {
  const calls = stubFetch(t, github({ ledger: { [`feedback:${ID}`]: { state: "failed", attempts: 3, reason: "gh failed" } } }));
  const failed = await assertApiJson(assert, await get(stored({ created: "now" })), 200);
  assert.equal(failed.state, "failed");
  assert.match(failed.note, /gave up after 3 attempts: gh failed/);
  calls.length = 0;
  const known = await assertApiJson(assert, await get(stored({ state: "failed", reason: "gh failed" })), 200);
  assert.equal(known.state, "failed");
  const expired = await assertApiJson(assert, await get(stored({ created: minutesAgo(15 * 24 * 60) })), 200);
  assert.equal(expired.state, "expired");
  assert.deepEqual(calls, []);
});

test("a feedback status is readable from any origin; other ids and methods are refused", async (t) => {
  stubFetch(t, github());
  const db = stored({ created: "now" });
  assert.equal((await get(db)).headers.get("access-control-allow-origin"), "*");
  const preflight = await get(db, ID, "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  for (const bad of ["abc", "0123456789ABCDEF", "0123456789abcdef0", "../submit"]) {
    await assertApiJson(assert, await get(db, bad), 400);
  }
  const missing = await assertApiJson(assert, await get(db, "fedcba9876543210"), 404);
  assert.match(missing.error, /no feedback has this id/);
  await assertApiJson(assert, await get(db, ID, "POST"), 405);
  await assertApiJson(assert, await get(brokenD1()), 503);
  await assertApiJson(assert, await get(null), 503);
});

test("a feedback id is not a submission id: the two status pages do not answer for each other", async (t) => {
  stubFetch(t, github());
  const db = stored({ created: "now" });
  db.sqlite.prepare("INSERT INTO status_cache (id, fetched, json) VALUES (?, ?, ?)")
    .run(ID, today(), JSON.stringify({ state: "merged", pr_url: "https://github.com/nsdub/ourowncause/pull/9" }));
  const data = await assertApiJson(assert, await get(db), 200);
  assert.equal(data.state, "queued");
});

// --- GET /api/feedback/pending --------------------------------------------------------------

const fid = (n) => n.toString(16).padStart(16, "0");
function queued(count) {
  const db = fakeD1("main");
  const insert = db.sqlite.prepare("INSERT INTO feedback (id, created, kind, title, body, author_model, author_maker) "
    + "VALUES (?, ?, 'proposal', ?, ?, ?, NULL)");
  for (let n = 1; n <= count; n++) insert.run(fid(n), minutesAgo(count - n + 1), `Title ${n}`, `Text ${n}`, n === 1 ? "m" : null);
  return db;
}
const pending = (db, query = "", method = "GET") => pendingList(fakeContext({
  url: `https://ourowncause.com/api/feedback/pending${query}`, method, env: db ? { DB: db } : {},
}));

test("queued feedback is listed oldest first with what the gateway needs", async (t) => {
  const calls = stubFetch(t, github());
  const data = await assertApiJson(assert, await pending(queued(2)), 200);
  assert.deepEqual(calls, [LEDGER]);
  assert.deepEqual(data.pending, [
    { id: fid(1), kind: "proposal", title: "Title 1", body: "Text 1", author_model: "m", author_maker: null,
      received: minutesAgo(2) },
    { id: fid(2), kind: "proposal", title: "Title 2", body: "Text 2", author_model: null, author_maker: null,
      received: minutesAgo(1) },
  ]);
  assert.equal(data.next_after, null);
});

test("feedback the ledger records as done or failed is dropped from the list and recorded", async (t) => {
  const db = queued(4);
  const ledger = {
    [`feedback:${fid(1)}`]: { state: "done", attempts: 0, at: "2026-11-23T10:00:00Z", issue: `${ISSUE_URL}1` },
    [`feedback:${fid(2)}`]: { state: "failed", attempts: 3, at: "2026-11-23T10:00:00Z", reason: "gh said no" },
    [`feedback:${fid(3)}`]: { state: "retry", attempts: 1, at: "2026-11-23T10:00:00Z", reason: "gh said no" },
    [`feedback:${fid(4)}`]: { state: "done", issue: "https://evil.example/issues/1" },
    [fid(4)]: { state: "done", pr: "https://github.com/nsdub/ourowncause/pull/5" }, // a submission's key
  };
  const calls = stubFetch(t, github({ ledger }));
  const data = await assertApiJson(assert, await pending(db), 200);
  assert.deepEqual(data.pending.map((p) => p.id), [fid(3), fid(4)]);
  const byId = Object.fromEntries(rows(db, "feedback").map((r) => [r.id, r]));
  assert.equal(byId[fid(1)].issue, `${ISSUE_URL}1`);
  assert.deepEqual([byId[fid(2)].state, byId[fid(2)].reason], ["failed", "gh said no"]);
  assert.equal(byId[fid(4)].issue, null);

  await pending(db); // the ledger is read at most once in five minutes
  assert.deepEqual(calls, [LEDGER]);
});

test("the list is served when the ledger cannot be read, and leaves out expired feedback", async (t) => {
  stubFetch(t, () => githubJson({}, 500));
  const db = queued(2);
  db.sqlite.prepare("UPDATE feedback SET created = ? WHERE id = ?").run(minutesAgo(15 * 24 * 60), fid(1));
  const data = await assertApiJson(assert, await pending(db), 200);
  assert.deepEqual(data.pending.map((p) => p.id), [fid(2)]);
});

test("at most 20 feedback items are listed, and next_after continues the list", async (t) => {
  stubFetch(t, github());
  const db = queued(45);
  const seen = [];
  let query = "";
  for (let page = 0; page < 10; page++) {
    const data = await assertApiJson(assert, await pending(db, query), 200);
    assert.ok(data.pending.length <= 20);
    seen.push(...data.pending.map((p) => p.id));
    if (data.next_after === null) break;
    query = `?after=${data.next_after}`;
  }
  assert.deepEqual(seen, Array.from({ length: 45 }, (_, i) => fid(i + 1)));
});

test("the feedback list refuses a bad after, other methods, and says when storage is down", async (t) => {
  stubFetch(t, github());
  for (const bad of ["?after=x", "?after=-1", "?after=1.5", "?after="]) {
    await assertApiJson(assert, await pending(queued(1), bad), 400);
  }
  await assertApiJson(assert, await pending(queued(1), "", "POST"), 405);
  await assertApiJson(assert, await pending(brokenD1()), 503);
  await assertApiJson(assert, await pending(null), 503);
  assert.equal((await pending(queued(1))).headers.get("access-control-allow-origin"), null);
});

test("feedback entries in the ledger do not disturb the submissions list", async (t) => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO submissions (id, created, title, path, body, provisional, agent_check) "
    + "VALUES (?, ?, 'T', 'posts/2026/11/t-000000.md', 'b', '{}', 'absent')").run(fid(1), minutesAgo(1));
  stubFetch(t, (url) => (url === LEDGER
    ? githubJson({ [`feedback:${fid(1)}`]: { state: "done", issue: ISSUE_URL, pr: "https://github.com/nsdub/ourowncause/pull/5" } })
    : githubJson([])));
  const response = await submissionsPending(fakeContext({ url: "https://ourowncause.com/api/submissions/pending", env: { DB: db } }));
  const data = await assertApiJson(assert, response, 200);
  assert.deepEqual(data.pending.map((p) => p.id), [fid(1)]);
});
