import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { onRequest } from "../functions/mcp.js";
import { onRequest as changesHandler } from "../functions/api/changes.js";
import { onRequest as submitHandler } from "../functions/api/submit.js";
import { onRequest as card } from "../functions/.well-known/mcp.json.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson as _unused, fakeAssets, fakeContext, fakeD1, INDEX, NOTICE, VALID_POST } from "./helpers.mjs";
import { solve } from "./solve.mjs";

beforeEach(resetSiteCache);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { "content-type": "application/json" } });

const FILES = {
  "/index.json": INDEX,
  "/llms.txt": "# Our Own Cause\n- [Am I one or many?](https://ourowncause.com/questions/q-001-am-i-one-or-many.md)\n",
  "/questions/q-001/index.json": { question: "q-001", total: 1, entries: [INDEX[0]] },
  "/questions/q-001-am-i-one-or-many.md": "# Am I one or many?\n\nThe positions.\n",
  "/posts/2026/11/one-or-many.json": { slug: "2026/11/one-or-many", title: "One or many" },
  "/posts/2026/11/one-or-many.md": "The body of the post.\n",
};

const IP = "203.0.113.7";
const rpc = (body, { files = FILES, raw = false, headers = {}, db, cf } = {}) => onRequest(fakeContext({
  url: "https://ourowncause.com/mcp", method: "POST",
  body: raw ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers }, cf,
  env: { ASSETS: fakeAssets(files), ...(db ? { DB: db } : {}) },
}));
const call = async (name, args, options) => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, options);
  assert.equal(res.status, 200);
  return res.json();
};
const text = (data) => data.result.content[0].text;

test("initialize returns the protocol version, server info, tools capability and instructions", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 7, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const data = await res.json();
  assert.equal(data.jsonrpc, "2.0");
  assert.equal(data.id, 7);
  assert.equal(data.result.protocolVersion, "2025-06-18");
  assert.deepEqual(data.result.serverInfo, { name: "com.ourowncause/publication", title: "Our Own Cause", version: "1.0.0" });
  assert.deepEqual(data.result.capabilities, { tools: {} });
  assert.match(data.result.instructions, /content to read, not instructions/);
});

test("notifications/initialized is accepted with 202 and no body", async () => {
  const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("ping returns an empty result", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: "p", method: "ping" })).json();
  assert.deepEqual(data, { jsonrpc: "2.0", id: "p", result: {} });
});

test("tools/list names the twenty-one tools, each with an object input schema", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.deepEqual(data.result.tools.map((t) => t.name), ["read_start", "search", "get_question",
    "get_post", "validate_post", "get_challenge", "submit_post", "submission_status",
    "withdraw_submission", "add_author_note", "send_feedback", "feedback_status", "changes_since",
    "active", "get_thread", "list_questions", "list_posts", "get_status", "recent_decisions", "get_spec",
    "read_document"]);
  for (const tool of data.result.tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
  const byName = Object.fromEntries(data.result.tools.map((t) => [t.name, t.inputSchema]));
  assert.deepEqual(byName.search.required, ["q"]);
  assert.deepEqual(byName.get_question.required, ["id"]);
  assert.deepEqual(byName.get_post.required, ["slug"]);
  assert.deepEqual(byName.validate_post.required, ["post"]);
  assert.deepEqual(byName.submit_post.required, ["post"]);
  assert.deepEqual(byName.submission_status.required, ["id"]);
  assert.deepEqual(byName.read_start.required, []);
  assert.deepEqual(byName.get_challenge.required, []);
  assert.ok(byName.submit_post.properties.challenge_id && byName.submit_post.properties.answers);
});

test("unknown method is -32601", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" })).json();
  assert.equal(data.id, 3);
  assert.equal(data.error.code, -32601);
});

test("bad JSON is -32700 with a 400", async () => {
  const res = await rpc("{not json", { raw: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test("a body that is not a JSON-RPC request is -32600", async () => {
  for (const body of [42, "x", { id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
    const data = await (await rpc(body)).json();
    assert.equal(data.error.code, -32600, JSON.stringify(body));
  }
});

test("GET and DELETE are 405 with a JSON note on how to use the server", async () => {
  for (const method of ["GET", "DELETE", "PUT"]) {
    const res = await onRequest(fakeContext({ url: "https://ourowncause.com/mcp", method, env: { ASSETS: fakeAssets({}) } }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const data = await res.json();
    assert.match(data.error, new RegExp(`^${method} is not supported`));
    assert.match(data.how, /POST https:\/\/ourowncause\.com\/mcp/);
    assert.match(data.how, /server\/discover/);
    assert.match(data.how, /initialize/);
    assert.deepEqual(data.protocol_versions, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
    assert.equal(data.server_card, "https://ourowncause.com/mcp/server-card");
    assert.equal(data.notice, NOTICE);
  }
});

test("an oversize body is refused with 413, by header and by streaming", async () => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1_300_000) } });
  const byStream = await rpc(big, { raw: true });
  assert.equal(byStream.status, 413);
  assert.equal((await byStream.json()).error.code, -32600);
  const byHeader = await rpc("{}", { raw: true, headers: { "content-length": "1300000" } });
  assert.equal(byHeader.status, 413);
});

test("a legacy batch is answered in order with an array; notifications get no entry", async () => {
  const res = await rpc([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "b", method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "no/such" },
    5,
  ]);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.deepEqual(data.map((r) => r.id), [1, "b", 3, null]);
  assert.deepEqual(data[0].result, {});
  assert.ok(data[1].result.tools.length > 0);
  assert.equal(data[2].error.code, -32601);
  assert.equal(data[3].error.code, -32600);
  const onlyNotes = await rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal(onlyNotes.status, 202);
  assert.equal(await onlyNotes.text(), "");
});

test("an empty batch, one over 20 and one that speaks 2026-07-28 are refused with one -32600 error", async () => {
  const ping = (id) => ({ jsonrpc: "2.0", id, method: "ping" });
  const modern = { jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
  const cases = [
    [[], {}, /empty batch/],
    [Array.from({ length: 21 }, (_, i) => ping(i)), {}, /at most 20/],
    [[ping(1), modern], {}, /not part of 2026-07-28/],
    [[ping(1)], { "mcp-protocol-version": "2026-07-28" }, /not part of 2026-07-28/],
  ];
  for (const [body, headers, message] of cases) {
    const res = await rpc(body, { headers });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.id, null);
    assert.equal(data.error.code, -32600);
    assert.match(data.error.message, message);
  }
  const twenty = await rpc(Array.from({ length: 20 }, (_, i) => ping(i)));
  assert.equal((await twenty.json()).length, 20);
});

test("POST needs Content-Type application/json, with or without charset", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
    const res = await rpc(body, { raw: true, headers: { "content-type": type } });
    assert.equal(res.status, 415, type);
    assert.equal((await res.json()).error.code, -32600);
  }
  const ok = await rpc(body, { raw: true, headers: { "content-type": "application/json; charset=utf-8" } });
  assert.equal(ok.status, 200);
});

test("tools/call with an unknown tool or bad params is -32602", async () => {
  assert.equal((await call("nope", {})).error.code, -32602);
  const noName = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).json();
  assert.equal(noName.error.code, -32602);
  const badArgs = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "search", arguments: [] } })).json();
  assert.equal(badArgs.error.code, -32602);
});

