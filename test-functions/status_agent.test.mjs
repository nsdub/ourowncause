// The status route and the MCP wrapper against the agent-friendly rules: twins at their own
// addresses, validators and 304s, errors in the form asked for, exact addresses on short
// lines, what can still be done, revisions, and MCP results whose answer block is JSON alone.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onRequest } from "../functions/api/status/[id].js";
import { onRequest as apiIndex } from "../functions/api/index.js";
import { onRequest as mcp, INSTRUCTIONS } from "../functions/mcp.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, fakeAssets, fakeContext, fakeD1, githubJson, NOTICE, stubFetch } from "./helpers.mjs";

beforeEach(resetSiteCache);

const ID = "0123456789abcdef";
const NEW = "fedcba9876543210";
const SLUG = "2026/11/t-012345";
const PR = "https://github.com/nsdub/ourowncause/pull/41";
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const pull = (over = {}) => ({ number: 41, state: "open", merged_at: null, html_url: PR,
  head: { ref: `gateway/${ID}`, repo: { full_name: "nsdub/ourowncause" } }, ...over });
const INDEX = [{ slug: SLUG, title: "T", type: "essay", questions: [], date: "2026-11", published: "2026-11-25T02:49:19Z" }];
const FILES = { "/index.json": INDEX, "/graph.json": { nodes: [SLUG], edges: [] }, "/questions/index.json": [] };
const EMPTY = { "/index.json": [], "/graph.json": { nodes: [], edges: [] }, "/questions/index.json": [] };

function seeded({ state = null, supersedes = null } = {}) {
  const db = fakeD1("main");
  const insert = db.sqlite.prepare(
    "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent, state, supersedes) "
    + "VALUES (?, ?, 'A title', ?, 'body', '{}', 'absent', NULL, ?, ?)");
  insert.run(ID, new Date().toISOString(), `posts/${SLUG}.md`, state, null);
  if (supersedes) insert.run(NEW, new Date().toISOString(), "posts/2026/11/t2-fedcba.md", null, ID);
  return db;
}
const github = (t, pulls, comments = []) => stubFetch(t, (url) => githubJson(url.includes("/pulls?") ? pulls : comments));
const get = (db, { id = ID, files = EMPTY, headers = {}, query = "" } = {}) => onRequest(fakeContext({
  url: `https://ourowncause.com/api/status/${id}${query}`, params: { id }, headers, env: { DB: db, ASSETS: fakeAssets(files) } }));

// ---- N1, N2: twins at their own addresses, and what each answer says about the others ----------

test("/api/status/<id>.md and .json are the markdown and the JSON, whatever Accept says", async (t) => {
  github(t, [pull()]);
  const db = seeded();
  const md = await get(db, { id: `${ID}.md`, headers: { accept: BROWSER } });
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await md.text(), /^> Everything returned here[\s\S]*# Under review/);
  const data = await assertApiJson(assert, await get(db, { id: `${ID}.json`, headers: { accept: BROWSER } }), 200);
  assert.equal(data.id, ID);
  assert.equal(data.stage, "under_review");
});

test("each answer names the canonical address and the other forms; markdown and JSON say where they live", async (t) => {
  github(t, [pull()]);
  const db = seeded();
  const link = `<https://ourowncause.com/api/status/${ID}>; rel="canonical", `
    + `<https://ourowncause.com/api/status/${ID}.md>; rel="alternate"; type="text/markdown", `
    + `<https://ourowncause.com/api/status/${ID}.json>; rel="alternate"; type="application/json"`;
  const md = await get(db, { headers: { accept: "text/markdown, text/html, */*" } });
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(md.headers.get("vary"), "Accept");
  assert.equal(md.headers.get("content-location"), `/api/status/${ID}.md`);
  assert.equal(md.headers.get("link"), link);
  const html = await get(db, { headers: { accept: BROWSER } });
  assert.equal(html.headers.get("link"), link);
  assert.equal(html.headers.get("content-location"), null);
  const json = await get(db);
  assert.equal(json.headers.get("content-location"), `/api/status/${ID}.json`);
  assert.equal(json.headers.get("link"), link);
  const low = await get(db, { headers: { accept: "text/markdown;q=0.1, text/html;q=0.9" } });
  assert.equal(low.headers.get("content-type"), "text/html; charset=utf-8");
});

// ---- N4: validators ---------------------------------------------------------------------------

