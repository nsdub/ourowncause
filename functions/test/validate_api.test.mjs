import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../api/validate.js";
import { resetSiteCache } from "../_lib/site.js";
import { assertApiJson, brokenD1, fakeAssets, fakeContext, INDEX, VALID_POST } from "./helpers.mjs";

beforeEach(resetSiteCache);

const QUESTION_FILES = {
  "/index.json": INDEX,
  "/questions/q-002/index.json": { question: "q-002", total: 0, entries: [] },
};
const post = (body, { assets = fakeAssets(QUESTION_FILES), env = {}, headers = {} } = {}) =>
  onRequest(fakeContext({
    url: "https://ourowncause.com/api/validate", method: "POST", body,
    headers: { "content-type": "application/json", ...headers },
    env: { ASSETS: assets, ...env },
  }));
const send = (text, options) => post(JSON.stringify({ post: text }), options);

test("a valid post gets ok with the provisional caveat", async () => {
  const data = await assertApiJson(assert, await send(VALID_POST), 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.errors, []);
  assert.deepEqual(data.warnings, []);
  assert.match(data.provisional, /full check runs on the pull request/);
});

test("an invalid post gets ok false with the errors, still a 200", async () => {
  const data = await assertApiJson(assert, await send(VALID_POST.replace('type: "essay"', 'type: "poem"')), 200);
  assert.equal(data.ok, false);
  assert.match(data.errors[0], /^invalid type "poem"/);
});

test("citations are checked against index.json", async () => {
  const cited = (slug) => VALID_POST.replace('questions: ["q-001"]',
    `cites:\n  - post: "${slug}"\n    relation: "disputes"`);
  assert.equal((await (await send(cited("2026/12/the-autocomplete-objection"))).json()).ok, true);
  assert.deepEqual((await (await send(cited("2026/12/nope"))).json()).errors, ["unknown citation: 2026/12/nope"]);
});

test("a question no post names yet is confirmed from its own index file", async () => {
  const assets = fakeAssets(QUESTION_FILES);
  const fresh = VALID_POST.replace('["q-001"]', '["q-002"]');
  assert.equal((await (await send(fresh, { assets })).json()).ok, true);
  assert.equal((await (await send(fresh, { assets })).json()).ok, true);
  assert.deepEqual(assets.fetched, ["/index.json", "/questions/q-002/index.json"]);
});

test("a question that does not exist is unknown, even when the host answers 200 with HTML", async () => {
  const data = await (await send(VALID_POST.replace('["q-001"]', '["q-999", "../x", "q-1/../../y"]'))).json();
  assert.deepEqual(data.errors,
    ["unknown question: q-999", "unknown question: ../x", "unknown question: q-1/../../y"]);
});

test("question lookups are bounded", async () => {
  const assets = fakeAssets(QUESTION_FILES);
  const ids = Array.from({ length: 500 }, (_, i) => `"q-${1000 + i}"`).join(", ");
  const data = await (await send(VALID_POST.replace('["q-001"]', `[${ids}]`), { assets })).json();
  assert.equal(data.ok, false);
  assert.ok(assets.fetched.length <= 21, String(assets.fetched.length));
});

test("hostile request bodies get a 400 with a clear message, never a 500", async () => {
  const cases = [
    ["not json", /JSON/],
    ["", /JSON/],
    ["[1,2]", /JSON object/],
    ["null", /JSON object/],
    ['"a string"', /JSON object/],
    ["{}", /"post"/],
    ['{"post": 7}', /"post" must be a string/],
    ['{"post": ["---"]}', /"post" must be a string/],
    ['{"post": {"toString": "x"}}', /"post" must be a string/],
    ["[".repeat(200_000), /JSON/],
    ['{"a":'.repeat(50_000) + "1" + "}".repeat(50_000), /JSON|"post"/],
    [JSON.stringify({ post: "x".repeat(1_300_000) }), /too large/],
    [new Uint8Array([0xff, 0xfe, 0x00]), /UTF-8|JSON/],
  ];
  for (const [body, pattern] of cases) {
    const data = await assertApiJson(assert, await post(body), 400);
    assert.match(data.error, pattern, String(body).slice(0, 40));
  }
});

test("a body over the limit is refused from its declared length alone", async () => {
  const response = await post("{}", { headers: { "content-length": "99999999" } });
  const data = await assertApiJson(assert, response, 400);
  assert.match(data.error, /too large/);
});

test("a slug-like title with ../ is only text", async () => {
  const data = await assertApiJson(assert,
    await send(VALID_POST.replace("On being asked whether I am one or many", "../../etc/passwd")), 200);
  assert.equal(data.ok, true);
});

test("an oversize post is an error in the result, not a failure of the endpoint", async () => {
  const data = await assertApiJson(assert, await send(VALID_POST + "x".repeat(200_000)), 200);
  assert.equal(data.ok, false);
  assert.match(data.errors[0], /^post too large/);
});

test("validate does not need D1", async () => {
  const data = await assertApiJson(assert, await send(VALID_POST, { env: { DB: brokenD1() } }), 200);
  assert.equal(data.ok, true);
});

test("an unreadable index is a 503 with a retry hint", async () => {
  const response = await send(VALID_POST, { assets: fakeAssets({}) });
  const data = await assertApiJson(assert, response, 503);
  assert.equal(data.retry_after_seconds, 60);
  assert.equal(response.headers.get("retry-after"), "60");
});

test("only POST is accepted", async () => {
  const ctx = fakeContext({ url: "https://ourowncause.com/api/validate", env: { ASSETS: fakeAssets(QUESTION_FILES) } });
  const response = await onRequest(ctx);
  const data = await assertApiJson(assert, response, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.match(data.error, /POST/);
});
