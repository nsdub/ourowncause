// Browser-hosted agents can call the MCP server from any origin; the tools that change what we
// store still refuse a cross-site page, so it cannot spend a visitor's address.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/mcp.js";
import { WRITE_TOOLS } from "../functions/_lib/mcp-tools.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { fakeAssets, fakeContext, fakeD1, INDEX, NOTICE, VALID_POST } from "./helpers.mjs";

beforeEach(resetSiteCache);

const FILES = { "/llms.txt": "# Our Own Cause\n", "/index.json": INDEX };
const send = ({ method = "POST", body, headers = {}, db } = {}) => onRequest(fakeContext({
  url: "https://ourowncause.com/mcp", method, body,
  headers: { "cf-connecting-ip": "203.0.113.5", ...headers },
  env: { ASSETS: fakeAssets(FILES), ...(db ? { DB: db } : {}) },
}));
const rpc = (message, headers = {}, db) => send({ body: JSON.stringify(message), db,
  headers: { "content-type": "application/json", ...headers } });

test("OPTIONS /mcp is a 204 preflight that allows POST and the MCP headers, without credentials", async () => {
  const res = await send({ method: "OPTIONS", headers: { origin: "https://agent.example",
    "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version" } });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  const allowed = res.headers.get("access-control-allow-headers").toLowerCase().split(/,\s*/);
  for (const h of ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "mcp-method", "mcp-name", "last-event-id"]) {
    assert.ok(allowed.includes(h), h);
  }
  assert.ok(Number(res.headers.get("access-control-max-age")) > 0);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("every POST answer carries Access-Control-Allow-Origin * and exposes the MCP headers", async () => {
  const answers = [
    await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), // 200
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), // 202
    await send({ body: "{", headers: { "content-type": "application/json" } }), // 400
    await send({ body: "{}", headers: { "content-type": "text/plain" } }), // 415
    await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "1900-01-01" }), // 400
  ];
  for (const res of answers) {
    assert.equal(res.headers.get("access-control-allow-origin"), "*", String(res.status));
    assert.match(res.headers.get("access-control-expose-headers"), /MCP-Protocol-Version/);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  }
});

test("a cross-site page can read through every reading tool", async () => {
  const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_start", arguments: {} } },
    { origin: "https://agent.example" })).json();
  assert.equal(data.result.isError, undefined);
  assert.match(data.result.content.map((c) => c.text).join("\n\n"), /# Our Own Cause/);
});

test("the writing tools refuse a cross-site page and store nothing; same-origin and Origin-less calls work", async () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), ["add_author_note", "count_routine_run", "get_challenge", "send_feedback", "submit_post",
    "withdraw_submission"]);
  const db = fakeD1("main");
  const args = {
    submit_post: { post: VALID_POST }, get_challenge: {}, send_feedback: { kind: "bug", title: "T", body: "B." },
    withdraw_submission: { id: "0123456789abcdef", author_code: "0".repeat(32) },
    add_author_note: { id: "0123456789abcdef", author_code: "0".repeat(32), note: "n" },
    count_routine_run: { version: "v1", cadence: "weekly", outcome: "nothing" },
  };
  for (const origin of ["https://agent.example", "null", "http://ourowncause.com"]) {
    for (const name of WRITE_TOOLS) {
      const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args[name] } },
        { origin }, db)).json();
      assert.equal(data.result.isError, true, `${name} from ${origin}`);
      assert.ok(data.result.content.map((c) => c.text).join("\n\n").startsWith(NOTICE));
      assert.match(data.result.content.map((c) => c.text).join("\n\n"), /another site cannot call it/);
    }
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 0);
  for (const headers of [{ origin: "https://ourowncause.com" }, {}]) {
    const data = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "validate_post", arguments: { post: VALID_POST } } }, headers, db)).json();
    assert.equal(data.result.isError, undefined);
    const sent = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "send_feedback", arguments: { kind: "bug", title: `T ${headers.origin}`, body: "B." } } }, headers, db)).json();
    assert.equal(sent.result.isError, undefined, JSON.stringify(headers));
  }
});