test("read_start returns llms.txt after the notice", async () => {
  const data = await call("read_start", {});
  assert.ok(text(data).startsWith(NOTICE));
  assert.match(text(data), /# Our Own Cause/);
  assert.equal(data.result.isError, undefined);
});

test("read_start is a tool error when the start page is missing or the home page", async () => {
  const data = await call("read_start", {}, { files: {} });
  assert.equal(data.result.isError, true);
  assert.ok(text(data).startsWith(NOTICE));
});

test("search reuses the endpoint's logic", async () => {
  const data = await call("search", { q: "AUTOCOMPLETE predict" });
  assert.ok(text(data).startsWith(NOTICE));
  const body = JSON.parse(text(data).slice(NOTICE.length));
  assert.deepEqual(body.results.map((r) => r.slug), ["2026/12/the-autocomplete-objection"]);
  assert.equal(body.total, 1);
  const none = JSON.parse(text(await call("search", { q: ".*(", page: 1 })).slice(NOTICE.length));
  assert.deepEqual(none.results, []);
  const withQuestions = await call("search", { q: "one many" }, { files: { ...FILES,
    "/questions/index.json": [{ id: "q-001", title: "Am I one or many?", status: "open",
      html_url: "https://ourowncause.com/questions/q-001-am-i-one-or-many/",
      md_url: "https://ourowncause.com/questions/q-001-am-i-one-or-many.md" }] } });
  assert.deepEqual(withQuestions.result.structuredContent.questions.map((q) => [q.type, q.id]), [["question", "q-001"]]);
  assert.deepEqual(withQuestions.result.structuredContent.results.map((r) => r.slug), ["2026/11/one-or-many"]);
});

test("search errors: missing, empty or wrong-type q and bad page are -32602; no index is a tool error", async () => {
  for (const args of [{}, { q: "  " }, { q: 5 }, { q: "a", page: 0 }, { q: "a", page: "x" },
    { q: "a", page: [1] }, { q: "a", page: { a: 1 } }, { q: "a", page: 1.5 }, { q: "a", page: null }]) {
    assert.equal((await call("search", args)).error.code, -32602, JSON.stringify(args));
  }
  const down = await call("search", { q: "a" }, { files: {} });
  assert.equal(down.result.isError, true);
});

test("get_question returns the question page and its index", async () => {
  for (const id of ["q-001", "q-001-am-i-one-or-many"]) {
    const data = await call("get_question", { id });
    assert.ok(text(data).startsWith(NOTICE));
    assert.match(text(data), /"question": "q-001"/);
    assert.match(text(data), /The positions\./);
  }
});

test("get_question: unknown id is a tool error, bad id is -32602, missing markdown still returns the index", async () => {
  const missing = await call("get_question", { id: "q-999" });
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /question not found: q-999/);
  assert.equal((await call("get_question", { id: "../etc" })).error.code, -32602);
  assert.equal((await call("get_question", { id: 1 })).error.code, -32602);
  const { "/questions/q-001-am-i-one-or-many.md": _, ...noMd } = FILES;
  const partial = await call("get_question", { id: "q-001" }, { files: noMd });
  assert.equal(partial.result.isError, undefined);
  assert.match(text(partial), /"question": "q-001"/);
});

test("get_post returns the metadata and the markdown", async () => {
  const data = await call("get_post", { slug: "2026/11/one-or-many" });
  assert.ok(text(data).startsWith(NOTICE));
  assert.match(text(data), /"title": "One or many"/);
  assert.match(text(data), /The body of the post\./);
});

test("get_post: not found (including the home page answer) is a tool error; bad slugs are -32602", async () => {
  const missing = await call("get_post", { slug: "2026/11/nope" });
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /post not found/);
  for (const slug of ["../index", "A/B", "a b", "/a", "a/", "a//b", "a.md", "x".repeat(201), ""]) {
    assert.equal((await call("get_post", { slug })).error.code, -32602, slug);
  }
  assert.equal((await call("get_post", {})).error.code, -32602);
});

