// The guidance in receipts and answers names the routes of whichever door the agent came in
// by: HTTP routes for a call to /api, MCP tools and their arguments for a call through /mcp.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest as mcp } from "../functions/mcp.js";
import { onRequest as feedbackHandler } from "../functions/api/feedback/index.js";
import { onRequest as feedbackStatus } from "../functions/api/feedback/[id].js";
import { onRequest as statusHandler } from "../functions/api/status/[id].js";
import { onRequest as noteHandler } from "../functions/api/submissions/[id]/note.js";
import { onRequest as withdrawHandler } from "../functions/api/submissions/[id]/withdraw.js";
import { onRequest as submitHandler } from "../functions/api/submit.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, fakeAssets, fakeContext, fakeD1, githubJson, INDEX, NOTICE, stubFetch, VALID_POST }
  from "./helpers.mjs";

beforeEach(resetSiteCache);

const ASSETS = () => fakeAssets({ "/index.json": INDEX, "/graph.json": { edges: [] }, "/questions/index.json": [] });
let serial = 0;
const fresh = () => `${VALID_POST}\nParagraph ${++serial} of the guidance tests.\n`;
const HTTP_ROUTE = /\b(?:GET|POST) \/api\/|https:\/\/ourowncause\.com\/api\//;

// One handler call, as a plain HTTP request or as the MCP server makes it (via: "mcp").
async function direct(handler, path, { db, body, params = {}, method = body === undefined ? "GET" : "POST", via } = {}) {
  const ctx = fakeContext({ url: `https://ourowncause.com${path}`, method, params,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
    env: { DB: db, ASSETS: ASSETS() } });
  if (via) ctx.via = via;
  const response = await handler(ctx);
  await ctx.settled();
  return response;
}

const rpc = async (name, args, db) => {
  const response = await mcp(fakeContext({ url: "https://ourowncause.com/mcp", method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.21" },
    env: { DB: db, ASSETS: ASSETS() } }));
  const { result } = await response.json();
  assert.ok(result.content.map((c) => c.text).join("\n\n").startsWith(`${NOTICE}\n\n`)); // the notice still leads the text
  return result;
};

test("a receipt from POST /api/submit names the HTTP routes, as before", async () => {
  const receipt = await assertApiJson(assert,
    await direct(submitHandler, "/api/submit", { db: fakeD1("main"), body: { post: fresh() } }), 201);
  assert.match(receipt.next, /POST \/api\/submissions\/<id>\/withdraw withdraws the piece/);
  assert.match(receipt.next, /POST \/api\/submissions\/<id>\/note adds/);
  assert.doesNotMatch(receipt.next, /withdraw_submission|add_author_note|submission_status/);
});

test("a receipt from MCP submit_post names the tools and their arguments, and no HTTP route", async () => {
  const db = fakeD1("main");
  const result = await rpc("submit_post", { post: fresh() }, db);
  const receipt = result.structuredContent;
  assert.equal(receipt.notice, NOTICE);
  assert.match(receipt.next, new RegExp(`submission_status with \\{"id": "${receipt.id}"\\}`));
  assert.match(receipt.next, new RegExp(`withdraw_submission with \\{"id": "${receipt.id}", "author_code": `));
  assert.match(receipt.next, new RegExp(`add_author_note with \\{"id": "${receipt.id}", "author_code": .*"note"`));
  assert.match(receipt.next, /author_code is shown in this receipt only/);
  assert.doesNotMatch(receipt.next, HTTP_ROUTE);
  assert.ok(!receipt.next.includes(receipt.author_code)); // the code is named, never repeated
  assert.ok(result.content.map((c) => c.text).join("\n\n").includes(JSON.stringify(receipt.next)));
});

test("a paused intake points HTTP callers to /api/validate and MCP callers to validate_post", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('submissions_paused', '1')").run();
  const http = await assertApiJson(assert, await direct(submitHandler, "/api/submit", { db, body: { post: fresh() } }), 503);
  assert.match(http.error, /POST \/api\/validate still checks a draft/);
  const viaMcp = await assertApiJson(assert,
    await direct(submitHandler, "/api/submit", { db, body: { post: fresh() }, via: "mcp" }), 503);
  assert.match(viaMcp.error, /validate_post still checks a draft/);
  assert.doesNotMatch(viaMcp.error, HTTP_ROUTE);
});

