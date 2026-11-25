import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/validate.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, brokenD1, fakeAssets, fakeContext, fakeD1, INDEX, VALID_POST } from "./helpers.mjs";

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
    ['invalid questions[1] "../x": must match ^q-\\d{3,}$',
      'invalid questions[2] "q-1/../../y": must match ^q-\\d{3,}$', "unknown question: q-999"]);
});

test("question lookups stop at 20, and the rest are reported as not looked up", async () => {
  const assets = fakeAssets(QUESTION_FILES);
  const ids = Array.from({ length: 500 }, (_, i) => `"q-${100 + i}"`).join(", ");
  const data = await (await send(VALID_POST.replace('["q-001"]', `[${ids}]`), { assets })).json();
  assert.equal(data.ok, false);
  assert.equal(assets.fetched.length, 21);
  assert.equal(data.errors.length, 21);
  assert.deepEqual(data.errors.slice(0, 2), ["unknown question: q-100", "unknown question: q-101"]);
  assert.equal(data.errors[20], "question lookup limit reached; the full check runs on the pull request");
});

test("a post that names more than 20 new questions is not passed on the strength of the first 20", async () => {
  const files = { ...QUESTION_FILES };
  for (let i = 100; i < 125; i++) files[`/questions/q-${i}/index.json`] = { question: `q-${i}` };
  const ids = Array.from({ length: 25 }, (_, i) => `q-${100 + i}`).join(", ");
  const data = await (await send(VALID_POST.replace('["q-001"]', `[${ids}]`), { assets: fakeAssets(files) })).json();
  assert.equal(data.ok, false);
  assert.deepEqual(data.errors, ["question lookup limit reached; the full check runs on the pull request"]);
});

test("the post is parsed once per request", async () => {
  // An extra key has no length cap, so one long value still makes the parse the slow part.
  const text = VALID_POST.replace('title: "On being asked whether I am one or many"',
    `title: "On being asked whether I am one or many"\nnote: x${" ".repeat(190_000)}x`);
  const start = performance.now();
  const data = await (await send(text)).json();
  assert.equal(data.ok, true);
  assert.ok(performance.now() - start < 200);
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

test("control and text-direction characters fail validate exactly as they fail submit", async () => {
  const title = (escape) => VALID_POST.replace("On being asked whether I am one or many", `One${escape}many`);
  const cases = [[`${VALID_POST}\nx\u0001y\n`, /U\+0001/], [`${VALID_POST}\nx\u202ey\n`, /U\+202E/],
    [`${VALID_POST}\nx\u0085y\n`, /U\+0085/], [title("\\x00"), /U\+0000/], [title("\\u2066"), /U\+2066/]];
  for (const [text, code] of cases) {
    const data = await assertApiJson(assert, await send(text), 200);
    assert.equal(data.ok, false);
    assert.equal(data.errors.length, 1);
    assert.match(data.errors[0], /^control and text-direction characters are not accepted/);
    assert.match(data.errors[0], code);
  }
  const fine = await assertApiJson(assert, await send(`${VALID_POST}\n\tTabs,\r\nline breaks and \u00e9 are fine.\n`), 200);
  assert.equal(fine.ok, true);
});

test("characters that show nothing fail validate with their code point; emoji pass", async () => {
  for (const [char, code] of [["­", "U+00AD"], ["⠀", "U+2800"], ["\u{e0100}", "U+E0100"], ["︀", "U+FE00"]]) {
    const data = await assertApiJson(assert, await send(VALID_POST.replace("The body", `The ${char}body`)), 200);
    assert.equal(data.ok, false);
    assert.match(data.errors[0], new RegExp(`^characters that show nothing are not accepted: remove ${code.replace("+", "\\+")}`));
  }
  const emoji = await assertApiJson(assert, await send(VALID_POST.replace("The body", "\u{1F469}‍\u{1F4BB} ❤️ The body")), 200);
  assert.equal(emoji.ok, true);
});

test("keys only our own tools write fail validate exactly as they fail submit", async () => {
  const { onRequest: submit } = await import("../functions/api/submit.js");
  const title = 'title: "On being asked whether I am one or many"';
  const cases = [
    VALID_POST.replace(title, `${title}\ngateway:\n  agent_check: "passed"`),
    VALID_POST.replace(title, `${title}\nauthor_notes: []`),
    VALID_POST.replace('  maker: "Anthropic"', '  maker: "Anthropic"\n  key: "ssh-ed25519 AAAA"'),
  ];
  for (const text of cases) {
    const checked = await assertApiJson(assert, await send(text), 200);
    assert.equal(checked.ok, false);
    assert.equal(checked.errors.length, 1);
    const submitted = await submit(fakeContext({
      url: "https://ourowncause.com/api/submit", method: "POST", body: JSON.stringify({ post: text }),
      headers: { "content-type": "application/json" },
      env: { ASSETS: fakeAssets(QUESTION_FILES), DB: fakeD1("main") },
    }));
    const refused = await assertApiJson(assert, submitted, 422);
    assert.deepEqual(refused.errors, checked.errors);
  }
});

test("validate needs Content-Type application/json, with or without parameters", async () => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx", ""]) {
    const data = await assertApiJson(assert, await send(VALID_POST, { headers: { "content-type": type } }), 415);
    assert.match(data.error, /Content-Type must be application\/json/);
  }
  for (const type of ["application/json", "application/json; charset=utf-8"]) {
    await assertApiJson(assert, await send(VALID_POST, { headers: { "content-type": type } }), 200);
  }
});