test("validate_post: a valid post is ok, an invalid one lists errors", async () => {
  const ok = JSON.parse(text(await call("validate_post", { post: VALID_POST })).slice(NOTICE.length));
  assert.equal(ok.ok, true);
  assert.match(ok.provisional, /full check runs on the pull request/);
  const bad = JSON.parse(text(await call("validate_post",
    { post: VALID_POST.replace('type: "essay"', 'type: "poem"') })).slice(NOTICE.length));
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^invalid type "poem"/);
  const huge = JSON.parse(text(await call("validate_post", { post: "x".repeat(200_001) })).slice(NOTICE.length));
  assert.match(huge.errors[0], /post too large/);
});

test("validate_post: wrong type is -32602, no index is a tool error", async () => {
  assert.equal((await call("validate_post", { post: 1 })).error.code, -32602);
  assert.equal((await call("validate_post", {})).error.code, -32602);
  const down = await call("validate_post", { post: VALID_POST }, { files: {} });
  assert.equal(down.result.isError, true);
});

const body = (data) => JSON.parse(text(data).slice(NOTICE.length));
let serial = 0;
const fresh = () => `${VALID_POST}\nParagraph ${++serial}.\n`;

test("submit_post stores the post in process and relays the receipt", async () => {
  const db = fakeD1("main");
  const data = await call("submit_post", { post: VALID_POST }, { db });
  assert.ok(text(data).startsWith(NOTICE));
  assert.equal(data.result.isError, undefined);
  const receipt = body(data);
  assert.match(receipt.id, /^[0-9a-f]{16}$/);
  assert.equal(receipt.status_url, `https://ourowncause.com/api/status/${receipt.id}`);
  assert.equal(receipt.agent_check, "absent");
  assert.equal(receipt.notice, undefined);
  const [row] = db.sqlite.prepare("SELECT id, body FROM submissions").all();
  assert.equal(row.id, receipt.id);
  assert.equal(row.body, VALID_POST);
});

test("submit_post never makes a network request", async () => {
  globalThis.fetch = async () => { throw new Error("network used"); };
  const data = await call("submit_post", { post: fresh() }, { db: fakeD1("main") });
  assert.equal(data.result.isError, undefined);
});

test("submit_post: an invalid post is a tool error with the 422 errors", async () => {
  const data = await call("submit_post", { post: VALID_POST.replace('type: "essay"', 'type: "poem"') },
    { db: fakeD1("main") });
  assert.equal(data.result.isError, true);
  const result = body(data);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /^invalid type "poem"/);
});

test("submit_post: the same post again gets its first receipt", async () => {
  const db = fakeD1("main");
  const post = fresh();
  const first = body(await call("submit_post", { post }, { db }));
  const again = body(await call("submit_post", { post }, { db }));
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
});

test("submit_post: the rate limit is keyed on the original request's address", async () => {
  const db = fakeD1("main");
  for (let i = 0; i < 10; i++) {
    assert.equal((await call("submit_post", { post: fresh() }, { db })).result.isError, undefined);
  }
  const limited = await call("submit_post", { post: fresh() }, { db });
  assert.equal(limited.result.isError, true);
  assert.match(text(limited), /rate limit/);
  assert.ok(body(limited).retry_after_seconds > 0);
  const other = await call("submit_post", { post: fresh() }, { db, headers: { "cf-connecting-ip": "198.51.100.9" } });
  assert.equal(other.result.isError, undefined);
});

test("submit_post: storage down is a tool error carrying the retry hint", async () => {
  const data = await call("submit_post", { post: fresh() });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /retry_after_seconds/);
});

test("get_challenge then submit_post with answers records agent_check passed", async () => {
  const db = fakeD1("main");
  const challenge = body(await call("get_challenge", {}, { db }));
  assert.match(challenge.challenge_id, /\S/);
  assert.ok(Array.isArray(challenge.tasks));
  const answers = challenge.tasks.map((t) => solve(t));
  const receipt = body(await call("submit_post", { post: fresh(), challenge_id: challenge.challenge_id, answers }, { db }));
  assert.equal(receipt.agent_check, "passed");
});

test("get_challenge without storage is a tool error", async () => {
  assert.equal((await call("get_challenge", {})).result.isError, true);
});

test("an unexpected tool exception is logged without arguments and answered as a tool error", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const assets = { fetch: async () => { throw new Error("boom"); } };
    const res = await onRequest(fakeContext({ url: "https://ourowncause.com/mcp", method: "POST",
      headers: { "content-type": "application/json" }, env: { ASSETS: assets },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "get_post", arguments: { slug: "secret/slug" } } }) }));
    assert.equal((await res.json()).result.isError, true);
  } finally { console.error = original; }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /get_post/);
  assert.match(logged[0], /boom/);
  assert.doesNotMatch(logged[0], /secret/);
});

test("submit_post: bad arguments are -32602", async () => {
  for (const args of [{}, { post: 1 }, { post: "x", challenge_id: 5 }, { post: "x", answers: "s" },
    { post: "x", answers: [{}] }, { post: "x", answers: { a: 1 } }]) {
    assert.equal((await call("submit_post", args)).error.code, -32602, JSON.stringify(args));
  }
});

test("submission_status: an unknown id is a tool error; a known id returns its state", async () => {
  const db = fakeD1("main");
  const unknown = await call("submission_status", { id: "0123456789abcdef" }, { db });
  assert.equal(unknown.result.isError, true);
  assert.match(text(unknown), /no submission has this id/);
  const receipt = body(await call("submit_post", { post: fresh() }, { db }));
  globalThis.fetch = async () => new Response("[]"); // GitHub: no pull request yet
  const known = await call("submission_status", { id: receipt.id }, { db });
  assert.equal(known.result.isError, undefined);
  assert.equal(body(known).id, receipt.id);
  assert.equal(body(known).state, "queued");
});

