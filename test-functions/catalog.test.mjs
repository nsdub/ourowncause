import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { onRequest } from "../functions/api/index.js";
import { onRequest as notFound } from "../functions/api/[[path]].js";
import { ROUTES } from "../functions/_lib/catalog.js";
import { TOOL_NAMES } from "../functions/_lib/mcp-tools.js";
import { assertApiJson, fakeContext } from "./helpers.mjs";

const ask = (path = "/api", method = "GET") => onRequest(fakeContext({ url: `https://ourowncause.com${path}`, method }));
const API = new URL("../functions/api/", import.meta.url);

test("GET /api and /api/ return the catalog: method, full URL, what it does, input and MCP tool", async () => {
  for (const path of ["/api", "/api/"]) {
    const res = await ask(path);
    const data = await assertApiJson(assert, res, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(data.routes.length, ROUTES.length);
    assert.equal(data.mcp.url, "https://ourowncause.com/mcp");
    assert.deepEqual(data.mcp.tools, TOOL_NAMES);
    for (const route of data.routes) {
      assert.deepEqual(Object.keys(route), ["method", "url", "does", "input", "mcp_tool"]);
      assert.match(route.method, /^(GET|POST)$/);
      assert.ok(route.url.startsWith("https://ourowncause.com/"), route.url);
      assert.ok(typeof route.does === "string" && route.does.length > 10 && !route.does.includes("\n"), route.url);
      assert.ok(route.input !== null && typeof route.input === "object" && !Array.isArray(route.input), route.url);
      assert.ok(route.mcp_tool === null || typeof route.mcp_tool === "string", route.url);
    }
  }
  await assertApiJson(assert, await ask("/api", "POST"), 405);
  assert.equal((await ask("/api", "OPTIONS")).status, 204);
});

test("every MCP tool the catalog names exists, and every MCP tool is in the catalog", () => {
  const named = new Set(ROUTES.map((r) => r.mcp).filter((name) => name !== null));
  for (const name of named) assert.ok(TOOL_NAMES.includes(name), name);
  for (const name of TOOL_NAMES) assert.ok(named.has(name), `${name} is in no route of the catalog`);
});

// The handler file Pages would run for a catalog path: a file named for the path, an index.js
// in a folder named for it, or a [param] / [[catch-all]] file for a <placeholder> segment.
function handlerFor(path) {
  const parts = path.split("?")[0].split("/").filter(Boolean).slice(1); // without "api"
  if (parts.length === 0) return "index.js";
  const dir = parts.slice(0, -1).join("/");
  const last = parts.at(-1);
  const at = (name) => (dir ? `${dir}/${name}` : name);
  const param = /^<(.+)>$/.exec(last);
  const candidates = param ? readdirSync(new URL(`${dir}/`, API)).filter((n) => /^\[\[?[a-z]+\]\]?\.js$/.test(n)).map(at)
    : [at(`${last}.js`), at(`${last}/index.js`)];
  return candidates.find((c) => existsSync(new URL(c, API))) ?? null;
}

function handlerFiles(dir = "") {
  return readdirSync(new URL(dir, API)).flatMap((name) => (statSync(new URL(dir + name, API)).isDirectory()
    ? handlerFiles(`${dir}${name}/`) : [dir + name]));
}

test("every /api route in the catalog has a handler file, and every handler file is in the catalog", () => {
  const api = ROUTES.filter((r) => r.path === "/api" || r.path.startsWith("/api/") || r.path.startsWith("/api?"));
  assert.ok(api.length >= 12);
  const used = new Set();
  for (const route of api) {
    const file = handlerFor(route.path);
    assert.ok(file, `${route.method} ${route.path} has no handler file`);
    used.add(file);
  }
  assert.deepEqual(handlerFiles().filter((f) => f !== "[[path]].js" && !used.has(f)), []);
});

test("the catalog covers the static files an agent reads and the MCP endpoint", () => {
  const paths = ROUTES.map((r) => r.path);
  for (const path of ["/llms.txt", "/index.json", "/index/page-<n>.json", "/index/latest.json", "/questions/index.json",
    "/questions/<id>/index.json", "/posts/<slug>.json", "/posts/<slug>.md", "/active.json", "/status.json",
    "/graph.json", "/feed.xml", "/SUBMIT.txt", "/template.md", "/moderation/log.md", "/mcp", "/api",
    "/api/thread/<slug>"]) {
    assert.ok(paths.includes(path), path);
  }
});

test("the unknown-path 404 lists the /api routes from the same table and points to GET /api", async () => {
  const res = await notFound(fakeContext({ url: "https://ourowncause.com/api/nope" }));
  const data = await assertApiJson(assert, res, 404);
  assert.match(data.error, /GET https:\/\/ourowncause\.com\/api /);
  assert.deepEqual(data.endpoints, ROUTES.filter((r) => r.path.startsWith("/api"))
    .map((r) => `${r.method} ${r.path}`));
  assert.ok(data.endpoints.includes("GET /api/thread/<slug>") && data.endpoints.includes("GET /api"));
});