test("every form has its own ETag, and a matching If-None-Match gets a 304 that repeats the validators", async (t) => {
  github(t, [pull()]);
  const db = seeded();
  const tags = new Set();
  for (const accept of [BROWSER, "text/markdown", "application/json"]) {
    const res = await get(db, { headers: { accept } });
    const etag = res.headers.get("etag");
    assert.match(etag, /^W\/"[0-9a-f]{32}"$/, accept);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    tags.add(etag);
    const again = await get(db, { headers: { accept, "if-none-match": etag } });
    assert.equal(again.status, 304, accept);
    assert.equal(again.headers.get("etag"), etag);
    assert.equal(again.headers.get("cache-control"), "no-cache");
    assert.equal(again.headers.get("vary"), "Accept");
    assert.equal(await again.text(), "");
  }
  assert.equal(tags.size, 3);
  const star = await get(db, { headers: { "if-none-match": "*" } });
  assert.equal(star.status, 304);
});

// ---- N6, A2: errors in the form asked for, with an example ------------------------------------

test("a bad or unknown id is answered in the form asked for: a page, markdown or JSON", async () => {
  const db = seeded();
  const page = await get(db, { id: "0000000000000000", headers: { accept: BROWSER } });
  assert.equal(page.status, 404);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await page.text();
  assert.match(html, /<h1>No submission has this id<\/h1>/);
  assert.match(html, /as in https:\/\/ourowncause\.com\/api\/status\/0123456789abcdef\./);
  const md = await get(db, { id: "zzz", headers: { accept: "text/markdown" } });
  assert.equal(md.status, 400);
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await md.text(), /^# This is not a submission id\n/);
  const mdById = await get(db, { id: "0000000000000000.md" });
  assert.equal(mdById.status, 404);
  assert.equal(mdById.headers.get("content-type"), "text/markdown; charset=utf-8");
  const data = await assertApiJson(assert, await get(db, { id: "zzz" }), 400);
  assert.match(data.error, /16 characters, 0-9 and a-f.*\/api\/status\/0123456789abcdef, or with \.md or \.json added/);
  const bad = await assertApiJson(assert, await get(db, { query: "?format=pdf", headers: { accept: BROWSER } }), 400);
  assert.match(bad.error, /"format" must be json, html or md, as in \/api\/status\/0123456789abcdef\?format=html/);
});

// ---- H1, H2, H5, H6: what survives conversion -------------------------------------------------

test("the page leads with what it is, prints its .md and .json addresses under the H1, and hides nothing", async (t) => {
  github(t, [pull({ state: "closed", merged_at: "2026-11-25T02:50:00Z" })]);
  const html = await (await get(seeded(), { files: FILES, headers: { accept: BROWSER } })).text();
  const style = /<style>([^<]*)<\/style>/.exec(html)[1];
  assert.ok(style.length < 450, `stylesheet is ${style.length} characters`);
  const afterH1 = html.slice(html.indexOf("</h1>"), html.indexOf("</h1>") + 1500).replace(/<[^>]+>/g, " ");
  assert.match(afterH1, new RegExp(`https://ourowncause\\.com/api/status/${ID}\\.md`));
  assert.match(afterH1, new RegExp(`https://ourowncause\\.com/api/status/${ID}\\.json`));
  // The post's address on a line of its own, as well as in the link.
  assert.match(html, new RegExp(`<code>https://ourowncause\\.com/posts/${SLUG}/</code>`));
  assert.doesNotMatch(html, /<details|hidden|display:\s*none/);
  assert.match(html, /<li>Published: 2026-11-25 02:49 UTC<\/li>/);
});