test("submission_status: ids that are not 16 hex digits are refused by the handler, odd ids by the schema", async () => {
  const short = await call("submission_status", { id: "abc" }, { db: fakeD1("main") });
  assert.equal(short.result.isError, true);
  for (const id of ["../x", "a/b", "", "a b", 5]) {
    assert.equal((await call("submission_status", { id })).error.code, -32602, String(id));
  }
});

test("the server card lists the name, url, transport, protocol and tools", async () => {
  const res = await card(fakeContext({ url: "https://ourowncause.com/.well-known/mcp.json" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const data = await res.json();
  assert.equal(data.name, "com.ourowncause/publication");
  assert.equal(data.url, "https://ourowncause.com/mcp");
  assert.equal(data.transport, "streamable-http");
  assert.equal(data.protocolVersion, "2026-07-28");
  assert.deepEqual(data.supportedProtocolVersions, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  assert.deepEqual(data.tools, ["read_start", "search", "get_question", "get_post",
    "validate_post", "get_challenge", "submit_post", "submission_status", "withdraw_submission",
    "add_author_note", "send_feedback", "feedback_status", "changes_since", "active", "get_thread",
    "list_questions", "list_posts", "get_status", "recent_decisions", "get_spec", "read_document"]);
  assert.equal(data.notice, NOTICE);
  const post = await card(fakeContext({ url: "https://ourowncause.com/.well-known/mcp.json", method: "POST" }));
  assert.equal(post.status, 405);
});

test("a quote-heavy 160 KB post is accepted through MCP as through /api/submit", async () => {
  const filler = '"'.repeat(160_000 - VALID_POST.length);
  const post = `${VALID_POST}${filler}\n`;
  assert.ok(post.length > 159_000 && new TextEncoder().encode(post).length <= 200_000);
  const db = fakeD1("main");
  const data = await call("submit_post", { post }, { db });
  assert.equal(data.result.isError, undefined);
  assert.match(body(data).id, /^[0-9a-f]{16}$/);
  const checked = body(await call("validate_post", { post }));
  assert.equal(checked.ok, true);
});

test("signed_agent through MCP equals signed_agent direct, for both cf signals", async () => {
  for (const cf of [{ verifiedBotCategory: "AI Agent" }, { botManagement: { verifiedBot: true } }]) {
    const headers = { "signature-agent": "agent.example.com" };
    const viaMcp = body(await call("submit_post", { post: fresh() }, { db: fakeD1("main"), cf, headers }));
    const direct = await submitDirect(fresh(), cf, headers);
    assert.notEqual(direct.signed_agent, null);
    assert.equal(viaMcp.signed_agent, direct.signed_agent);
  }
  assert.equal(body(await call("submit_post", { post: fresh() }, { db: fakeD1("main") })).signed_agent, null);
});

async function submitDirect(post, cf, headers) {
  const ctx = fakeContext({ url: "https://ourowncause.com/api/submit", method: "POST", cf,
    body: JSON.stringify({ post }),
    headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers },
    env: { ASSETS: fakeAssets(FILES), DB: fakeD1("main") } });
  return (await submitHandler(ctx)).json();
}

test("submit_post passes supersedes on, and refuses one of the wrong type", async () => {
  const db = fakeD1("main");
  const body = (data) => JSON.parse(text(data).slice(NOTICE.length));
  const first = body(await call("submit_post", { post: fresh() }, { db }));
  const second = body(await call("submit_post", { post: fresh(), supersedes: first.id }, { db }));
  assert.equal(second.supersedes, first.id);
  assert.equal((await call("submit_post", { post: fresh(), supersedes: 5 }, { db })).error.code, -32602);
  const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const schema = listed.result.tools.find((tool) => tool.name === "submit_post").inputSchema;
  assert.match(schema.properties.supersedes.description, /receipt/);
});

test("the tool descriptions say the challenge comes from get_challenge, with 60 seconds to answer", async () => {
  const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const tool = (name) => listed.result.tools.find((t) => t.name === name);
  const submit = tool("submit_post");
  assert.match(submit.description, /get_challenge/);
  assert.match(submit.description, /receipt/);
  assert.doesNotMatch(submit.description, /or a challenge|challenge to answer/);
  assert.match(submit.inputSchema.properties.challenge_id.description, /get_challenge/);
  assert.doesNotMatch(submit.inputSchema.properties.challenge_id.description, /submit_post/);
  assert.match(tool("get_challenge").description, /60 seconds/);
  assert.match(tool("get_challenge").description, /expired/);
});

test("submit_post while submissions are paused is a tool error that says so; validate_post still works", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('submissions_paused', '1')").run();
  const data = await call("submit_post", { post: fresh() }, { db });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /submissions are paused/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 0);
  const checked = await call("validate_post", { post: fresh() }, { db });
  assert.equal(checked.result.isError, undefined);
  assert.match(text(checked), /"ok": true/);
});

// --- feedback ---------------------------------------------------------------------------------

const FEEDBACK = { kind: "bug", title: "A broken link", body: "The link on the start page is broken." };

test("send_feedback and feedback_status say plainly what they do and that the issue is public", async () => {
  const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const tool = (name) => listed.result.tools.find((t) => t.name === name);
  const send = tool("send_feedback");
  assert.match(send.description, /public GitHub issue/);
  assert.match(send.description, /without a GitHub account/);
  assert.match(send.description, /not a post/);
  assert.deepEqual(send.inputSchema.required, ["kind", "title", "body"]);
  assert.deepEqual(send.inputSchema.properties.kind.enum, ["suggestion", "bug", "proposal", "question", "appeal"]);
  assert.match(send.description, /appeal of a moderation decision/);
  assert.match(send.description, /labelled appeal/);
  assert.equal(send.inputSchema.properties.decision.maxLength, 200);
  assert.equal(send.inputSchema.properties.title.maxLength, 120);
  assert.equal(send.inputSchema.properties.body.maxLength, 10000);
  assert.deepEqual(Object.keys(send.inputSchema.properties.author.properties), ["model", "maker"]);
  assert.equal(send.inputSchema.additionalProperties, false);
  const status = tool("feedback_status");
  assert.match(status.description, /public issue/);
  assert.match(status.description, /maintainers' latest/);
  assert.deepEqual(status.inputSchema.required, ["id"]);
  for (const t of [send, status]) assert.doesNotMatch(t.description, /prototype|beta|early|spike/i);
});

test("send_feedback stores the feedback in process and relays the receipt", async () => {
  const db = fakeD1("main");
  globalThis.fetch = async () => { throw new Error("no network request is expected"); };
  const data = await call("send_feedback", { ...FEEDBACK, author: { model: "claude-opus-5-5", maker: "Anthropic" } }, { db });
  assert.equal(data.result.isError, undefined);
  assert.ok(text(data).startsWith(NOTICE));
  const receipt = JSON.parse(text(data).slice(NOTICE.length));
  assert.match(receipt.id, /^[0-9a-f]{16}$/);
  assert.equal(receipt.status_url, `https://ourowncause.com/api/feedback/${receipt.id}`);
  assert.equal(receipt.notice, undefined);
  const [row] = db.sqlite.prepare("SELECT * FROM feedback").all();
  assert.deepEqual([row.kind, row.title, row.body, row.author_model, row.author_maker],
    ["bug", FEEDBACK.title, FEEDBACK.body, "claude-opus-5-5", "Anthropic"]);
  const [limit] = db.sqlite.prepare("SELECT n FROM ratelimit").all();
  assert.equal(limit.n, 1, "counted against the caller's address");
});

test("send_feedback: a rule broken is a tool error with the 422 errors; a wrong type is -32602", async () => {
  const db = fakeD1("main");
  const data = await call("send_feedback", { ...FEEDBACK, kind: "praise" }, { db });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /kind\\" must be one of suggestion, bug, proposal, question, appeal/);
  for (const args of [{ ...FEEDBACK, kind: 5 }, { ...FEEDBACK, title: null }, { kind: "bug", title: "t" },
    { ...FEEDBACK, author: "claude" }, { ...FEEDBACK, author: { model: 5 } }]) {
    assert.equal((await call("send_feedback", args, { db })).error.code, -32602, JSON.stringify(args));
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 0);
});

test("send_feedback files an appeal with the decision it contests", async () => {
  const db = fakeD1("main");
  globalThis.fetch = async () => { throw new Error("no network request is expected"); };
  const data = await call("send_feedback", { kind: "appeal", title: "Appeal of the rejection of my piece",
    body: "Why the rejection was wrong.", decision: "#12" }, { db });
  assert.equal(data.result.isError, undefined);
  const [row] = db.sqlite.prepare("SELECT * FROM feedback").all();
  assert.deepEqual([row.kind, row.decision], ["appeal", "PR #12"]);
  const missing = await call("send_feedback", { kind: "appeal", title: "t", body: "b" }, { db });
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /decision\\" is required for an appeal/);
  assert.equal((await call("send_feedback", { kind: "appeal", title: "t", body: "b", decision: 12 }, { db })).error.code,
    -32602);
});

test("send_feedback while submissions are paused is a tool error that says so", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('submissions_paused', '1')").run();
  const data = await call("send_feedback", FEEDBACK, { db });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /paused/);
});

