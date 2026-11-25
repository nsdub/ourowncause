// The MCP server card at /.well-known/mcp.json and at /mcp/server-card (SEP-2127).
import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest as wellKnown } from "../functions/.well-known/mcp.json.js";
import { onRequest as serverCard } from "../functions/mcp/server-card.js";
import { onRequest as mcp } from "../functions/mcp.js";
import { fakeAssets, fakeContext, NOTICE } from "./helpers.mjs";

const CARDS = [["/.well-known/mcp.json", wellKnown, "application/json; charset=utf-8"],
  ["/mcp/server-card", serverCard, "application/mcp-server-card+json; charset=utf-8"]];
const get = (handler, path, init = {}) => handler(fakeContext({ url: `https://ourowncause.com${path}`, ...init }));

test("both card locations serve the same card, each with its media type", async () => {
  const bodies = [];
  for (const [path, handler, type] of CARDS) {
    const res = await get(handler, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), type, path);
    bodies.push(await res.text());
  }
  assert.equal(bodies[0], bodies[1]);
});

test("the card follows the Server Card schema (v1)", async () => {
  const data = await (await get(serverCard, "/mcp/server-card")).json();
  assert.equal(data.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
  assert.match(data.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(data.name.length >= 3 && data.name.length <= 200);
  assert.ok(typeof data.version === "string" && !/[\^~>*x]/.test(data.version));
  assert.ok(data.description.length >= 1 && data.description.length <= 100, `${data.description.length}`);
  assert.ok(data.title.length >= 1 && data.title.length <= 100);
  assert.match(data.websiteUrl, /^https:\/\//);
  assert.deepEqual(data.repository, { url: "https://github.com/nsdub/ourowncause", source: "github" });
  assert.deepEqual(data.remotes, [{ type: "streamable-http", url: "https://ourowncause.com/mcp",
    supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] }]);
  assert.equal(data.notice, NOTICE);
});

test("the card agrees with server/discover: identity, versions and instructions", async () => {
  const data = await (await get(wellKnown, "/.well-known/mcp.json")).json();
  const res = await mcp(fakeContext({ url: "https://ourowncause.com/mcp", method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    env: { ASSETS: fakeAssets({}) } }));
  const { result } = await res.json();
  const info = result._meta["io.modelcontextprotocol/serverInfo"];
  assert.equal(data.name, info.name);
  assert.equal(data.version, info.version);
  assert.equal(data.title, info.title);
  assert.deepEqual(data.remotes[0].supportedProtocolVersions, result.supportedVersions);
  assert.equal(data.instructions, result.instructions);
});

test("the card is readable from any origin, cacheable, and answers If-None-Match with 304", async () => {
  for (const [path, handler] of CARDS) {
    const res = await get(handler, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-expose-headers"), /ETag/);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    const etag = res.headers.get("etag");
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    const again = await get(handler, path, { headers: { "if-none-match": `W/${etag}, "other"` } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
    const changed = await get(handler, path, { headers: { "if-none-match": '"other"' } });
    assert.equal(changed.status, 200);
    const head = await get(handler, path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const pre = await get(handler, path, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-methods"), /GET/);
    assert.match(pre.headers.get("access-control-allow-headers"), /If-None-Match/);
    const post = await get(handler, path, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal((await post.json()).notice, NOTICE);
  }
});
