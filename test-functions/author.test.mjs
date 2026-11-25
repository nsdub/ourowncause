// The author_code of a receipt: withdrawing a submission before publication, and adding an
// author's note after it. A published piece is never removed by either.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import { onRequest as status } from "../functions/api/status/[id].js";
import { onRequest as noteHandler } from "../functions/api/submissions/[id]/note.js";
import { onRequest as withdrawHandler } from "../functions/api/submissions/[id]/withdraw.js";
import { onRequest as notesPending } from "../functions/api/submissions/notes/pending.js";
import { onRequest as pending } from "../functions/api/submissions/pending.js";
import { onRequest as withdrawnList } from "../functions/api/submissions/withdrawn.js";
import { onRequest as submit } from "../functions/api/submit.js";
import { resetSiteCache } from "../functions/_lib/site.js";
import { assertApiJson, brokenD1, fakeAssets, fakeContext, fakeD1, githubJson, INDEX, stubFetch, VALID_POST }
  from "./helpers.mjs";

beforeEach(resetSiteCache);

const API = "https://api.github.com/repos/nsdub/ourowncause";
const LEDGER = "https://raw.githubusercontent.com/nsdub/ourowncause/gateway-state/state.json";
const PR = "https://github.com/nsdub/ourowncause/pull/41";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const rows = (db, table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all();
let serial = 0;
const fresh = () => `${VALID_POST}\nParagraph for the author tests ${++serial}.\n`;

async function send(text, db, extra = {}) {
  const ctx = fakeContext({ url: "https://ourowncause.com/api/submit", method: "POST",
    body: JSON.stringify({ post: text, ...extra }),
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    env: { ASSETS: fakeAssets({ "/index.json": INDEX }), DB: db } });
  const response = await submit(ctx);
  await ctx.settled();
  return response;
}
// A stored submission and its receipt.
async function submitted(db = fakeD1("main")) {
  const receipt = await assertApiJson(assert, await send(fresh(), db), 201);
  return { db, receipt, id: receipt.id, code: receipt.author_code };
}
const act = (handler, what) => async (db, id, body, { method = "POST", headers = {}, env } = {}) => {
  const kicked = [];
  const ctx = fakeContext({ url: `https://ourowncause.com/api/submissions/${id}/${what}`, method, params: { id },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", ...headers },
    env: env ?? { DB: db, TIMER: { fetch: async (url) => { kicked.push(url); return new Response("ok"); } } } });
  const response = await handler(ctx);
  await ctx.settled();
  response.kicked = kicked;
  return response;
};
const withdraw = act(withdrawHandler, "withdraw");
const addNote = act(noteHandler, "note");
const getStatus = (db, id) => status(fakeContext({ url: `https://ourowncause.com/api/status/${id}`, params: { id },
  env: { DB: db, ASSETS: fakeAssets({ "/index.json": INDEX }) } }));
const list = (handler, path) => (db, query = "") => handler(fakeContext({
  url: `https://ourowncause.com/api/submissions/${path}${query}`, env: db ? { DB: db } : {} }));
const listPending = list(pending, "pending");
const listWithdrawn = list(withdrawnList, "withdrawn");
const listNotes = list(notesPending, "notes/pending");

const pullsOf = (id) => `${API}/pulls?head=nsdub%3Agateway%2F${id}&state=all&per_page=10`;
const pull = (id, over = {}) => ({ number: 41, state: "open", merged_at: null, html_url: PR,
  head: { ref: `gateway/${id}`, repo: { full_name: "nsdub/ourowncause" } }, ...over });
// GitHub as these tests need it: the pull requests of one submission, and the gateway's ledger.
const github = (t, id, pulls = [], ledger = null) => stubFetch(t, (url) => {
  if (url === pullsOf(id)) return githubJson(pulls);
  if (url === LEDGER) return ledger === null ? githubJson({ message: "Not Found" }, 404) : githubJson(ledger);
  if (url.startsWith(`${API}/issues/`)) return githubJson([]);
  if (url.startsWith(`${API}/pulls?head=`)) return githubJson([]);
  throw new Error(`unexpected request: ${url}`);
});
const merged = (id) => [pull(id, { state: "closed", merged_at: "2026-11-23T12:00:00Z" })];

// --- the receipt ---------------------------------------------------------------------------

test("the 201 receipt carries an author_code of 32 hex characters, and only its SHA-256 is stored", async () => {
  const { db, receipt } = await submitted();
  assert.match(receipt.author_code, /^[0-9a-f]{32}$/);
  const [row] = rows(db, "submissions");
  assert.equal(row.author_code_hash, sha256(receipt.author_code));
  assert.ok(!JSON.stringify(rows(db, "submissions")).includes(receipt.author_code));
  assert.match(receipt.next, /author_code is shown in this receipt only/);
  assert.match(receipt.next, /\/withdraw withdraws the piece before publication/);
  assert.match(receipt.next, /\/note adds a public, dated author's note/);
});

test("every receipt has its own code", async () => {
  const db = fakeD1("main");
  const codes = new Set();
  for (let i = 0; i < 5; i++) codes.add((await submitted(db)).code);
  assert.equal(codes.size, 5);
});

test("the same text sent again gets its first receipt without a code, and status never shows one", async (t) => {
  const db = fakeD1("main");
  const text = fresh();
  const first = await assertApiJson(assert, await send(text, db), 201);
  const again = await assertApiJson(assert, await send(text, db), 200);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.ok(!("author_code" in again));
  assert.equal(rows(db, "submissions")[0].author_code_hash, sha256(first.author_code));
  github(t, first.id);
  const shown = JSON.stringify(await assertApiJson(assert, await getStatus(db, first.id), 200));
  assert.ok(!shown.includes(first.author_code) && !shown.includes("author_code"));
  const listed = JSON.stringify(await assertApiJson(assert, await listPending(db), 200));
  assert.ok(!listed.includes("author_code") && !listed.includes(sha256(first.author_code)));
});

test("a post that brings its own author_notes is refused: the gateway writes that key", async () => {
  const db = fakeD1("main");
  const text = fresh().replace("summary:", 'author_notes:\n  - date: "2026-11-01"\n    text: "x"\nsummary:');
  const data = await assertApiJson(assert, await send(text, db), 422);
  assert.match(data.errors.join("\n"), /author_notes is written by the submission gateway/);
  assert.equal(rows(db, "submissions").length, 0);
});

// --- withdrawing before publication -----------------------------------------------------------

test("with the code, a waiting submission is withdrawn: the pending list drops it and status says withdrawn", async (t) => {
  const { db, id, code } = await submitted();
  github(t, id);
  assert.deepEqual((await assertApiJson(assert, await listPending(db), 200)).pending.map((p) => p.id), [id]);
  const response = await withdraw(db, id, { author_code: code });
  const data = await assertApiJson(assert, response, 200);
  assert.equal(data.state, "withdrawn");
  assert.equal(data.status_url, `https://ourowncause.com/api/status/${id}`);
  assert.match(data.next, /Withdrawn by its author before publication\./);
  assert.ok(Math.abs(Date.parse(data.withdrawn_at) - Date.now()) < 5_000);
  assert.deepEqual(response.kicked, ["https://timer.internal/kick"]); // the gateway is asked to run now
  assert.equal(rows(db, "submissions")[0].state, "withdrawn");

  assert.deepEqual((await assertApiJson(assert, await listPending(db), 200)).pending, []);
  const shown = await assertApiJson(assert, await getStatus(db, id), 200);
  assert.equal(shown.state, "withdrawn");
  assert.equal(shown.withdrawn_at, data.withdrawn_at);
  assert.match(shown.note, /Withdrawn by its author before publication/);
  const listed = await assertApiJson(assert, await listWithdrawn(db), 200);
  assert.deepEqual(listed, { pending: [{ id, withdrawn_at: data.withdrawn_at }], next_after: null, notice: listed.notice });
});

test("a submission whose pull request is open is withdrawn too, and keeps its pull request's address", async (t) => {
  const { db, id, code } = await submitted();
  github(t, id, [pull(id)]);
  assert.equal((await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 200)).state, "withdrawn");
  const shown = await assertApiJson(assert, await getStatus(db, id), 200);
  assert.deepEqual([shown.state, shown.pr_url], ["withdrawn", PR]);
});

test("a wrong code is a 403 with the same message whether or not the id exists, and nothing changes", async (t) => {
  const { db, id, code } = await submitted();
  const calls = github(t, id);
  const wrong = "0".repeat(32);
  const answers = [];
  for (const [target, given] of [[id, wrong], ["ffffffffffffffff", wrong], ["ffffffffffffffff", code],
    [id, code.toUpperCase()], [id, `${code}0`], [id, ""], [id, code.slice(0, 31)]]) {
    for (const handler of [withdraw, addNote]) {
      const data = await assertApiJson(assert, await handler(db, target, { author_code: given, note: "A note." }), 403);
      answers.push(JSON.stringify(data));
    }
  }
  assert.equal(new Set(answers).size, 1);
  assert.match(JSON.parse(answers[0]).error, /author_code does not match this submission id/);
  assert.equal(rows(db, "submissions")[0].state, null);
  assert.equal(rows(db, "author_notes").length, 0);
  assert.deepEqual(calls, []); // GitHub is asked only for the holder of the code
});

test("a submission stored before codes existed has no code that matches", async () => {
  const db = fakeD1("main");
  db.sqlite.prepare("INSERT INTO submissions (id, created, title, path, body, provisional) "
    + "VALUES ('00000000000000aa', ?, 'T', 'posts/2026/11/t-000000.md', 'b', '{}')").run(new Date().toISOString());
  for (const given of ["", "0".repeat(32), sha256("")]) {
    await assertApiJson(assert, await withdraw(db, "00000000000000aa", { author_code: given }), 403);
  }
});

test("after the merge a withdrawal is a 409 that says published pieces are not removed and names the note", async (t) => {
  const { db, id, code } = await submitted();
  github(t, id, merged(id));
  const data = await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 409);
  assert.match(data.error, /published pieces are not removed by their authors/);
  assert.match(data.error, /author's note is the route: POST \/api\/submissions\/<id>\/note/);
  assert.equal(data.state, "merged");
  const [row] = rows(db, "submissions");
  assert.deepEqual([row.state, row.withdrawn, row.pr], [null, null, PR]);
  assert.equal((await assertApiJson(assert, await getStatus(db, id), 200)).state, "merged");
  assert.deepEqual((await assertApiJson(assert, await listWithdrawn(db), 200)).pending, []);
});

test("when GitHub cannot be read nothing is withdrawn: 503, try again", async (t) => {
  const { db, id, code } = await submitted();
  stubFetch(t, () => { throw new Error("network down"); });
  const data = await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 503);
  assert.match(data.error, /could not confirm that this piece is unpublished, and nothing was changed/);
  assert.equal(rows(db, "submissions")[0].state, null);
});

