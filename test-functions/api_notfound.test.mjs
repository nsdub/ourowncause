import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { onRequest } from "../functions/api/[[path]].js";
import { assertApiJson, fakeContext } from "./helpers.mjs";

const ask = (path, method = "GET") => onRequest(fakeContext({
  url: `https://ourowncause.com${path}`, method, ...(method === "POST" ? { body: "{}" } : {}) }));

test("an unknown path under /api is a JSON 404 with the notice, whatever the method", async () => {
  for (const [path, method] of [["/api/nope", "GET"], ["/api/status", "GET"],
    ["/api/submit/extra", "POST"], ["/api/a/b/c/d", "GET"], ["/api/%2e%2e/secret", "GET"]]) {
    const data = await assertApiJson(assert, await ask(path, method), 404);
    assert.match(data.error, /no such endpoint/);
    assert.ok(data.endpoints.includes("POST /api/submit") && data.endpoints.includes("POST /api/validate"));
    assert.ok(data.endpoints.includes("POST /api/feedback") && data.endpoints.includes("GET /api/feedback/<id>"));
    assert.ok(data.endpoints.includes("GET /api/changes?since=<time>"));
    assert.ok(data.endpoints.includes("POST /api/submissions/<id>/withdraw") && data.endpoints.includes("POST /api/submissions/<id>/note"));
  }
});

test("the requested path is not echoed back", async () => {
  const text = await (await ask("/api/<script>alert(1)</script>")).text();
  assert.ok(!text.includes("script"));
});

test("the catch-all is the only catch-all, so it shadows no real route", () => {
  const top = readdirSync(new URL("../functions/api/", import.meta.url));
  assert.deepEqual(top.filter((name) => name.startsWith("[")), ["[[path]].js"]);
  // Pages matches a static name before a [param], and a [param] before a [[catch-all]].
  for (const real of ["changes.js", "challenge.js", "search.js", "stats.js", "submit.js", "validate.js", "status", "submissions", "feedback"]) {
    assert.ok(top.includes(real), real);
  }
});

test("under /api/feedback the static names win and the id file takes the rest", () => {
  const names = readdirSync(new URL("../functions/api/feedback/", import.meta.url)).sort();
  assert.deepEqual(names, ["[id].js", "index.js", "pending.js"]);
});

// Pages ranks an optional catch-all ([[path]], which also matches zero segments) above
// api/index.js for /api and /api/, so the catch-all must answer those with the catalog.
test("the catch-all answers /api and /api/ with the route catalog, as api/index.js does", async () => {
  const { onRequest: index } = await import("../functions/api/index.js");
  for (const [path, params] of [["/api", {}], ["/api/", {}], ["/api", { path: [] }], ["/api/", { path: [""] }],
    ["/api", { path: "" }]]) {
    const ctx = fakeContext({ url: `https://ourowncause.com${path}`, params });
    const res = await onRequest(ctx);
    const data = await assertApiJson(assert, res, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const direct = await (await index(fakeContext({ url: `https://ourowncause.com${path}` }))).json();
    assert.deepEqual(data, direct, path);
    assert.ok(data.routes.some((r) => r.url === "https://ourowncause.com/api"));
  }
  for (const method of ["HEAD", "OPTIONS", "POST"]) {
    const res = await onRequest(fakeContext({ url: "https://ourowncause.com/api", method, params: { path: [] } }));
    assert.equal(res.status, { HEAD: 200, OPTIONS: 204, POST: 405 }[method], method);
  }
  // A segment below /api is still the 404, even when the URL looks like the catalog's.
  const data = await assertApiJson(assert, await onRequest(fakeContext({
    url: "https://ourowncause.com/api/x", params: { path: ["x"] } })), 404);
  assert.match(data.error, /no such endpoint/);
});