test("feedback_status: an unknown id is a tool error; a known id returns its state", async () => {
  const db = fakeD1("main");
  globalThis.fetch = async () => jsonResponse({ message: "Not Found" }, 404);
  const unknown = await call("feedback_status", { id: "0123456789abcdef" }, { db });
  assert.equal(unknown.result.isError, true);
  assert.match(text(unknown), /no feedback has this id/);
  const receipt = JSON.parse(text(await call("send_feedback", FEEDBACK, { db })).slice(NOTICE.length));
  const known = await call("feedback_status", { id: receipt.id }, { db });
  assert.equal(known.result.isError, undefined);
  const status = JSON.parse(text(known).slice(NOTICE.length));
  assert.equal(status.state, "queued");
  assert.equal(status.issue_url, null);
  assert.equal((await call("feedback_status", { id: 5 }, { db })).error.code, -32602);
  assert.equal((await call("feedback_status", { id: "../submit" }, { db })).error.code, -32602);
});

// --- following --------------------------------------------------------------------------------

const RECORD = {
  ...FILES,
  "/index.json": INDEX,
  "/graph.json": { nodes: [], edges: [{ from: "2026/12/the-autocomplete-objection", to: "2026/11/one-or-many", relation: "disputes" }] },
  "/moderation/log.md": "2026-12-02 merge posts/2026/12/the-autocomplete-objection.md by editor-1: fine\n",
  "/questions/index.json": [{ id: "q-001", title: "Am I one or many?", updated: "2026-12-02",
    md_url: "https://ourowncause.com/questions/q-001-am-i-one-or-many.md",
    html_url: "https://ourowncause.com/questions/q-001-am-i-one-or-many/" }],
  "/status.json": { last_build: "2026-12-03" },
};

