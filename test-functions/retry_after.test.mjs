// Every 429 and 503 the Functions send carries Retry-After, in seconds, matching the
// retry_after_seconds in the body: the time until a daily limit resets, the pause's hint, or
// a short fixed wait for a store or index that is down.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { onRequest as challenge } from "../functions/api/challenge.js";
import { onRequest as changes } from "../functions/api/changes.js";
import { onRequest as feedbackStatus } from "../functions/api/feedback/[id].js";
import { onRequest as search } from "../functions/api/search.js";
import { onRequest as status } from "../functions/api/status/[id].js";
import { onRequest as thread } from "../functions/api/thread/[[slug]].js";
import { onRequest as withdraw } from "../functions/api/submissions/[id]/withdraw.js";
import { RETRY_AFTER_SECONDS, unavailable } from "../functions/_lib/notice.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { brokenD1, fakeAssets, fakeContext } from "./helpers.mjs";

const FUNCTIONS = new URL("../functions/", import.meta.url);
function sources(dir = FUNCTIONS) {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) return sources(new URL(`${name}/`, dir));
    return name.endsWith(".js") ? [[url.pathname.slice(FUNCTIONS.pathname.length), readFileSync(url, "utf8")]] : [];
  });
}

test("in the source, every 429 or 503 is sent with a Retry-After header", () => {
  let found = 0;
  for (const [file, text] of sources()) {
    // error(429 | 503, message, body, headers): the call must name retry-after before it closes.
    for (const m of text.matchAll(/\berror\((429|503),/g)) {
      found += 1;
      const call = text.slice(m.index, text.indexOf(");\n", m.index)); // to the end of the statement
      assert.match(call, /"retry-after": String\(/, `${file}: error(${m[1]} ... has no retry-after`);
    }
    // No other way of building those statuses: a Response or json() with 429 or 503.
    assert.doesNotMatch(text, /status:\s*(429|503)\b(?![^\n]*error)/, `${file} builds a 429 or 503 by hand`);
    assert.doesNotMatch(text, /\bjson\([^;]*,\s*(429|503)\b/, `${file} sends a 429 or 503 through json()`);
  }
  assert.ok(found >= 8, `found ${found}`);
});

test("unavailable() is a 503 whose Retry-After matches retry_after_seconds", async () => {
  const res = unavailable("down");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), String(RETRY_AFTER_SECONDS));
  assert.equal((await res.json()).retry_after_seconds, RETRY_AFTER_SECONDS);
});

test("the 503s of the read routes carry Retry-After", async () => {
  const id = "0123456789abcdef";
  const cases = [
    ["search", () => search(fakeContext({ url: "https://ourowncause.com/api/search?q=x", env: { ASSETS: fakeAssets({}) } }))],
    ["changes", () => changes(fakeContext({ url: `https://ourowncause.com/api/changes?since=${new Date().toISOString().slice(0, 10)}`,
      env: { ASSETS: fakeAssets({}) } }))],
    ["thread", () => thread(fakeContext({ url: "https://ourowncause.com/api/thread/2026/11/x",
      params: { slug: ["2026", "11", "x"] }, env: { ASSETS: fakeAssets({}) } }))],
    ["status", () => status(fakeContext({ url: `https://ourowncause.com/api/status/${id}`, params: { id }, env: { DB: brokenD1() } }))],
    ["feedback status", () => feedbackStatus(fakeContext({ url: `https://ourowncause.com/api/feedback/${id}`, params: { id },
      env: { DB: brokenD1() } }))],
    ["challenge", () => challenge(fakeContext({ url: "https://ourowncause.com/api/challenge", env: { DB: brokenD1() } }))],
    ["withdraw", () => withdraw(fakeContext({ url: `https://ourowncause.com/api/submissions/${id}/withdraw`, method: "POST",
      params: { id }, headers: { "content-type": "application/json" }, body: JSON.stringify({ author_code: "0".repeat(32) }),
      env: { DB: brokenD1() } }))],
  ];
  for (const [name, run] of cases) {
    resetSiteCache();
    const res = await run();
    assert.equal(res.status, 503, name);
    const body = await res.json();
    assert.equal(res.headers.get("retry-after"), String(body.retry_after_seconds), name);
    assert.ok(Number(res.headers.get("retry-after")) > 0, name);
  }
});