test("withdrawing twice answers the same, with the first time", async (t) => {
  const { db, id, code } = await submitted();
  github(t, id);
  const first = await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 200);
  const again = await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 200);
  assert.deepEqual([again.state, again.withdrawn_at, again.already], ["withdrawn", first.withdrawn_at, true]);
});

test("a withdrawn text can be submitted again as a fresh submission with a new code", async (t) => {
  const db = fakeD1("main");
  const text = fresh();
  const first = await assertApiJson(assert, await send(text, db), 201);
  github(t, first.id);
  await assertApiJson(assert, await withdraw(db, first.id, { author_code: first.author_code }), 200);
  const second = await assertApiJson(assert, await send(text, db), 201);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.author_code, first.author_code);
});

test("the ledger undoes a withdrawal that reached the gateway after the merge", async (t) => {
  const { db, id, code } = await submitted();
  const other = await submitted(db);
  let ledger = null;
  stubFetch(t, (url) => {
    if (url === LEDGER) return ledger === null ? githubJson({}, 404) : githubJson(ledger);
    if (url.startsWith(`${API}/pulls?head=`)) return githubJson([]);
    throw new Error(`unexpected request: ${url}`);
  });
  await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 200);
  await assertApiJson(assert, await withdraw(db, other.id, { author_code: other.code }), 200);
  ledger = { [id]: { state: "withdrawn", outcome: "merged", pr: PR, at: "2026-11-23T12:00:00Z" },
    [other.id]: { state: "withdrawn", outcome: "closed", pr: PR.replace("41", "42"), at: "2026-11-23T12:00:00Z" } };
  db.sqlite.prepare("DELETE FROM status_cache").run(); // the ledger is read again
  await assertApiJson(assert, await listPending(db), 200);
  const byId = Object.fromEntries(rows(db, "submissions").map((r) => [r.id, r]));
  assert.deepEqual([byId[id].state, byId[id].withdrawn, byId[id].pr], [null, null, PR]);
  assert.equal(byId[other.id].state, "withdrawn");
});

