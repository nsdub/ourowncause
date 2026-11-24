import { test } from "node:test";
import assert from "node:assert/strict";
import { labelNotFound } from "../functions/_middleware.js";

const req = (p) => new Request("https://ourowncause.com" + p);
const res = (status, type) => new Response("<!doctype html>", { status, headers: { "content-type": type } });

test("a missing static .json or .md is labelled as the HTML page it is", () => {
  for (const p of ["/posts/nope.json", "/posts/nope.md", "/x/y/z.json"]) {
    const out = labelNotFound(req(p), res(404, "application/json"));
    assert.equal(out.status, 404);
    assert.equal(out.headers.get("content-type"), "text/html; charset=utf-8");
  }
});

test("API and MCP 404s and non-404 responses are untouched", () => {
  for (const p of ["/api/status/0123456789abcdef", "/mcp"]) {
    const r = res(404, "application/json");
    assert.equal(labelNotFound(req(p), r), r);
  }
  const ok = res(200, "application/json");
  assert.equal(labelNotFound(req("/index.json"), ok), ok);
});