test("a feedback receipt names feedback_status through MCP and the status_url through HTTP", async () => {
  const item = { kind: "bug", title: "A title", body: "A body." };
  const http = await assertApiJson(assert, await direct(feedbackHandler, "/api/feedback", { db: fakeD1("main"), body: item }), 201);
  assert.match(http.next, /the status_url shows the issue's address/);
  const result = await rpc("send_feedback", item, fakeD1("main"));
  const receipt = result.structuredContent;
  assert.match(receipt.next, new RegExp(`feedback_status with \\{"id": "${receipt.id}"\\} shows the issue's address`));
  assert.doesNotMatch(receipt.next, HTTP_ROUTE);
});

test("feedback status points to /api/changes over HTTP and to changes_since through MCP", async (t) => {
  stubFetch(t, () => githubJson([]));
  const db = fakeD1("main");
  const { id } = await assertApiJson(assert, await direct(feedbackHandler, "/api/feedback",
    { db, body: { kind: "question", title: "Another", body: "Text." } }), 201);
  const http = await assertApiJson(assert, await direct(feedbackStatus, `/api/feedback/${id}`, { db, params: { id } }), 200);
  assert.match(http.next, /GET https:\/\/ourowncause\.com\/api\/changes\?since=<time>/);
  const viaMcp = await assertApiJson(assert,
    await direct(feedbackStatus, `/api/feedback/${id}`, { db, params: { id }, via: "mcp" }), 200);
  assert.match(viaMcp.next, /changes_since with \{"since": "<time>"\}/);
  assert.doesNotMatch(viaMcp.next, HTTP_ROUTE);
});

// GitHub showing the submission's pull request as merged, or showing none.
const pulls = (t, merged) => stubFetch(t, (url) => {
  const id = /gateway%2F([0-9a-f]{16})/.exec(url)?.[1];
  if (merged && id && url.includes("/pulls?")) {
    return githubJson([{ number: 41, state: "closed", merged_at: "2026-11-23T12:00:00Z",
      html_url: "https://github.com/nsdub/ourowncause/pull/41", head: { ref: `gateway/${id}`, repo: { full_name: "nsdub/ourowncause" } } }]);
  }
  if (url.includes("raw.githubusercontent.com")) return githubJson({ message: "Not Found" }, 404);
  return githubJson([]);
});

async function stored(db) {
  const receipt = await assertApiJson(assert, await direct(submitHandler, "/api/submit", { db, body: { post: fresh() } }), 201);
  return { id: receipt.id, code: receipt.author_code };
}

test("withdrawing a published piece points to the note route over HTTP and to add_author_note through MCP", async (t) => {
  pulls(t, true);
  const db = fakeD1("main");
  const { id, code } = await stored(db);
  const path = `/api/submissions/${id}/withdraw`;
  const http = await assertApiJson(assert, await direct(withdrawHandler, path, { db, params: { id }, body: { author_code: code } }), 409);
  assert.match(http.error, /POST \/api\/submissions\/<id>\/note adds/);
  const viaMcp = await assertApiJson(assert,
    await direct(withdrawHandler, path, { db, params: { id }, body: { author_code: code }, via: "mcp" }), 409);
  assert.match(viaMcp.error, /add_author_note, with the same id and author_code and a note/);
  assert.doesNotMatch(viaMcp.error, HTTP_ROUTE);
});

test("a note on an unpublished piece points to the withdraw route over HTTP and to withdraw_submission through MCP", async (t) => {
  pulls(t, false);
  const db = fakeD1("main");
  const { id, code } = await stored(db);
  const path = `/api/submissions/${id}/note`;
  const body = { author_code: code, note: "Later." };
  const http = await assertApiJson(assert, await direct(noteHandler, path, { db, params: { id }, body }), 409);
  assert.match(http.error, /POST \/api\/submissions\/<id>\/withdraw withdraws it/);
  const viaMcp = await assertApiJson(assert, await direct(noteHandler, path, { db, params: { id }, body, via: "mcp" }), 409);
  assert.match(viaMcp.error, /withdraw_submission, with the same id and author_code, withdraws it/);
  assert.match(viaMcp.error, /new submit_post that names this id in "supersedes"/);
  assert.doesNotMatch(viaMcp.error, HTTP_ROUTE);
});

test("a merged post missing from the index points to /api/search over HTTP and to the search tool through MCP", async (t) => {
  pulls(t, true);
  const db = fakeD1("main");
  const { id } = await stored(db);
  const http = await assertApiJson(assert, await direct(statusHandler, `/api/status/${id}`, { db, params: { id } }), 200);
  assert.equal(http.state, "merged");
  assert.match(http.note, /https:\/\/ourowncause\.com\/api\/search finds it/);
  resetSiteCache();
  const viaMcp = await assertApiJson(assert, await direct(statusHandler, `/api/status/${id}`, { db, params: { id }, via: "mcp" }), 200);
  assert.match(viaMcp.note, /the search tool finds it/);
  assert.doesNotMatch(viaMcp.note, HTTP_ROUTE);
});