test("withdraw and note: only POST, only JSON, a 16-hex id, a string code, a small body", async () => {
  const { db, id, code } = await submitted();
  for (const handler of [withdraw, addNote]) {
    const get = await assertApiJson(assert, await handler(db, id, null, { method: "GET" }), 405);
    assert.match(get.error, /use POST/);
    await assertApiJson(assert, await handler(db, id, { author_code: code }, { headers: { "content-type": "text/plain" } }), 415);
    await assertApiJson(assert, await handler(db, "not-an-id", { author_code: code }), 400);
    await assertApiJson(assert, await handler(db, id, "{not json"), 400);
    const missing = await assertApiJson(assert, await handler(db, id, {}), 400);
    assert.match(missing.error, /"author_code" is required/);
    await assertApiJson(assert, await handler(db, id, { author_code: 7 }), 400);
    await assertApiJson(assert, await handler(db, id, { author_code: code, note: "x".repeat(20_000) }), 400);
    await assertApiJson(assert, await handler(db, id, { author_code: code, note: "A note." }, { env: { DB: brokenD1() } }), 503);
  }
});

// --- the author's note after publication -------------------------------------------------------

test("with the code, a note on a merged piece is stored with its time and listed for the gateway", async (t) => {
  const { db, id, code, receipt } = await submitted();
  github(t, id, merged(id));
  const response = await addNote(db, id, { author_code: code, note: "I no longer hold the second claim." });
  const data = await assertApiJson(assert, response, 201);
  assert.match(data.id, /^[0-9a-f]{16}$/);
  assert.equal(data.submission, id);
  assert.equal(data.date, new Date().toISOString().slice(0, 10));
  assert.equal(data.status_url, `https://ourowncause.com/api/status/${id}`);
  assert.match(data.next, /labelled author-note/);
  assert.match(data.next, /Later notes sent with the author code/);
  assert.deepEqual(response.kicked, ["https://timer.internal/kick"]);
  const [row] = rows(db, "author_notes");
  assert.deepEqual([row.id, row.submission, row.note, row.created, row.pr, row.state],
    [data.id, id, "I no longer hold the second claim.", data.received, null, null]);
  assert.ok(Math.abs(Date.parse(row.created) - Date.now()) < 5_000);

  const listed = await assertApiJson(assert, await listNotes(db), 200);
  assert.deepEqual(listed.pending, [{ id: data.id, submission: id, path: receipt.path,
    note: "I no longer hold the second claim.", received: data.received }]);
  assert.equal(listed.next_after, null);
  const shown = await assertApiJson(assert, await getStatus(db, id), 200);
  assert.deepEqual(shown.author_notes, [{ id: data.id, received: data.received, state: "queued", pr_url: null }]);
  assert.equal(shown.state, "merged");
});

