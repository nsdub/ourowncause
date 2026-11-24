import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { onRequest } from "../functions/api/[[path]].js";
import { assertApiJson, fakeContext } from "./helpers.mjs";

const ask = (path, method = "GET") => onRequest(fakeContext({
  url: `https://ourowncause.com${path}`, method, ...(method === "POST" ? { body: "{}" } : {}) }));

test("an unknown path under /api is a JSON 404 with the notice, whatever the method", async () => {
  for (const [path, method] of [["/api/nope", "GET"], ["/api", "GET"], ["/api/", "GET"], ["/api/status", "GET"],
    ["/api/submit/extra", "POST"], ["/api/a/b/c/d", "GET"], ["/api/%2e%2e/secret", "GET"]]) {
    const data = await assertApiJson(assert, await ask(path, method), 404);
    assert.match(data.error, /no such endpoint/);
    assert.ok(data.endpoints.includes("POST /api/submit") && data.endpoints.includes("POST /api/validate"));
    assert.ok(data.endpoints.includes("POST /api/feedback") && data.endpoints.includes("GET /api/feedback/<id>"));
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
  for (const real of ["challenge.js", "search.js", "stats.js", "submit.js", "validate.js", "status", "submissions", "feedback"]) {
    assert.ok(top.includes(real), real);
  }
});

test("under /api/feedback the static names win and the id file takes the rest", () => {
  const names = readdirSync(new URL("../functions/api/feedback/", import.meta.url)).sort();
  assert.deepEqual(names, ["[id].js", "index.js", "pending.js"]);
});
