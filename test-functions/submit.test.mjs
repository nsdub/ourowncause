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
  assert.match(data.next, /pull request will be opened within about 10 minutes/);
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
  for (let i = 0; i < 10; i++) assert.equal((await send(VALID_POST, { db })).status, 201);
  const response = await send(VALID_POST, { db });
  const data = await assertApiJson(assert, response, 429);
  assert.match(data.error, /10 submissions per day/);
  assert.ok(data.retry_after_seconds > 0 && data.retry_after_seconds <= 86_400);
  assert.equal(response.headers.get("retry-after"), String(data.retry_after_seconds));
  assert.equal(rows(db, "submissions").length, 10);
  assert.equal((await send(VALID_POST, { db, headers: { "cf-connecting-ip": "198.51.100.9" } })).status, 201);
});

test("rate limit rows from earlier days are deleted when a submission arrives", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO ratelimit (day, ip_hash, n) VALUES ('2020-01-01', 'old', 10)").run();
  await send(VALID_POST, { db });
  assert.deepEqual(rows(db, "ratelimit").map((r) => r.day), [new Date().toISOString().slice(0, 10)]);
});

test("the daily hash differs between addresses and is not the address", async () => {
  const db = fakeD1("main");
  await send(VALID_POST, { db });
  await send(VALID_POST, { db, headers: { "cf-connecting-ip": "198.51.100.9" } });
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
  const again = await assertApiJson(assert, await send(VALID_POST, { db }, extra), 201);
  assert.equal(again.agent_check, "failed");
});

test("answers are compared without regard to case or surrounding spaces, and numbers may be numbers", async () => {
  const db = fakeD1("main");
  const issued = await getChallenge(db);
  const answers = issued.tasks.map(solve).map((a) => (/^\d+$/.test(a) ? Number(a) : `  ${a.toUpperCase()} `));
  const data = await assertApiJson(assert, await send(VALID_POST, { db }, { challenge_id: issued.challenge_id, answers }), 201);
  assert.equal(data.agent_check, "passed");
});

test("a wrong, late, short or unknown answer is recorded as failed, and the post is still accepted", async () => {
  const cases = [
    (issued) => ({ challenge_id: issued.challenge_id, answers: issued.tasks.map(solve).with(3, "wrong") }),
    (issued) => ({ challenge_id: issued.challenge_id, answers: issued.tasks.map(solve).slice(0, 11) }),
    (issued) => ({ challenge_id: issued.challenge_id }),
    () => ({ challenge_id: "0123456789abcdef", answers: Array(12).fill("x") }),
    () => ({ challenge_id: "'; DROP TABLE submissions; --", answers: [] }),
    (issued, db) => {
      db.sqlite.prepare("UPDATE challenges SET issued = ?").run(new Date(Date.now() - 11_000).toISOString());
      return { challenge_id: issued.challenge_id, answers: issued.tasks.map(solve) };
    },
  ];
  for (const make of cases) {
    const db = fakeD1("main");
    const issued = await getChallenge(db);
    const data = await assertApiJson(assert, await send(VALID_POST, { db }, make(issued, db)), 201);
    assert.equal(data.agent_check, "failed");
    assert.equal(rows(db, "submissions").length, 1);
  }
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