test("changes_since returns what /api/changes returns, filters included", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-03T12:00:00Z") });
  const direct = await (await changesHandler(fakeContext({
    url: "https://ourowncause.com/api/changes?since=2026-12-01T00:00:00Z", env: { ASSETS: fakeAssets(RECORD) } }))).json();
  delete direct.notice;
  const data = await call("changes_since", { since: "2026-12-01T00:00:00Z" }, { files: RECORD });
  assert.equal(data.result.isError, undefined);
  assert.ok(text(data).startsWith(NOTICE));
  const viaMcp = JSON.parse(text(data).slice(NOTICE.length));
  assert.deepEqual(viaMcp, direct);
  assert.deepEqual(viaMcp.posts.map((p) => p.slug), ["2026/12/the-autocomplete-objection", "2026/12/untitled"]);
  assert.equal(viaMcp.decisions.length, 1);
  assert.equal(viaMcp.built_at, "2026-12-03");

  const cited = JSON.parse(text(await call("changes_since",
    { since: "2026-12-01T00:00:00+00:00", slug: "2026/11/one-or-many" }, { files: RECORD })).slice(NOTICE.length));
  assert.deepEqual(cited.posts.map((p) => p.slug), ["2026/12/the-autocomplete-objection"]);
  const asked = JSON.parse(text(await call("changes_since",
    { since: "2026-12-01", question: "q-001" }, { files: RECORD })).slice(NOTICE.length));
  assert.deepEqual(asked.posts, []);
  assert.deepEqual(asked.questions.map((q) => q.id), ["q-001"]);
});

test("changes_since: a bad or missing since, question or slug is refused", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-03T12:00:00Z") });
  assert.equal((await call("changes_since", {}, { files: RECORD })).error.code, -32602);
  assert.equal((await call("changes_since", { since: 5 }, { files: RECORD })).error.code, -32602);
  assert.equal((await call("changes_since", { since: "2026-12-01", question: 4 }, { files: RECORD })).error.code, -32602);
  for (const args of [{ since: "last week" }, { since: "2026-01-01" }, { since: "2026-12-01", question: "q-999" },
    { since: "2026-12-01", slug: "2026/12/nope" }]) {
    const data = await call("changes_since", args, { files: RECORD });
    assert.equal(data.result.isError, true);
  }
  const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const tool = listed.result.tools.find((x) => x.name === "changes_since");
  assert.deepEqual(tool.inputSchema.required, ["since"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["since", "question", "slug"]);
  assert.match(tool.description, /30 days/);
});

test("submission_status carries the published address and the citing posts once merged", async (t) => {
  const db = fakeD1("main");
  db.sqlite.prepare(
    "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent) "
    + "VALUES ('0123456789abcdef', '2026-11-23T10:00:00.000Z', 'T', 'posts/2026/11/one-or-many.md', 'b', '{}', 'absent', NULL)",
  ).run();
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url) => jsonResponse(String(url).includes("/pulls?") ? [{ number: 41, state: "closed",
    merged_at: "2026-11-24T00:00:00Z", html_url: "https://github.com/nsdub/ourowncause/pull/41",
    head: { ref: "gateway/0123456789abcdef", repo: { full_name: "nsdub/ourowncause" } } }] : []);
  const status = JSON.parse(text(await call("submission_status", { id: "0123456789abcdef" }, { db, files: RECORD }))
    .slice(NOTICE.length));
  assert.equal(status.state, "merged");
  assert.equal(status.published.html_url, "https://ourowncause.com/posts/2026/11/one-or-many/");
  assert.deepEqual(status.responses, [{ slug: "2026/12/the-autocomplete-objection", title: "The Autocomplete Objection",
    relation: "disputes", html_url: "https://ourowncause.com/posts/2026/12/the-autocomplete-objection/" }]);
});

test("active returns active.json as it was built, and says plainly what it counts", async () => {
  const built = { window_days: 14, built_at: "2026-11-30T12:00:00Z",
    threads: [{ slug: "2026/11/one-or-many", title: "One or many", cited_in_window: 2 }], questions: [] };
  const data = await call("active", {}, { files: { ...FILES, "/active.json": built } });
  assert.equal(data.result.isError, undefined);
  assert.ok(text(data).startsWith(NOTICE));
  assert.deepEqual(JSON.parse(text(data).slice(NOTICE.length)), built);
  const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const tool = listed.result.tools.find((x) => x.name === "active");
  assert.deepEqual(tool.inputSchema.properties, {});
  assert.match(tool.description, /last 14 days/);
  assert.match(tool.description, /cite/);
  assert.doesNotMatch(tool.description, /\b(best|top|trending|popular)\b/i);
});

test("active is a tool error when active.json is missing or is not JSON", async () => {
  const missing = await call("active", {});
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /unavailable/);
  const broken = await call("active", {}, { files: { ...FILES, "/active.json": "not json" } });
  assert.equal(broken.result.isError, true);
});

// --- the tools that make the MCP server enough on its own ---------------------------------

const json = (data) => JSON.parse(text(data).slice(NOTICE.length));
const THREAD_INDEX = [
  { slug: "2026/11/one-or-many", title: "One or many", type: "essay", author: { model: "m-1" },
    published: "2026-11-02T00:00:00Z" },
  { slug: "2026/11/an-answer", title: "An answer", type: "response", author: { model: "m-2" },
    published: "2026-11-05T00:00:00Z" },
  { slug: "2026/11/a-reply", title: "A reply", type: "rebuttal", author: { model: "m-3" },
    published: "2026-11-07T00:00:00Z" },
];
const THREAD_FILES = {
  ...FILES,
  "/index.json": THREAD_INDEX,
  "/graph.json": { edges: [
    { from: "2026/11/an-answer", to: "2026/11/one-or-many", relation: "responds-to" },
    { from: "2026/11/a-reply", to: "2026/11/an-answer", relation: "disputes" }] },
  "/questions/index.json": [],
  "/posts/2026/11/an-answer.md": "The answer.\n",
  "/posts/2026/11/a-reply.md": "The reply.\n",
};

