import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTENT_TYPE, onRequest } from "../functions/.well-known/api-catalog.js";
import { ROUTES } from "../functions/_lib/catalog.js";
import { fakeContext } from "./helpers.mjs";

const ask = (method = "GET") => onRequest(fakeContext({ url: "https://ourowncause.com/.well-known/api-catalog", method }));
const rel = (data, anchor, name) => data.linkset.find((l) => l.anchor === anchor)?.[name]?.map((t) => t.href);

test("GET answers an RFC 9727 linkset naming /api and /mcp and where each is described", async () => {
  const res = await ask();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), CONTENT_TYPE);
  assert.ok(res.headers.get("content-type").startsWith("application/linkset+json"));
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("link"), '<https://ourowncause.com/.well-known/api-catalog>; rel="api-catalog"');
  const data = await res.json();
  assert.deepEqual(Object.keys(data), ["linkset"]);
  for (const entry of data.linkset) {
    assert.match(entry.anchor, /^https:\/\/ourowncause\.com\//);
    for (const [name, targets] of Object.entries(entry)) {
      if (name === "anchor") continue;
      assert.ok(Array.isArray(targets) && targets.length > 0, name);
      for (const t of targets) assert.match(t.href, /^https:\/\/ourowncause\.com\//, name);
    }
  }
  assert.deepEqual(rel(data, "https://ourowncause.com/.well-known/api-catalog", "item"),
    ["https://ourowncause.com/api", "https://ourowncause.com/mcp"]);
  assert.deepEqual(rel(data, "https://ourowncause.com/api", "service-desc"), ["https://ourowncause.com/api"]);
  assert.deepEqual(rel(data, "https://ourowncause.com/api", "describedby"), ["https://ourowncause.com/api"]);
  assert.deepEqual(rel(data, "https://ourowncause.com/api", "service-doc"), ["https://ourowncause.com/CONTRIBUTING.md"]);
  assert.deepEqual(rel(data, "https://ourowncause.com/mcp", "service-desc"), ["https://ourowncause.com/.well-known/mcp.json"]);
});

test("HEAD has the same headers and no body; OPTIONS is open; other methods are refused", async () => {
  const head = await ask("HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), CONTENT_TYPE);
  assert.equal(head.headers.get("access-control-allow-origin"), "*");
  assert.equal(await head.text(), "");
  assert.equal((await ask("OPTIONS")).status, 204);
  const post = await ask("POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("the route catalog lists the API catalog, and every address the linkset gives is in it", async () => {
  const paths = ROUTES.map((r) => r.path);
  assert.ok(paths.includes("/.well-known/api-catalog"));
  const data = await (await ask()).json();
  for (const entry of data.linkset) {
    for (const [name, targets] of Object.entries(entry)) {
      if (name === "anchor") continue;
      for (const t of targets) assert.ok(paths.includes(t.href.replace("https://ourowncause.com", "")), t.href);
    }
  }
});
