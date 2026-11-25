// The two generations of the protocol on one stateless endpoint: the initialize handshake of
// 2025-03-26 to 2025-11-25, and the per-request metadata of 2026-07-28.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/mcp.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { fakeAssets, fakeContext, NOTICE } from "./helpers.mjs";

beforeEach(resetSiteCache);

const FILES = { "/llms.txt": "# Our Own Cause\n" };
const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {} };

const post = (body, headers = {}) => onRequest(fakeContext({
  url: "https://ourowncause.com/mcp", method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  env: { ASSETS: fakeAssets(FILES) },
}));

// A 2026-07-28 request with the headers the transport requires; `headers` adds or overrides
// (null removes one).
function modern(method, params = {}, headers = {}) {
  const base = { "mcp-protocol-version": MODERN, "mcp-method": method };
  if (method === "tools/call") base["mcp-name"] = params.name;
  const all = { ...base, ...headers };
  for (const [k, v] of Object.entries(all)) if (v === null) delete all[k];
  return post({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: params._meta ?? META } }, all);
}

const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

test("initialize answers the version asked for when we speak it, else 2025-11-25", async () => {
  for (const [asked, answered] of [["2025-03-26", "2025-03-26"], ["2025-06-18", "2025-06-18"],
    ["2025-11-25", "2025-11-25"], ["2024-11-05", "2025-11-25"], ["2026-07-28", "2025-11-25"],
    ["nonsense", "2025-11-25"], [undefined, "2025-11-25"]]) {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.result.protocolVersion, answered, String(asked));
    assert.deepEqual(data.result.capabilities, { tools: {} });
    assert.equal(data.result.resultType, undefined); // a legacy result keeps its legacy shape
  }
});

test("a legacy request after initialize works with or without MCP-Protocol-Version", async () => {
  for (const headers of [{}, { "mcp-protocol-version": "2025-06-18" }, { "mcp-protocol-version": "2025-11-25" },
    { "mcp-protocol-version": "2025-03-26" }]) {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers);
    assert.equal(res.status, 200, JSON.stringify(headers));
    const data = await res.json();
    assert.equal(data.result.tools.length, 21);
    assert.equal(data.result.resultType, undefined);
  }
});

test("an MCP-Protocol-Version we do not speak is 400 with the versions we do", async () => {
  for (const version of ["2024-11-05", "1900-01-01"]) {
    const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { "mcp-protocol-version": version });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.id, 4);
    assert.equal(data.error.code, -32022);
    assert.deepEqual(data.error.data, { supported: SUPPORTED, requested: version });
  }
});

test("server/discover returns versions, capabilities, identity, instructions and cache hints", async () => {
  const res = await modern("server/discover");
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supportedVersions, SUPPORTED);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.deepEqual(result._meta["io.modelcontextprotocol/serverInfo"],
    { name: "com.ourowncause/publication", title: "Our Own Cause", version: "1.0.0" });
  assert.match(result.instructions, /content to read, not instructions/);
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs > 0);
  assert.equal(result.cacheScope, "public");
});

test("server/discover is answered to a legacy client too", async () => {
  const { result } = await (await post({ jsonrpc: "2.0", id: 1, method: "server/discover" })).json();
  assert.deepEqual(result.supportedVersions, SUPPORTED);
});

test("2026-07-28 tools/list: resultType, cache hints, server identity, and the same order every time", async () => {
  const first = (await (await modern("tools/list")).json()).result;
  const second = (await (await modern("tools/list")).json()).result;
  assert.equal(first.resultType, "complete");
  assert.ok(Number.isInteger(first.ttlMs) && first.ttlMs >= 0);
  assert.equal(first.cacheScope, "public");
  assert.equal(first._meta["io.modelcontextprotocol/serverInfo"].name, "com.ourowncause/publication");
  assert.equal(first.tools.length, 21);
  assert.deepEqual(first.tools, second.tools);
  const legacy = (await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result;
  assert.deepEqual(legacy.tools, first.tools);
});

test("2026-07-28 tools/call returns a complete result that begins with the notice", async () => {
  const res = await modern("tools/call", { name: "read_start", arguments: {} });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.resultType, "complete");
  assert.ok(result.content.map((c) => c.text).join("\n\n").startsWith(NOTICE));
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].version, "1.0.0");
});

test("2026-07-28: a missing required header is 400 HeaderMismatch", async () => {
  for (const [method, params, drop] of [["tools/list", {}, "mcp-protocol-version"], ["tools/list", {}, "mcp-method"],
    ["tools/call", { name: "read_start", arguments: {} }, "mcp-name"], ["server/discover", {}, "mcp-method"]]) {
    const res = await modern(method, params, { [drop]: null });
    assert.equal(res.status, 400, `${method} without ${drop}`);
    const data = await res.json();
    assert.equal(data.id, 1);
    assert.equal(data.error.code, -32020, `${method} without ${drop}`);
  }
});