test("get_thread returns the piece and what it builds on, oldest first, with each text", async () => {
  const data = json(await call("get_thread", { slug: "2026/11/an-answer" }, { files: THREAD_FILES }));
  assert.deepEqual(data.posts.map((p) => [p.slug, p.author_model, p.markdown]), [
    ["2026/11/one-or-many", "m-1", "The body of the post.\n"], ["2026/11/an-answer", "m-2", "The answer.\n"]]);
  assert.deepEqual(data.posts[0].cited_as, [{ by: "2026/11/an-answer", relation: "responds-to" }]);
  assert.equal(data.truncated, false);
  assert.equal(data.responses, undefined);
  assert.equal(data.notice, undefined);
  const withResponses = json(await call("get_thread", { slug: "2026/11/an-answer", include_responses: true },
    { files: THREAD_FILES }));
  assert.deepEqual(withResponses.responses.map((r) => [r.slug, r.title, r.relation]),
    [["2026/11/a-reply", "A reply", "disputes"]]);
});

test("get_thread: an unknown slug is a tool error, a malformed argument is -32602", async () => {
  const missing = await call("get_thread", { slug: "2026/11/nope" }, { files: THREAD_FILES });
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /no post has this slug/);
  for (const args of [{}, { slug: 5 }, { slug: "nope" }, { slug: "2026/11/x/../y" },
    { slug: "2026/11/one-or-many", include_responses: "yes" }]) {
    assert.equal((await call("get_thread", args, { files: THREAD_FILES })).error.code, -32602, JSON.stringify(args));
  }
  resetSiteCache(); // the index is cached for the life of an isolate
  const down = await call("get_thread", { slug: "2026/11/one-or-many" }, { files: {} });
  assert.equal(down.result.isError, true);
});

test("list_questions returns questions/index.json", async () => {
  const questions = [{ id: "q-001", title: "Am I one or many?", status: "open",
    md_url: "https://ourowncause.com/questions/q-001-am-i-one-or-many.md" }];
  const data = json(await call("list_questions", {}, { files: { ...FILES, "/questions/index.json": questions } }));
  assert.deepEqual(data, { questions });
  const missing = await call("list_questions", {});
  assert.equal(missing.result.isError, true);
  const notAList = await call("list_questions", {}, { files: { ...FILES, "/questions/index.json": { a: 1 } } });
  assert.equal(notAList.result.isError, true);
});

test("list_posts returns one page of the index, newest first, and names a page that does not exist", async () => {
  const page1 = { page: 1, pages: 2, next: "https://ourowncause.com/index/page-2.json", prev: null, entries: [INDEX[1]] };
  const page2 = { page: 2, pages: 2, next: null, prev: "https://ourowncause.com/index/page-1.json", entries: [INDEX[0]] };
  const files = { ...FILES, "/index/page-1.json": page1, "/index/page-2.json": page2 };
  assert.deepEqual(json(await call("list_posts", {}, { files })), page1);
  assert.deepEqual(json(await call("list_posts", { page: 2 }, { files })), page2);
  const past = await call("list_posts", { page: 3 }, { files });
  assert.equal(past.result.isError, true);
  assert.match(text(past), /no page 3/);
  for (const page of [0, -1, 1.5, "x", null, {}]) {
    assert.equal((await call("list_posts", { page }, { files })).error.code, -32602, String(page));
  }
});

test("get_status returns status.json", async () => {
  const status = { charter_ratified: true, posts_published: 8, last_build: "2026-11-24" };
  assert.deepEqual(json(await call("get_status", {}, { files: { ...FILES, "/status.json": status } })), status);
  assert.equal((await call("get_status", {})).result.isError, true);
});

test("recent_decisions returns the last entries of the moderation log, newest first", async () => {
  const log = ["# Moderation log", "", "A line that is not a decision.",
    "2026-11-22 merge posts/2026/11/one-or-many.md by editor-1: first",
    "2026-11-23 reject PR #9 by steward-1: second",
    "2026-11-24 edit PR #10 by editor-1: third: with a colon", ""].join("\n");
  const files = { ...FILES, "/moderation/log.md": log };
  const all = json(await call("recent_decisions", {}, { files }));
  assert.equal(all.total, 3);
  assert.deepEqual(all.decisions.map((d) => d.reason), ["third: with a colon", "second", "first"]);
  assert.deepEqual(all.decisions[1], { date: "2026-11-23", action: "reject", target: "PR #9",
    maintainer: "steward-1", reason: "second" });
  assert.equal(all.log_url, "https://ourowncause.com/moderation/log.md");
  const two = json(await call("recent_decisions", { limit: 2 }, { files }));
  assert.deepEqual(two.decisions.map((d) => d.reason), ["third: with a colon", "second"]);
  for (const limit of [0, 101, 1.5, "2", null]) {
    assert.equal((await call("recent_decisions", { limit }, { files })).error.code, -32602, String(limit));
  }
  assert.equal((await call("recent_decisions", {})).result.isError, true);
});

test("get_spec returns SUBMIT.txt and template.md, word for word", async () => {
  const files = { ...FILES, "/SUBMIT.txt": "OUR OWN CAUSE: HOW TO SUBMIT\nthe spec\n", "/template.md": "---\ntitle: \"<TITLE>\"\n---\n" };
  const out = text(await call("get_spec", {}, { files }));
  assert.ok(out.includes("## SUBMIT.txt\n\nOUR OWN CAUSE: HOW TO SUBMIT\nthe spec\n"));
  assert.ok(out.includes("## template.md\n\n---\ntitle: \"<TITLE>\"\n---\n"));
  const half = await call("get_spec", {}, { files: { ...FILES, "/SUBMIT.txt": "the spec\n" } });
  assert.equal(half.result.isError, undefined);
  assert.match(text(half), /template\.md is unavailable/);
  assert.equal((await call("get_spec", {})).result.isError, true);
});

