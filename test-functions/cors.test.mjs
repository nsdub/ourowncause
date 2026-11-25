import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest as changes } from "../functions/api/changes.js";
import { onRequest as search } from "../functions/api/search.js";
import { onRequest as stats } from "../functions/api/stats.js";
import { onRequest as status } from "../functions/api/status/[id].js";
import { onRequest as submit } from "../functions/api/submit.js";
import { onRequest as validate } from "../functions/api/validate.js";
import { fakeContext } from "./helpers.mjs";

// Browser-hosted agents may read; only reads are opened. Submitting stays same-origin.
const READS = [
  ["search", search, "https://ourowncause.com/api/search?q=x", {}, "GET, HEAD, OPTIONS"],
  ["stats", stats, "https://ourowncause.com/api/stats", {}, "GET, HEAD, OPTIONS"],
  ["changes", changes, "https://ourowncause.com/api/changes?since=x", {}, "GET, OPTIONS"],
  ["status", status, "https://ourowncause.com/api/status/0123456789abcdef", { id: "0123456789abcdef" }, "GET, OPTIONS"],
];

for (const [name, handler, url, params, methods] of READS) {
  test(`${name}: GET answers carry Access-Control-Allow-Origin *, even errors`, async () => {
    const ctx = fakeContext({ url });
    ctx.params = params;
    const res = await handler(ctx);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test(`${name}: OPTIONS is a 204 preflight naming only read methods`, async () => {
    const ctx = fakeContext({ url, method: "OPTIONS" });
    ctx.params = params;
    const res = await handler(ctx);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-methods"), methods);
    assert.equal(await res.text(), "");
  });
}

test("validate stores nothing, so it answers any origin: a 204 preflight allowing POST and Content-Type", async () => {
  const pre = await validate(fakeContext({ url: "https://ourowncause.com/api/validate", method: "OPTIONS",
    headers: { origin: "https://elsewhere.example", "access-control-request-method": "POST",
      "access-control-request-headers": "content-type" } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(pre.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  for (const body of ["{}", "not json"]) {
    const res = await validate(fakeContext({ url: "https://ourowncause.com/api/validate", method: "POST",
      headers: { "content-type": "application/json", origin: "https://elsewhere.example" }, body }));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  }
  const get = await validate(fakeContext({ url: "https://ourowncause.com/api/validate" }));
  assert.equal(get.status, 405);
});

for (const [name, handler] of [["submit", submit]]) {
  test(`${name}: no CORS header, so a cross-site page cannot read or submit`, async () => {
    const res = await handler(fakeContext({ url: `https://ourowncause.com/api/${name}`, method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" }));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const pre = await handler(fakeContext({ url: `https://ourowncause.com/api/${name}`, method: "OPTIONS" }));
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
  });
}