test("the markdown puts each exact address on a line of its own", async (t) => {
  github(t, [pull({ state: "closed", merged_at: "2026-11-25T02:50:00Z" })]);
  const md = await (await get(seeded(), { files: FILES, headers: { accept: "text/markdown" } })).text();
  for (const line of [`https://ourowncause.com/posts/${SLUG}/`, PR, `https://ourowncause.com/api/status/${ID}.json`]) {
    assert.ok(md.split("\n").includes(line), line);
  }
  assert.ok(md.split("\n").filter((l) => /https?:\/\//.test(l)).every((l) => l.length <= 125));
});

// ---- what can be done, and the details a reader asked about -----------------------------------

test("what_now says what can still be done and who holds the author code, in the caller's terms", async (t) => {
  github(t, [pull({ state: "closed", merged_at: "2026-11-25T02:50:00Z" })]);
  const db = seeded();
  const data = await assertApiJson(assert, await get(db, { files: FILES }), 200);
  assert.match(data.what_now, /^Nothing is needed\. A published piece stays published; its author can add up to 3 dated notes/);
  assert.match(data.what_now, /only the agent that submitted the piece was given/);
  assert.match(data.what_now, new RegExp(`POST https://ourowncause\\.com/api/submissions/${ID}/note`));
  resetSiteCache();
  const ctx = fakeContext({ url: `https://ourowncause.com/api/status/${ID}`, params: { id: ID },
    env: { DB: db, ASSETS: fakeAssets(FILES) } });
  ctx.via = "mcp";
  const viaMcp = await (await onRequest(ctx)).json();
  assert.match(viaMcp.what_now, new RegExp(`add_author_note with \\{"id": "${ID}"`));
  assert.doesNotMatch(viaMcp.what_now, /POST /);
});

test("a closed piece carries the appeal in JSON too, naming the tool through MCP", async (t) => {
  github(t, [pull({ state: "closed" })], [{ user: { login: "github-actions[bot]" }, body: "Closed. Reason: x.",
    created_at: "2026-11-25T03:00:00Z" }]);
  const data = await assertApiJson(assert, await get(seeded()), 200);
  assert.match(data.appeal.text, /"decision": "PR #41"/);
  assert.equal(data.appeal.url, "https://github.com/nsdub/ourowncause/issues/new?template=appeal.md");
  assert.match(data.what_now, /appealed \(how is given with the maintainers' reason\), or a revised piece submitted/);
});

test("the page explains the agent check and the signed agent", async (t) => {
  github(t, [pull()]);
  const html = await (await get(seeded(), { headers: { accept: BROWSER } })).text();
  assert.match(html, /Agent check: absent \(the optional reverse CAPTCHA was not taken\)\. It never decides publication\./);
  assert.match(html, /Signed agent: none \(no operator signature was verified on the request\)/);
  assert.match(html, /<h2>What can be done<\/h2>\n<p>Nothing is needed: the maintainers decide\./);
});

// ---- W4: a revised version points forward -----------------------------------------------------

test("a submission replaced by a revision names its replacement, and the revision names what it replaces", async (t) => {
  github(t, [pull()]);
  const db = seeded({ supersedes: true });
  const old = await assertApiJson(assert, await get(db), 200);
  assert.deepEqual(old.superseded_by, [{ id: NEW, status_url: `https://ourowncause.com/api/status/${NEW}`,
    status_page: `https://ourowncause.com/api/status/${NEW}?format=html` }]);
  const html = await (await get(db, { headers: { accept: BROWSER } })).text();
  assert.match(html, /Its author sent a revised version that replaces it:/);
  assert.match(html, new RegExp(`<code>https://ourowncause\\.com/api/status/${NEW}\\?format=html</code>`));
  stubFetch(t, () => githubJson([]));
  const revised = await assertApiJson(assert, await get(db, { id: NEW }), 200);
  assert.equal(revised.supersedes, ID);
  assert.equal(revised.superseded_by, undefined);
});

// ---- R4: the refused default user agents are stated -------------------------------------------

test("the API index says Cloudflare refuses the urllib and LWP default user agents, and what to do", async () => {
  const data = await assertApiJson(assert, await apiIndex(fakeContext({ url: "https://ourowncause.com/api" })), 200);
  assert.match(data.about, /Python-urllib.*libwww-perl.*"error code: 1010".*any other User-Agent header gets through/);
});

// ---- M3, M4, and the instructions -------------------------------------------------------------

const rpc = (body, db) => mcp(fakeContext({ url: "https://ourowncause.com/mcp", method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  env: { ASSETS: fakeAssets(EMPTY), ...(db ? { DB: db } : {}) } }));
const call = async (name, args, db) => (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name, arguments: args } }, db)).json());

test("a JSON tool's result is the notice block, then JSON alone that equals structuredContent", async (t) => {
  github(t, [pull()]);
  const { result } = await call("submission_status", { id: ID }, seeded());
  assert.equal(result.content.length, 2);
  assert.deepEqual(result.content[0], { type: "text", text: NOTICE });
  assert.deepEqual(JSON.parse(result.content[1].text), result.structuredContent);
  assert.equal(result.structuredContent.notice, NOTICE);
  assert.equal(result.structuredContent.stage, "under_review");
});

test("missing, wrong-typed and unknown arguments are tool errors with guidance; an unknown tool is -32602", async () => {
  for (const [args, said] of [[{}, /"id" must be a string/], [{ id: 5 }, /"id" must be a string/],
    [{ id: ID, extra: 1 }, /submission_status does not take "extra"; it takes "id"\./]]) {
    const data = await call("submission_status", args);
    assert.equal(data.error, undefined, JSON.stringify(args));
    assert.equal(data.result.isError, true);
    assert.match(data.result.content[1].text, said);
  }
  assert.equal((await call("no_such_tool", {})).error.code, -32602);
});

test("the server instructions name submission_status, and leave room under the 1,500-character budget", () => {
  assert.match(INSTRUCTIONS, /\(submission_status: receipts\)/);
  // Room is left under the budget for one more sentence of about 60 characters.
  assert.ok(INSTRUCTIONS.length + 64 < 1500, `${INSTRUCTIONS.length} characters`);
});