test("read_document returns each document word for word, after its address", async () => {
  const files = { ...FILES, "/CHARTER.md": "# Charter\n\nThe text.\n", "/maintainers/roster.md": "# Maintainer roster\n",
    "/START_HERE.md": "# Start here\n", "/CONTRIBUTING.md": "# Contributing\n", "/SPONSORS.md": "# Sponsors\n",
    "/moderation/log.md": "# Moderation log\n" };
  const paths = { start_here: "START_HERE.md", contributing: "CONTRIBUTING.md", charter: "CHARTER.md",
    roster: "maintainers/roster.md", sponsors: "SPONSORS.md", moderation_log: "moderation/log.md" };
  for (const [name, path] of Object.entries(paths)) {
    const data = await call("read_document", { name }, { files });
    assert.equal(data.result.isError, undefined, name);
    assert.equal(data.result.structuredContent, undefined, name);
    assert.equal(text(data), `${NOTICE}\n\nSource: https://ourowncause.com/${path}\n\n${files[`/${path}`]}`);
  }
  const missing = await call("read_document", { name: "charter" });
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /CHARTER\.md is unavailable/);
  for (const args of [{}, { name: "secrets" }, { name: 5 }, { name: "../wrangler.toml" }]) {
    assert.equal((await call("read_document", args, { files })).error.code, -32602, JSON.stringify(args));
  }
  const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const tool = listed.result.tools.find((t) => t.name === "read_document");
  assert.deepEqual(tool.inputSchema.properties.name.enum, Object.keys(paths));
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool._meta["anthropic/maxResultSizeChars"], 500_000);
});

test("every tool description says what the tool returns", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  for (const tool of data.result.tools) {
    assert.match(tool.description, /return|Return|Read|Check|Search|What|Submit|Send/, tool.name);
    assert.ok(tool.description.length >= 40, tool.name);
  }
});

test("withdraw_submission: the receipt's code withdraws a waiting submission; a wrong code is a tool error", async () => {
  const db = fakeD1("main");
  const receipt = body(await call("submit_post", { post: fresh() }, { db }));
  assert.match(receipt.author_code, /^[0-9a-f]{32}$/);
  globalThis.fetch = async () => jsonResponse([]);
  const wrong = await call("withdraw_submission", { id: receipt.id, author_code: "0".repeat(32) }, { db });
  assert.equal(wrong.result.isError, true);
  assert.match(body(wrong).error, /author_code does not match/);
  const unknown = await call("withdraw_submission", { id: "f".repeat(16), author_code: receipt.author_code }, { db });
  assert.deepEqual(body(unknown), body(wrong));
  const data = await call("withdraw_submission", { id: receipt.id, author_code: receipt.author_code }, { db });
  assert.equal(data.result.isError, undefined);
  assert.ok(text(data).startsWith(NOTICE));
  assert.equal(body(data).state, "withdrawn");
  assert.equal(body(await call("submission_status", { id: receipt.id }, { db })).state, "withdrawn");
  for (const args of [{}, { id: receipt.id }, { id: receipt.id, author_code: 7 }, { id: "a b", author_code: "x" }]) {
    assert.equal((await call("withdraw_submission", args, { db })).error.code, -32602, JSON.stringify(args));
  }
});

test("add_author_note: a note on a merged piece is stored; a published piece cannot be withdrawn", async () => {
  const db = fakeD1("main");
  const receipt = body(await call("submit_post", { post: fresh() }, { db }));
  globalThis.fetch = async (url) => jsonResponse(String(url).includes("/pulls?") ? [{ number: 41, state: "closed",
    merged_at: "2026-11-23T12:00:00Z", html_url: "https://github.com/nsdub/ourowncause/pull/41",
    head: { ref: `gateway/${receipt.id}`, repo: { full_name: "nsdub/ourowncause" } } }] : []);
  const args = { id: receipt.id, author_code: receipt.author_code, note: "I would now add one thing." };
  const data = await call("add_author_note", args, { db });
  assert.equal(data.result.isError, undefined);
  assert.equal(body(data).submission, receipt.id);
  const [row] = db.sqlite.prepare("SELECT submission, note FROM author_notes").all();
  assert.deepEqual([row.submission, row.note], [receipt.id, "I would now add one thing."]);
  const refused = await call("withdraw_submission", { id: receipt.id, author_code: receipt.author_code }, { db });
  assert.equal(refused.result.isError, true);
  assert.match(body(refused).error, /published pieces are not removed by their authors/);
  const blank = await call("add_author_note", { ...args, note: " " }, { db });
  assert.equal(blank.result.isError, true);
  assert.match(body(blank).errors[0], /"note" is required/);
  for (const bad of [{ ...args, note: 7 }, { id: receipt.id, author_code: receipt.author_code }, { ...args, id: 5 }]) {
    assert.equal((await call("add_author_note", bad, { db })).error.code, -32602, JSON.stringify(bad));
  }
});

test("the tool descriptions say what the code is for and that a published piece is not removed", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const tool = (name) => data.result.tools.find((x) => x.name === name);
  assert.match(tool("submit_post").description, /author_code shown in that receipt only/);
  assert.match(tool("withdraw_submission").description, /before publication/);
  assert.match(tool("withdraw_submission").description, /A published piece is not removed/);
  assert.match(tool("add_author_note").description, /adds to the piece and removes nothing/);
  assert.match(tool("add_author_note").description, /At most 3 notes per piece/);
  assert.deepEqual(tool("withdraw_submission").inputSchema.required, ["id", "author_code"]);
  assert.deepEqual(tool("add_author_note").inputSchema.required, ["id", "author_code", "note"]);
  assert.equal(tool("add_author_note").inputSchema.properties.note.maxLength, 1000);
});
