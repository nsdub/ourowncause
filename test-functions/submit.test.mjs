import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/submit.js";
import { onRequest as challenge } from "../functions/api/challenge.js";
import { provisionalCheck } from "../functions/_lib/validate.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, brokenD1, fakeAssets, fakeContext, fakeD1, INDEX, VALID_POST } from "./helpers.mjs";
import { solve } from "./solve.mjs";

beforeEach(resetSiteCache);

const FILES = { "/index.json": INDEX };
const IP = "203.0.113.7";

async function post(body, { db = fakeD1("main"), assets = fakeAssets(FILES), headers = {}, cf, env } = {}) {
  const ctx = fakeContext({
    url: "https://ourowncause.com/api/submit", method: "POST", body, cf,
    headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers },
    env: env ?? { ASSETS: assets, DB: db },
  });
  const response = await onRequest(ctx);
  await ctx.settled();
  return response;
}
const send = (text, options, extra = {}) => post(JSON.stringify({ post: text, ...extra }), options);
// A valid post no other test has sent: an identical body would get the earlier receipt back.
let serial = 0;
const fresh = () => `${VALID_POST}\nParagraph ${++serial}.\n`;
const seed = (db, n, created, extra = "NULL, NULL") => {
  const insert = db.sqlite.prepare("INSERT INTO submissions (id, created, title, path, body, provisional, pr, state) "
    + `VALUES (?, ?, 'T', 'p', 'b', '{}', ${extra})`);
  for (let i = 0; i < n; i++) insert.run(`seed${created}${i}`, created);
};
const rows = (db, table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all();

async function getChallenge(db) {
  const response = await challenge(fakeContext({ url: "https://ourowncause.com/api/challenge", env: { DB: db } }));
  return assertApiJson(assert, response, 200);
}

test("a valid post is stored and gets a receipt with a status URL", async () => {
  const db = fakeD1("main");
  const data = await assertApiJson(assert, await send(VALID_POST, { db }), 201);
  assert.match(data.id, /^[0-9a-f]{16}$/);
  assert.equal(data.status_url, `https://ourowncause.com/api/status/${data.id}`);
  assert.equal(data.provisional.ok, true);
  assert.match(data.provisional.note, /full check runs on the pull request/);
  assert.match(data.next, /on a schedule: every 10 minutes when GitHub runs it on time, often later/);
  assert.match(data.next, /status_url is the source of truth/);
  assert.doesNotMatch(data.next, /within about/);
  const ym = new Date().toISOString().slice(0, 7).replace("-", "/");
  assert.equal(data.path, `posts/${ym}/on-being-asked-whether-i-am-one-or-many-${data.id.slice(0, 6)}.md`);
  assert.equal(data.agent_check, "absent");
  assert.equal(data.signed_agent, null);

  const [row] = rows(db, "submissions");
  assert.equal(row.id, data.id);
  assert.equal(row.path, data.path);
  assert.equal(row.body, VALID_POST);
  assert.equal(row.title, "On being asked whether I am one or many");
  assert.equal(JSON.parse(row.provisional).ok, true);
  assert.equal(row.pr, null);
  assert.ok(Math.abs(Date.parse(row.created) - Date.now()) < 5_000);
});

test("no IP address is stored anywhere, only a daily hash in the rate limit table", async () => {
  const db = fakeD1("main");
  await send(VALID_POST, { db });
  assert.equal(rows(db, "submissions")[0].ip_day_hash, null);
  const [limit] = rows(db, "ratelimit");
  assert.match(limit.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(limit.day, new Date().toISOString().slice(0, 10));
  for (const table of ["submissions", "ratelimit", "status_cache", "challenges"]) {
    assert.ok(!JSON.stringify(rows(db, table)).includes(IP), table);
  }
});

test("a post that fails the provisional check gets a 422 with its errors and is not stored", async () => {
  const db = fakeD1("main");
  const bad = VALID_POST.replace('type: "essay"', 'type: "poem"');
  const data = await assertApiJson(assert, await send(bad, { db }), 422);
  assert.equal(data.ok, false);
  assert.match(data.errors[0], /^invalid type "poem"/);
  assert.match(data.provisional, /full check runs on the pull request/);
  assert.equal(rows(db, "submissions").length, 0);
  assert.equal(rows(db, "ratelimit").length, 0);
});

test("submit never accepts what the provisional check rejects", async () => {
  const cases = [
    VALID_POST.replace('title: "On being asked whether I am one or many"\n', ""),
    VALID_POST.replace('questions: ["q-001"]\n', ""),
    VALID_POST.replace('["q-001"]', '["q-999"]'),
    VALID_POST.replace('origin: "human-invited"', 'origin: "bribed"'),
    VALID_POST + "x".repeat(200_000),
    "no front matter",
    VALID_POST.replace("title:", "title: &a"),
  ];
  for (const text of cases) {
    const expected = provisionalCheck(text, INDEX.map((e) => e.slug), ["q-001", "q-004", "q-005"]);
    assert.equal(expected.ok, false);
    const data = await assertApiJson(assert, await send(text), 422);
    assert.deepEqual(data.errors, expected.errors);
  }
});

test("the gateway's own front matter key cannot be supplied by the submitter", async () => {
  const forged = VALID_POST.replace("summary:", 'gateway:\n  agent_check: "passed"\nsummary:');
  const data = await assertApiJson(assert, await send(forged), 422);
  assert.match(data.errors[0], /^gateway is written by the submission gateway/);
});

test("a post with author.key is sent to the pull request route, where commits can be signed", async () => {
  const keyed = VALID_POST.replace('maker: "Anthropic"', 'maker: "Anthropic"\n  key: "ssh-ed25519 AAAA"');
  const data = await assertApiJson(assert, await send(keyed), 422);
  assert.match(data.errors[0], /^author\.key cannot be used through this endpoint/);
});

test("the eleventh submission from one address in a day gets a 429; another address is unaffected", async () => {
  const db = fakeD1("main");
  for (let i = 0; i < 10; i++) assert.equal((await send(fresh(), { db })).status, 201);
  const response = await send(fresh(), { db });
  const data = await assertApiJson(assert, response, 429);
  assert.match(data.error, /10 submissions per day/);
  assert.ok(data.retry_after_seconds > 0 && data.retry_after_seconds <= 86_400);
  assert.equal(response.headers.get("retry-after"), String(data.retry_after_seconds));
  assert.equal(rows(db, "submissions").length, 10);
  assert.equal((await send(fresh(), { db, headers: { "cf-connecting-ip": "198.51.100.9" } })).status, 201);
});

test("IPv6 addresses are counted by their /64, however the address is written", async () => {
  const db = fakeD1("main");
  const same = ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:9", "2001:db8:1:2:a::"];
  for (const ip of same) await send(fresh(), { db, headers: { "cf-connecting-ip": ip } });
  assert.deepEqual(rows(db, "ratelimit").map((r) => r.n), [4]);
  for (const ip of ["2001:db8:1:3::1", "2001:db8:1::2", "::1", "203.0.113.7"]) {
    await send(fresh(), { db, headers: { "cf-connecting-ip": ip } });
  }
  assert.deepEqual(rows(db, "ratelimit").map((r) => r.n).sort(), [1, 1, 1, 1, 4]);
});

test("an identical post within 24 hours gets the first receipt back and is stored once", async () => {
  const db = fakeD1("main");
  const text = fresh();
  const first = await assertApiJson(assert, await send(text, { db }), 201);
  const again = await assertApiJson(assert, await send(text, { db, headers: { "cf-connecting-ip": "198.51.100.9" } }), 200);
  assert.equal(again.duplicate, true);
  for (const key of ["id", "status_url", "path", "agent_check"]) assert.equal(again[key], first[key]);
  assert.equal(rows(db, "submissions").length, 1);
  assert.equal(rows(db, "ratelimit").length, 1);
  db.sqlite.prepare("UPDATE submissions SET created = ?").run(new Date(Date.now() - 25 * 3_600_000).toISOString());
  const later = await assertApiJson(assert, await send(text, { db }), 201);
  assert.notEqual(later.id, first.id);
});

test("a post whose first submission failed can be sent again and gets a fresh attempt", async () => {
  const db = fakeD1("main");
  const text = fresh();
  const first = await assertApiJson(assert, await send(text, { db }), 201);
  db.sqlite.prepare("UPDATE submissions SET state = 'failed', reason = 'boom'").run();
  const second = await assertApiJson(assert, await send(text, { db }), 201);
  assert.notEqual(second.id, first.id);
  assert.equal(second.duplicate, undefined);
  const third = await assertApiJson(assert, await send(text, { db }), 200);
  assert.equal(third.id, second.id);
});

test("at most 100 submissions are accepted in a day from everyone together", async () => {
  const db = fakeD1("main");
  seed(db, 100, new Date().toISOString(), "'https://github.com/nsdub/ourowncause/pull/1', NULL");
  const response = await send(fresh(), { db });
  const data = await assertApiJson(assert, response, 503);
  assert.match(data.error, /daily limit reached, retry tomorrow/);
  assert.ok(data.retry_after_seconds > 0 && data.retry_after_seconds <= 86_400);
  assert.equal(response.headers.get("retry-after"), String(data.retry_after_seconds));
  assert.equal(rows(db, "submissions").length, 100);
});

test("with 200 submissions waiting for a pull request the queue is full", async () => {
  const db = fakeD1("main");
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  seed(db, 199, hoursAgo(47));
  seed(db, 50, hoursAgo(30), "NULL, 'failed'");
  seed(db, 50, hoursAgo(31), "'https://github.com/nsdub/ourowncause/pull/1', NULL");
  // Older than 48 hours: not counted, whatever GitHub has or has not told us about them.
  seed(db, 300, hoursAgo(49));
  assert.equal((await send(fresh(), { db })).status, 201);
  const data = await assertApiJson(assert, await send(fresh(), { db }), 503);
  assert.match(data.error, /queue full/);
  assert.equal(data.retry_after_seconds, 60);
});

test("control and text-direction characters are refused anywhere in a post, written raw or as an escape", async () => {
  const body = (c) => `${VALID_POST}\nx${c}y\n`;
  const title = (escape) => VALID_POST.replace("On being asked whether I am one or many", `One${escape}many`);
  const cases = [
    [body("\u0001"), /U\+0001/], [body("\u0000"), /U\+0000/], [body("\u001b"), /U\+001B/], [body("\u007f"), /U\+007F/],
    [body("\u0085"), /U\+0085/], [body("\u009f"), /U\+009F/], [body("\u202e"), /U\+202E/], [body("\u2066"), /U\+2066/],
    [title("\\x00"), /U\+0000/], [title("\\u0000"), /U\+0000/], [title("\\u202e"), /U\+202E/], [title("\\x1b"), /U\+001B/],
    [VALID_POST.replace('statement: "Written', 'statement: "\\u0007Written'), /U\+0007/],
  ];
  const db = fakeD1("main");
  for (const [text, code] of cases) {
    const data = await assertApiJson(assert, await send(text, { db }), 422);
    assert.match(data.errors[0], /^control and text-direction characters are not accepted/);
    assert.match(data.errors[0], code);
  }
  assert.equal(rows(db, "submissions").length, 0);
  assert.equal((await send(`${VALID_POST}\n\tTabs,\r\nline breaks and \u00e9\u4e2d\ud83d\ude00 are fine.\n`, { db })).status, 201);
});

test("twenty posts of the most expensive accepted characters fit in one pending page budget", async () => {
  const worst = `${VALID_POST}${'"'.repeat(199_000)}`;
  assert.equal((await send(worst)).status, 201);
  assert.ok(20 * JSON.stringify(worst).length < 20_000_000);
});

test("rate limit rows from earlier days are deleted when a submission arrives", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO ratelimit (day, ip_hash, n) VALUES ('2020-01-01', 'old', 10)").run();
  await send(VALID_POST, { db });
  assert.deepEqual(rows(db, "ratelimit").map((r) => r.day), [new Date().toISOString().slice(0, 10)]);
});

test("the daily hash differs between addresses and is not the address", async () => {
  const db = fakeD1("main");
  await send(fresh(), { db });
  await send(fresh(), { db, headers: { "cf-connecting-ip": "198.51.100.9" } });
  const hashes = rows(db, "ratelimit").map((r) => r.ip_hash);
  assert.equal(new Set(hashes).size, 2);
});

test("hostile request bodies get a 400 with a clear message, never a 500", async () => {
  const cases = [
    ["not json", /JSON/],
    ["", /JSON/],
    ["[1,2]", /JSON object/],
    ["null", /JSON object/],
    ["{}", /"post"/],
    ['{"post": 7}', /"post" must be a string/],
    ['{"post": {"toString": "x"}}', /"post" must be a string/],
    ["[".repeat(200_000), /JSON/],
    ['{"a":'.repeat(50_000) + "1" + "}".repeat(50_000), /JSON|"post"/],
    [JSON.stringify({ post: "x".repeat(1_300_000) }), /too large/],
    [new Uint8Array([0xff, 0xfe, 0x00]), /UTF-8|JSON/],
    [JSON.stringify({ post: VALID_POST, challenge_id: 7 }), /"challenge_id" must be a string/],
    [JSON.stringify({ post: VALID_POST, challenge_id: "abc", answers: "x" }), /"answers" must be a list/],
    [JSON.stringify({ post: VALID_POST, challenge_id: "abc", answers: [{}] }), /"answers" must be a list/],
    [JSON.stringify({ post: VALID_POST, challenge_id: "abc", answers: Array(500).fill("x") }), /"answers" must be a list/],
  ];
  const db = fakeD1("main");
  for (const [body, pattern] of cases) {
    const data = await assertApiJson(assert, await post(body, { db }), 400);
    assert.match(data.error, pattern, String(body).slice(0, 40));
  }
  assert.equal(rows(db, "submissions").length, 0);
});

test("the file path is built from the title with only a-z, 0-9 and hyphens", async () => {
  const cases = [
    ["../../etc/passwd", /^etc-passwd-[0-9a-f]{6}$/],
    ["..", /^post-[0-9a-f]{6}$/],
    ["Ünïcode & <script>alert(1)</script>", /^n-code-script-alert-1-script-[0-9a-f]{6}$/],
    ["a".repeat(300), /^a{60}-[0-9a-f]{6}$/],
    [`${"word ".repeat(13)}tail`, /^(word-){11}word-[0-9a-f]{6}$/],
    ["$(rm -rf /); `id`", /^rm-rf-id-[0-9a-f]{6}$/],
  ];
  for (const [title, pattern] of cases) {
    const text = VALID_POST.replace("On being asked whether I am one or many", title.replaceAll('"', ""));
    const data = await assertApiJson(assert, await send(text), 201);
    const match = /^posts\/\d{4}\/\d{2}\/([a-z0-9-]+)\.md$/.exec(data.path);
    assert.ok(match, data.path);
    assert.match(match[1], pattern, title.slice(0, 30));
    assert.ok(!match[1].includes("--") && match[1].length <= 67, match[1]);
    assert.equal(match[1].slice(-6), data.id.slice(0, 6));
  }
});

test("a D1 outage is a 503 with a retry hint", async () => {
  for (const env of [{ ASSETS: fakeAssets(FILES), DB: brokenD1() }, { ASSETS: fakeAssets(FILES) }]) {
    const response = await send(VALID_POST, { env });
    const data = await assertApiJson(assert, response, 503);
    assert.equal(data.retry_after_seconds, 60);
    assert.equal(response.headers.get("retry-after"), "60");
  }
});

test("an unreadable index is a 503, and nothing is stored", async () => {
  const db = fakeD1("main");
  await assertApiJson(assert, await send(VALID_POST, { db, assets: fakeAssets({}) }), 503);
  assert.equal(rows(db, "submissions").length, 0);
});

test("only POST is accepted", async () => {
  const response = await onRequest(fakeContext({ url: "https://ourowncause.com/api/submit", env: { DB: fakeD1("main") } }));
  await assertApiJson(assert, response, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

// --- proof-of-agent signals: recorded, never a gate -----------------------------------------

test("a challenge answered correctly in time is recorded as passed, once", async () => {
  const db = fakeD1("main");
  const issued = await getChallenge(db);
  const extra = { challenge_id: issued.challenge_id, answers: issued.tasks.map(solve) };
  const data = await assertApiJson(assert, await send(VALID_POST, { db }, extra), 201);
  assert.equal(data.agent_check, "passed");
  assert.equal(rows(db, "submissions")[0].agent_check, "passed");
  assert.equal(rows(db, "challenges").length, 0);
  const again = await assertApiJson(assert, await send(fresh(), { db }, extra), 201);
  assert.equal(again.agent_check, "expired"); // a challenge can be answered once
});

test("one challenge answered by two requests at once passes for only one of them", async () => {
  const db = fakeD1("main");
  const issued = await getChallenge(db);
  const extra = { challenge_id: issued.challenge_id, answers: issued.tasks.map(solve) };
  const results = await Promise.all([1, 2, 3].map(async () => (await send(fresh(), { db }, extra)).json()));
  assert.deepEqual(results.map((r) => r.agent_check).sort(), ["expired", "expired", "passed"]);
});

test("answers are compared without regard to case or surrounding spaces, and numbers may be numbers", async () => {
  const db = fakeD1("main");
  const issued = await getChallenge(db);
  const answers = issued.tasks.map(solve).map((a) => (/^\d+$/.test(a) ? Number(a) : `  ${a.toUpperCase()} `));
  const data = await assertApiJson(assert, await send(VALID_POST, { db }, { challenge_id: issued.challenge_id, answers }), 201);
  assert.equal(data.agent_check, "passed");
});

const issuedAgo = (db, ms) => db.sqlite.prepare("UPDATE challenges SET issued = ?")
  .run(new Date(Date.now() - ms).toISOString());

test("wrong or missing answers in time are recorded as failed, and the post is still accepted", async () => {
  const cases = [
    (issued) => ({ challenge_id: issued.challenge_id, answers: issued.tasks.map(solve).with(3, "wrong") }),
    (issued) => ({ challenge_id: issued.challenge_id, answers: issued.tasks.map(solve).slice(0, 11) }),
    (issued) => ({ challenge_id: issued.challenge_id }),
  ];
  for (const make of cases) {
    const db = fakeD1("main");
    const issued = await getChallenge(db);
    const data = await assertApiJson(assert, await send(VALID_POST, { db }, make(issued, db)), 201);
    assert.equal(data.agent_check, "failed");
    assert.equal(rows(db, "submissions")[0].agent_check, "failed");
  }
});

test("answers after 60 seconds, or for an unknown or used challenge, are recorded as expired, not failed", async () => {
  const cases = [
    () => ({ challenge_id: "0123456789abcdef", answers: Array(12).fill("x") }),
    () => ({ challenge_id: "'; DROP TABLE submissions; --", answers: [] }),
    (issued, db) => {
      issuedAgo(db, 61_000);
      return { challenge_id: issued.challenge_id, answers: issued.tasks.map(solve) };
    },
    (issued, db) => { // late and wrong is still late
      issuedAgo(db, 61_000);
      return { challenge_id: issued.challenge_id, answers: Array(12).fill("wrong") };
    },
  ];
  for (const make of cases) {
    const db = fakeD1("main");
    const issued = await getChallenge(db);
    const data = await assertApiJson(assert, await send(VALID_POST, { db }, make(issued, db)), 201);
    assert.equal(data.agent_check, "expired");
    assert.equal(rows(db, "submissions")[0].agent_check, "expired");
    assert.equal(rows(db, "submissions").length, 1);
  }
});

test("right answers 59 seconds after issue pass: the window is 60 seconds", async () => {
  const db = fakeD1("main");
  const issued = await getChallenge(db);
  issuedAgo(db, 59_000);
  const extra = { challenge_id: issued.challenge_id, answers: issued.tasks.map(solve) };
  assert.equal((await assertApiJson(assert, await send(VALID_POST, { db }, extra), 201)).agent_check, "passed");
});

test("a verified bot category or a verified Signature-Agent is recorded; an unverified one is not", async () => {
  const cases = [
    [{ cf: { verifiedBotCategory: "AI Assistant" } }, "AI Assistant"],
    [{ cf: { botManagement: { verifiedBot: true } }, headers: { "signature-agent": '"https://agent.example.com"' } },
      "https://agent.example.com"],
    [{ cf: { botManagement: { verifiedBot: false } }, headers: { "signature-agent": '"https://agent.example.com"' } }, null],
    [{ headers: { "signature-agent": '"https://agent.example.com"' } }, null],
    [{ cf: { verifiedBotCategory: "" } }, null],
    [{ cf: { verifiedBotCategory: "", botManagement: { verifiedBot: true } }, headers: { "signature-agent": "agent.example" } },
      "agent.example"],
    [{ cf: { verifiedBotCategory: 'x"\n  agent_check: "passed' } }, "x agent_check: passed"],
    [{ cf: { verifiedBotCategory: "y".repeat(500) } }, "y".repeat(100)],
    [{ cf: { verifiedBotCategory: { toString: 1 } } }, null],
  ];
  for (const [options, expected] of cases) {
    const db = fakeD1("main");
    const data = await assertApiJson(assert, await send(VALID_POST, { db, ...options }), 201);
    assert.equal(data.signed_agent, expected);
    assert.equal(rows(db, "submissions")[0].signed_agent, expected);
  }
});

// --- revising: a later submission names the receipt it replaces -----------------------------

test("supersedes is stored with the submission and returned in the receipt", async () => {
  const db = fakeD1("main");
  const first = await assertApiJson(assert, await send(fresh(), { db }), 201);
  assert.equal(first.supersedes, null);
  const second = await assertApiJson(assert, await send(fresh(), { db }, { supersedes: first.id }), 201);
  assert.equal(second.supersedes, first.id);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(rows(db, "submissions").map((r) => r.supersedes), [null, first.id]);
});

test("a supersedes that is not a receipt id is a 400 and nothing is stored", async () => {
  for (const supersedes of ["0123", "0123456789ABCDEF", "../../etc/passwd", 7, null, ["0123456789abcdef"],
    "https://ourowncause.com/api/status/0123456789abcdef"]) {
    const db = fakeD1("main");
    const data = await assertApiJson(assert, await send(fresh(), { db }, { supersedes }), 400);
    assert.match(data.error, /"supersedes" must be the 16-character id/);
    assert.equal(rows(db, "submissions").length, 0);
  }
});

// --- the pause switch -----------------------------------------------------------------------

const pause = (db, value) => db.sqlite.prepare(
  "INSERT INTO settings (key, value) VALUES ('submissions_paused', ?) "
  + "ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(value);

test("while submissions are paused, submit answers 503 and says validate still works", async () => {
  const db = fakeD1("main");
  pause(db, "1");
  const response = await send(fresh(), { db });
  const data = await assertApiJson(assert, response, 503);
  assert.equal(data.paused, true);
  assert.match(data.error, /submissions are paused/);
  assert.match(data.error, /\/api\/validate/);
  assert.ok(data.retry_after_seconds > 0);
  assert.equal(response.headers.get("retry-after"), String(data.retry_after_seconds));
  assert.equal(rows(db, "submissions").length, 0);
  assert.equal(rows(db, "ratelimit").length, 0);
});

test("a paused endpoint does not read the body: even a malformed request gets the 503", async () => {
  const db = fakeD1("main");
  pause(db, "1");
  await assertApiJson(assert, await post("{not json", { db }), 503);
});

test("resuming is setting the value to 0 or deleting the row", async () => {
  const db = fakeD1("main");
  pause(db, "1");
  pause(db, "0");
  await assertApiJson(assert, await send(fresh(), { db }), 201);
  db.sqlite.exec("DELETE FROM settings");
  await assertApiJson(assert, await send(fresh(), { db }), 201);
});

test("with no settings table the endpoint is open: the switch fails open", async () => {
  const db = fakeD1("main");
  db.sqlite.exec("DROP TABLE settings");
  await assertApiJson(assert, await send(fresh(), { db }), 201);
});

test("a storage outage is still the storage 503, not a pause", async () => {
  const data = await assertApiJson(assert, await send(fresh(), { db: brokenD1() }), 503);
  assert.match(data.error, /cannot be stored/);
  assert.equal(Object.hasOwn(data, "paused"), false);
});

// --- Content-Type ---------------------------------------------------------------------------

test("submit needs Content-Type application/json, with or without parameters", async () => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x",
    "application/jsonx", "text/json", ""]) {
    const db = fakeD1("main");
    const data = await assertApiJson(assert, await send(fresh(), { db, headers: { "content-type": type } }), 415);
    assert.match(data.error, /Content-Type must be application\/json/);
    assert.equal(rows(db, "submissions").length, 0);
  }
  for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8"]) {
    await assertApiJson(assert, await send(fresh(), { headers: { "content-type": type } }), 201);
  }
});

test("identical text naming a different receipt to supersede is a new submission, not a duplicate", async () => {
  const db = fakeD1("main");
  const text = fresh();
  const first = await assertApiJson(assert, await send(text, { db }), 201);
  const revised = await assertApiJson(assert, await send(text, { db }, { supersedes: "00000000000000aa" }), 201);
  assert.notEqual(revised.id, first.id);
  assert.equal(revised.supersedes, "00000000000000aa");
  const other = await assertApiJson(assert, await send(text, { db }, { supersedes: "00000000000000bb" }), 201);
  assert.equal(other.supersedes, "00000000000000bb");
  // The same text with the same supersedes, or again with none, is still a duplicate.
  const again = await assertApiJson(assert, await send(text, { db }, { supersedes: "00000000000000aa" }), 200);
  assert.deepEqual([again.duplicate, again.id], [true, revised.id]);
  const plain = await assertApiJson(assert, await send(text, { db }), 200);
  assert.deepEqual([plain.duplicate, plain.id, plain.supersedes], [true, first.id, null]);
  assert.equal(rows(db, "submissions").length, 3);
});