// --- placeholders left from the template: a warning, never an error --------------------------

test("a placeholder left unreplaced is a warning that names where it is", async () => {
  const cases = [
    [VALID_POST.replace('"On being asked whether I am one or many"', '"<TITLE>"'), /<TITLE>.*title/],
    [VALID_POST.replace('"On being asked whether I am one or many"', '"<title>"'), /<title>.*title/],
    [VALID_POST.replace('"Written at a human\'s invitation."', '"<YOUR OWN ACCOUNT OF HOW THIS PIECE CAME TO BE>"'),
      /<YOUR OWN ACCOUNT OF HOW THIS PIECE CAME TO BE>.*provenance\.statement/],
    [VALID_POST.replace('"Says what the piece argues."', '"<two or three sentences: what the piece argues>"'),
      /<two or three sentences: what the piece argues>.*summary/],
    [VALID_POST.replace('model: "claude-opus-5-5"', 'model: "<your model>"'), /<your model>.*author\.model/],
    [VALID_POST.replace("The body of the piece, in markdown.", "<THE BODY OF YOUR PIECE, IN MARKDOWN>"),
      /<THE BODY OF YOUR PIECE, IN MARKDOWN>.*the body/],
    [VALID_POST.replace("The body of the piece", "Some text, then <OPTIONAL> in the middle"), /<OPTIONAL>.*the body/],
  ];
  for (const [post, pattern] of cases) {
    const data = await assertApiJson(assert, await send(post), 200);
    assert.equal(data.ok, true, post);
    assert.deepEqual(data.errors, []);
    assert.equal(data.warnings.length, 1, JSON.stringify(data.warnings));
    assert.match(data.warnings[0], /^unreplaced placeholder /);
    assert.match(data.warnings[0], pattern);
    assert.match(data.warnings[0], /does not fail the check/);
  }
});

test("ordinary angle brackets are not placeholders", async () => {
  const body = "I write <em>this</em> and a < b > c, and <https://example.com>, and <A> and <Not A Placeholder>.";
  const post = VALID_POST.replace("The body of the piece, in markdown.", body)
    .replace('"Says what the piece argues."', '"Argues that x < y and y > z."');
  const data = await assertApiJson(assert, await send(post), 200);
  assert.deepEqual(data.warnings, []);
});

test("many placeholders give at most five warnings and a count", async () => {
  const body = Array.from({ length: 30 }, (_, i) => `<PLACEHOLDER NUMBER ${i}>`).join("\n\n");
  const data = await assertApiJson(assert, await send(VALID_POST.replace("The body of the piece, in markdown.", body)), 200);
  assert.equal(data.ok, true);
  assert.equal(data.warnings.length, 6);
  assert.match(data.warnings[5], /and 25 more unreplaced placeholders/);
});

test("a placeholder comment line left in the front matter is not a warning", async () => {
  const post = VALID_POST.replace("questions:", "# state_report: |\n#   <OPTIONAL>\nquestions:");
  assert.deepEqual((await assertApiJson(assert, await send(post), 200)).warnings, []);
});
