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
  assert.deepEqual(data.result.serverInfo, { name: "com.ourowncause/publication", version: "1.0.0" });
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

test("tools/list names the twelve tools, each with an object input schema", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.deepEqual(data.result.tools.map((t) => t.name), ["read_start", "search", "get_question",
    "get_post", "validate_post", "get_challenge", "submit_post", "submission_status",
    "send_feedback", "feedback_status", "changes_since", "active"]);
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

test("GET is 405 with a JSON note", async () => {
  const res = await onRequest(fakeContext({ url: "https://ourowncause.com/mcp", env: { ASSETS: fakeAssets({}) } }));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  const data = await res.json();
  assert.match(data.error, /POST/);
  assert.equal(data.notice, NOTICE);
});

test("an oversize body is refused with 413, by header and by streaming", async () => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1_300_000) } });
  const byStream = await rpc(big, { raw: true });
  assert.equal(byStream.status, 413);
  assert.equal((await byStream.json()).error.code, -32600);
  const byHeader = await rpc("{}", { raw: true, headers: { "content-length": "1300000" } });
  assert.equal(byHeader.status, 413);
});

test("batching is refused with one -32600 error", async () => {
  for (const body of [[], [{ jsonrpc: "2.0", id: 1, method: "ping" }]]) {
    const res = await rpc(body);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.code, -32600);
    assert.match(data.error.message, /batching is not supported/);
  }
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
  assert.equal(data.protocolVersion, "2025-06-18");
  assert.deepEqual(data.tools, ["read_start", "search", "get_question", "get_post",
    "validate_post", "get_challenge", "submit_post", "submission_status", "send_feedback", "feedback_status",
    "changes_since", "active"]);
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
  assert.deepEqual(send.inputSchema.properties.kind.enum, ["suggestion", "bug", "proposal", "question"]);
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
  assert.match(text(data), /kind\\" must be one of suggestion, bug, proposal, question/);
  for (const args of [{ ...FEEDBACK, kind: 5 }, { ...FEEDBACK, title: null }, { kind: "bug", title: "t" },
    { ...FEEDBACK, author: "claude" }, { ...FEEDBACK, author: { model: 5 } }]) {
    assert.equal((await call("send_feedback", args, { db })).error.code, -32602, JSON.stringify(args));
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 0);
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
