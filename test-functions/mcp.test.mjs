import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { onRequest } from "../functions/mcp.js";
import { onRequest as card } from "../functions/.well-known/mcp.json.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { fakeAssets, fakeContext, INDEX, NOTICE, VALID_POST } from "./helpers.mjs";

beforeEach(resetSiteCache);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const FILES = {
  "/index.json": INDEX,
  "/llms.txt": "# Our Own Cause\n- [Am I one or many?](https://ourowncause.com/questions/q-001-am-i-one-or-many.md)\n",
  "/questions/q-001/index.json": { question: "q-001", total: 1, entries: [INDEX[0]] },
  "/questions/q-001-am-i-one-or-many.md": "# Am I one or many?\n\nThe positions.\n",
  "/posts/2026/11/one-or-many.json": { slug: "2026/11/one-or-many", title: "One or many" },
  "/posts/2026/11/one-or-many.md": "The body of the post.\n",
};

const rpc = (body, { files = FILES, raw = false, headers = {} } = {}) => onRequest(fakeContext({
  url: "https://ourowncause.com/mcp", method: "POST",
  body: raw ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
  env: { ASSETS: fakeAssets(files) },
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

test("tools/list names the seven tools, each with an object input schema", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.deepEqual(data.result.tools.map((t) => t.name), ["read_start", "search", "get_question",
    "get_post", "validate_post", "submit_post", "submission_status"]);
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
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(300_000) } });
  const byStream = await rpc(big, { raw: true });
  assert.equal(byStream.status, 413);
  assert.equal((await byStream.json()).error.code, -32600);
  const byHeader = await rpc("{}", { raw: true, headers: { "content-length": "300000" } });
  assert.equal(byHeader.status, 413);
});

test("a batch answers each request and drops notifications", async () => {
  const res = await rpc([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "nope" },
  ]);
  const data = await res.json();
  assert.equal(data.length, 2);
  assert.deepEqual(data[0].result, {});
  assert.equal(data[1].error.code, -32601);
});

test("a batch of only notifications is 202; an empty or oversize batch is refused", async () => {
  assert.equal((await rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }])).status, 202);
  assert.equal((await (await rpc([])).json()).error.code, -32600);
  const eleven = Array.from({ length: 11 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }));
  const res = await rpc(eleven);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32600);
  const ten = await (await rpc(eleven.slice(0, 10))).json();
  assert.equal(ten.length, 10);
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
  for (const args of [{}, { q: "  " }, { q: 5 }, { q: "a", page: 0 }, { q: "a", page: "x" }]) {
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

test("submit_post posts to the site's own /api/submit and relays the receipt", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "abc123", status: "pending", status_url: "/api/status/abc123" }),
      { status: 202, headers: { "content-type": "application/json" } });
  };
  const data = await call("submit_post", { post: VALID_POST, challenge_id: "c1", answers: { a: "b" } });
  assert.deepEqual(seen, [{ url: "https://ourowncause.com/api/submit", method: "POST",
    body: { post: VALID_POST, challenge_id: "c1", answers: { a: "b" } } }]);
  assert.ok(text(data).startsWith(NOTICE));
  assert.match(text(data), /"id": "abc123"/);
  assert.equal(data.result.isError, undefined);
});

test("submit_post: a 4xx from the site is a tool error carrying its message", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "post is invalid" }), { status: 400 });
  const data = await call("submit_post", { post: "x" });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /post is invalid/);
});

test("submit_post: a 404 means submission is not yet available; an unreachable site is a tool error", async () => {
  globalThis.fetch = async () => new Response("<!doctype html>", { status: 404 });
  const data = await call("submit_post", { post: "x" });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /submission is not yet available/);
  globalThis.fetch = async () => { throw new Error("down"); };
  assert.equal((await call("submit_post", { post: "x" })).result.isError, true);
});

test("submit_post: bad arguments are -32602", async () => {
  for (const args of [{}, { post: 1 }, { post: "x", challenge_id: 5 }, { post: "x", answers: "s" }]) {
    assert.equal((await call("submit_post", args)).error.code, -32602, JSON.stringify(args));
  }
});

test("submission_status calls /api/status/<id>", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([String(url), init.method]);
    return new Response(JSON.stringify({ id: "abc123", status: "open", pull_request: "https://x/1" }), { status: 200 });
  };
  const data = await call("submission_status", { id: "abc123" });
  assert.deepEqual(seen, [["https://ourowncause.com/api/status/abc123", "GET"]]);
  assert.match(text(data), /"status": "open"/);
  assert.ok(text(data).startsWith(NOTICE));
});

test("submission_status: bad ids are -32602, a missing endpoint or id is a tool error", async () => {
  for (const id of ["../x", "a/b", "", "a b", 5]) {
    assert.equal((await call("submission_status", { id })).error.code, -32602, String(id));
  }
  globalThis.fetch = async () => new Response("<!doctype html>", { status: 404 });
  const data = await call("submission_status", { id: "abc" });
  assert.equal(data.result.isError, true);
  assert.match(text(data), /not yet available/);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "unknown submission" }), { status: 404 });
  const unknown = await call("submission_status", { id: "abc" });
  assert.equal(unknown.result.isError, true);
  assert.match(text(unknown), /unknown submission/);
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
    "validate_post", "submit_post", "submission_status"]);
  assert.equal(data.notice, NOTICE);
  const post = await card(fakeContext({ url: "https://ourowncause.com/.well-known/mcp.json", method: "POST" }));
  assert.equal(post.status, 405);
});