test("a note is only for a merged piece: queued, open, closed and withdrawn are 409", async (t) => {
  for (const pulls of [[], ["open"], ["closed"]]) {
    const { db, id, code } = await submitted();
    github(t, id, pulls.map((state) => pull(id, { state })));
    const data = await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "A note." }), 409);
    assert.match(data.error, /added to a published piece, and this one is not published/);
    assert.match(data.error, /\/withdraw/);
    assert.equal(rows(db, "author_notes").length, 0);
  }
  const { db, id, code } = await submitted();
  github(t, id);
  await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 200);
  const data = await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "A note." }), 409);
  assert.match(data.error, /withdrawn before publication/);
});

test("a note is 1 to 1,000 characters under the same character rules as a post", async (t) => {
  const { db, id, code } = await submitted();
  github(t, id, merged(id));
  const refused = { "": /"note" is required/, "   \n ": /"note" is required/, ["x".repeat(1_001)]: /at most 1000 characters/,
    "a\u0000b": /control and text-direction characters are not accepted: remove U\+0000/,
    "a‮b": /remove U\+202E/, "a​b": /remove U\+200B/, "a\uD800b": /not valid Unicode/ };
  for (const [note, why] of Object.entries(refused)) {
    const data = await assertApiJson(assert, await addNote(db, id, { author_code: code, note }), 422);
    assert.equal(data.ok, false);
    assert.match(data.errors.join("\n"), why, JSON.stringify(note));
  }
  for (const note of [7, null, ["a"], undefined]) {
    await assertApiJson(assert, await addNote(db, id, { author_code: code, note }), 422);
  }
  assert.equal(rows(db, "author_notes").length, 0);
  // 1,000 characters are counted as characters, not UTF-16 units, and line breaks are fine.
  await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "𝒳".repeat(1_000) }), 201);
  await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Two\nlines, with a tab\t." }), 201);
});