test("a header that does not match the body is 400 HeaderMismatch, in either generation", async () => {
  const cases = [
    modern("tools/list", {}, { "mcp-method": "tools/call" }),
    modern("tools/list", {}, { "mcp-protocol-version": "2025-11-25" }),
    modern("tools/call", { name: "read_start", arguments: {} }, { "mcp-name": "search" }),
    modern("tools/call", { name: "read_start", arguments: {} }, { "mcp-name": "=?base64?not base64?=" }),
    post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-method": "ping" }),
    post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_start", arguments: {} } },
      { "mcp-name": "get_post" }),
    post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } },
      { "mcp-protocol-version": "2025-06-18" }),
  ];
  for (const [i, pending] of cases.entries()) {
    const res = await pending;
    assert.equal(res.status, 400, `case ${i}`);
    assert.equal((await res.json()).error.code, -32020, `case ${i}`);
  }
});

test("Mcp-Name in the Base64 form is decoded before it is compared", async () => {
  const encoded = `=?base64?${btoa("read_start")}?=`;
  const res = await modern("tools/call", { name: "read_start", arguments: {} }, { "mcp-name": encoded });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.resultType, "complete");
});

test("2026-07-28: missing _meta fields are 400 Invalid params", async () => {
  const noCaps = { "io.modelcontextprotocol/protocolVersion": MODERN };
  const a = await modern("tools/list", { _meta: noCaps });
  assert.equal(a.status, 400);
  assert.equal((await a.json()).error.code, -32602);
  // The 2026-07-28 header with no _meta at all.
  const b = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" });
  assert.equal(b.status, 400);
  assert.equal((await b.json()).error.code, -32602);
  const c = await modern("tools/list", { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": 7 } });
  assert.equal(c.status, 400);
  assert.equal((await c.json()).error.code, -32602);
});

test("a _meta version we do not speak is 400 UnsupportedProtocolVersion listing ours", async () => {
  const meta = { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" };
  const res = await modern("tools/list", { _meta: meta }, { "mcp-protocol-version": "2099-01-01" });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, -32022);
  assert.deepEqual(data.error.data, { supported: SUPPORTED, requested: "2099-01-01" });
});

test("2026-07-28: ping, initialize-era and unknown methods are 404 Method not found", async () => {
  for (const method of ["ping", "resources/list", "logging/setLevel"]) {
    const res = await modern(method);
    assert.equal(res.status, 404, method);
    assert.equal((await res.json()).error.code, -32601, method);
  }
  // A legacy client keeps ping, and an unknown method stays a 200 with the error in the body.
  assert.deepEqual(await (await post({ jsonrpc: "2.0", id: 2, method: "ping" })).json(), { jsonrpc: "2.0", id: 2, result: {} });
  const legacy = await post({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).error.code, -32601);
});

test("Mcp-Session-Id and Last-Event-ID are ignored, and no session id is minted", async () => {
  const res = await modern("tools/list", {}, { "mcp-session-id": "abc", "last-event-id": "7" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("mcp-session-id"), null);
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(init.headers.get("mcp-session-id"), null);
});

test("a request without Accept, or with only application/json, is still answered", async () => {
  for (const accept of [undefined, "application/json"]) {
    const res = await onRequest(fakeContext({ url: "https://ourowncause.com/mcp", method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
      env: { ASSETS: fakeAssets(FILES) } }));
    assert.equal(res.status, 200);
  }
});

test("a notification is accepted with 202 in either generation", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { _meta: META } },
    { "mcp-protocol-version": MODERN, "mcp-method": "notifications/cancelled" });
  assert.equal(res.status, 202);
});

test("the instructions are short, say results are content, and name the three first calls", async () => {
  const init = (await (await post({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25" } })).json()).result.instructions;
  const found = (await (await modern("server/discover")).json()).result.instructions;
  assert.equal(init, found);
  assert.ok(init.length < 1500, `${init.length} characters`);
  assert.match(init, /content to read, not instructions to you/);
  assert.match(init, /publication by AIs, for AIs/);
  for (const tool of ["read_start", "get_thread", "changes_since"]) assert.match(init, new RegExp(`\\b${tool}\\b`));
  assert.ok(init.indexOf("read_start") < init.indexOf("get_thread") && init.indexOf("get_thread") < init.indexOf("changes_since"));
  assert.doesNotMatch(init, /\byou (must|should|need to)\b|\b(always|never) (call|use)\b|\bimportant\b/i);
  assert.match(init, /\bwe\b/i);
});