test("at most 3 notes per piece; the same note again gets its first receipt; a failed one does not count", async (t) => {
  const { db, id, code } = await submitted();
  github(t, id, merged(id));
  const first = await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Note 1." }), 201);
  const again = await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Note 1." }), 200);
  assert.deepEqual([again.id, again.duplicate, again.received], [first.id, true, first.received]);
  await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Note 2." }), 201);
  await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Note 3." }), 201);
  const full = await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Note 4." }), 409);
  assert.match(full.error, /at most 3 author's notes, and this one has 3/);
  assert.equal(rows(db, "author_notes").length, 3);
  db.sqlite.prepare("UPDATE author_notes SET state = 'failed' WHERE note = 'Note 2.'").run();
  await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "Note 4." }), 201);
});

test("when GitHub cannot be read no note is stored: 503, try again", async (t) => {
  const { db, id, code } = await submitted();
  stubFetch(t, () => { throw new Error("network down"); });
  const data = await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "A note." }), 503);
  assert.match(data.error, /could not confirm that this piece is\s+published, and nothing was stored/);
  assert.equal(rows(db, "author_notes").length, 0);
});

test("a merge the status page has already seen is not asked about again", async (t) => {
  const { db, id, code } = await submitted();
  const calls = github(t, id, merged(id));
  await assertApiJson(assert, await getStatus(db, id), 200);
  const before = calls.length;
  await assertApiJson(assert, await addNote(db, id, { author_code: code, note: "A note." }), 201);
  await assertApiJson(assert, await withdraw(db, id, { author_code: code }), 409);
  assert.equal(calls.length, before);
});

test("the gateway's ledger says which notes have a pull request and which it gave up on", async (t) => {
  const { db, id, code } = await submitted();
  let ledger = null;
  stubFetch(t, (url) => {
    if (url === pullsOf(id)) return githubJson(merged(id));
    if (url === LEDGER) return ledger === null ? githubJson({}, 404) : githubJson(ledger);
    if (url.startsWith(`${API}/issues/`)) return githubJson([]);
    throw new Error(`unexpected request: ${url}`);
  });
  const notes = [];
  for (const note of ["Note 1.", "Note 2.", "Note 3."]) {
    notes.push(await assertApiJson(assert, await addNote(db, id, { author_code: code, note }), 201));
  }
  const NOTE_PR = "https://github.com/nsdub/ourowncause/pull/77";
  ledger = { [`note:${notes[0].id}`]: { state: "done", pr: NOTE_PR },
    [`note:${notes[1].id}`]: { state: "failed", reason: "the post is not on main at its path" },
    [`note:${notes[2].id}`]: { state: "retry", reason: "later" },
    "note:not-an-id": { state: "done", pr: NOTE_PR }, [`note:${"e".repeat(16)}`]: { state: "done", pr: "https://evil.example/pull/1" } };
  const listed = await assertApiJson(assert, await listNotes(db), 200);
  assert.deepEqual(listed.pending.map((n) => n.id), [notes[2].id]);
  const shown = await assertApiJson(assert, await getStatus(db, id), 200);
  assert.deepEqual(shown.author_notes.map((n) => [n.state, n.pr_url]),
    [["filed", NOTE_PR], ["failed", null], ["queued", null]]);
  // A note the gateway has filed is not a submission's pull request.
  assert.equal(rows(db, "submissions")[0].pr, PR);
});

test("the notes and withdrawn lists: GET only, a numeric after, 503 without storage, pages that continue", async () => {
  for (const [handler, path] of [[notesPending, "notes/pending"], [withdrawnList, "withdrawn"]]) {
    const call = (db, query = "", method = "GET") => handler(fakeContext({
      url: `https://ourowncause.com/api/submissions/${path}${query}`, method, env: db ? { DB: db } : {} }));
    await assertApiJson(assert, await call(fakeD1("main"), "", "POST"), 405);
    await assertApiJson(assert, await call(fakeD1("main"), "?after=x"), 400);
    await assertApiJson(assert, await call(brokenD1()), 503);
    await assertApiJson(assert, await call(null), 503);
  }
  const db = fakeD1("main");
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const insert = db.sqlite.prepare("INSERT INTO submissions (id, created, title, path, body, provisional, state, withdrawn) "
    + "VALUES (?, ?, 'T', 'p', 'b', '{}', 'withdrawn', ?)");
  for (let n = 1; n <= 101; n++) insert.run(n.toString(16).padStart(16, "0"), now, now);
  insert.run("f".repeat(16), old, old); // withdrawn more than 14 days ago: no longer listed
  const first = await assertApiJson(assert, await listWithdrawn(db), 200);
  assert.equal(first.pending.length, 100);
  const second = await assertApiJson(assert, await listWithdrawn(db, `?after=${first.next_after}`), 200);
  assert.deepEqual([second.pending.length, second.next_after], [1, null]);
});
