import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest as subscribe } from "../functions/api/edition/subscribe.js";
import { onRequest as confirm } from "../functions/api/edition/confirm.js";
import { onRequest as unsubscribe } from "../functions/api/edition/unsubscribe.js";
import { onRequest as send } from "../functions/api/edition/send.js";
import { cleanEmail, confirmationEmail, editionEmail, NOT_SENDING, tokenHash, WHY_EMAIL } from "../functions/_lib/edition.js";
import { BATCH_MAX, mailer } from "../functions/_lib/mail.js";
import { fakeAssets, fakeContext, fakeD1, stubFetch } from "./helpers.mjs";

const URL_BASE = "https://ourowncause.com/api/edition";
const DRY = { MAIL_PROVIDER: "dry-run" };

function sub(body, { db, env = DRY, form = false, ip = "203.0.113.5" } = {}) {
  return subscribe(fakeContext({
    url: `${URL_BASE}/subscribe`, method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "cf-connecting-ip": ip },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    env: { DB: db, ...env },
  }));
}

test("addresses are checked and lowercased", () => {
  assert.equal(cleanEmail(" Reader@Example.ORG "), "reader@example.org");
  for (const bad of ["", "no-at-sign", "a@b", "a b@example.org", "<a@example.org>", "a@example.org\nBcc: x@y.z", 5, null]) {
    assert.equal(cleanEmail(bad), null, String(bad));
  }
  assert.equal(cleanEmail(`${"a".repeat(64)}@${"b".repeat(190)}.org`), null);
});

test("until a provider is set, subscribing answers 503, says where the edition is, and stores nothing", async () => {
  const db = fakeD1("main");
  const res = await sub({ email: "reader@example.org" }, { db, env: {} });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, NOT_SENDING);
  assert.equal(data.sending, false);
  assert.match(data.error, /https:\/\/ourowncause\.com\/edition\/feed\.xml/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM edition_subscribers").get().n, 0);
  const formRes = await sub({ email: "reader@example.org" }, { db, env: {}, form: true });
  assert.equal(formRes.status, 503);
  assert.match(formRes.headers.get("content-type"), /^text\/html/);
  assert.match(await formRes.text(), /not sending yet/);
});

test("double opt-in: a pending address gets one link, is confirmed by it, and the answer never says which", async (t) => {
  const db = fakeD1("main");
  const calls = stubFetch(t, async () => { throw new Error("no network in tests"); });
  const res = await sub({ email: "Reader@Example.org" }, { db, form: true });
  assert.equal(res.status, 202);
  assert.match(res.headers.get("content-security-policy"), /form-action 'self'/);
  const row = db.sqlite.prepare("SELECT * FROM edition_subscribers").get();
  assert.equal(row.email, "reader@example.org");
  assert.equal(row.state, "pending");
  assert.match(row.confirm_hash, /^[0-9a-f]{64}$/);
  assert.match(row.unsubscribe_token, /^[0-9a-f]{32}$/);
  assert.deepEqual(calls, [], "the dry-run adapter makes no request");
  // asking again within the hour sends nothing new and answers the same
  const again = await sub({ email: "reader@example.org" }, { db });
  assert.equal(again.status, 202);
  assert.equal(db.sqlite.prepare("SELECT confirm_hash FROM edition_subscribers").get().confirm_hash, row.confirm_hash);
  // a token we know: set one whose hash is stored, then follow it
  const known = "0123456789abcdef0123456789abcdef";
  db.sqlite.prepare("UPDATE edition_subscribers SET confirm_hash = ?").run(await tokenHash(known));
  const ok = await confirm(fakeContext({ url: `${URL_BASE}/confirm?token=${known}`, env: { DB: db } }));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Confirmed/);
  assert.equal(db.sqlite.prepare("SELECT state FROM edition_subscribers").get().state, "confirmed");
  // the link works once
  assert.equal((await confirm(fakeContext({ url: `${URL_BASE}/confirm?token=${known}`, env: { DB: db } }))).status, 404);
  // a confirmed address asking again gets the same answer and no new mail
  const third = await sub({ email: "reader@example.org" }, { db });
  assert.equal(third.status, 202);
  assert.deepEqual(Object.keys(await third.json()).sort(), ["message", "notice"]);
});

test("bad input, the daily limits and a stale pending row", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-25T12:00:00Z") });
  const db = fakeD1("main");
  assert.equal((await sub({ email: "nope" }, { db })).status, 400);
  assert.equal((await sub({ email: `${"x".repeat(3000)}@example.org` }, { db })).status, 400);
  const plain = await subscribe(fakeContext({ url: `${URL_BASE}/subscribe`, method: "POST", headers: { "content-type": "text/plain" }, body: "x", env: { DB: db, ...DRY } }));
  assert.equal(plain.status, 415);
  assert.equal((await subscribe(fakeContext({ url: `${URL_BASE}/subscribe`, env: { DB: db, ...DRY } }))).status, 405);
  for (let i = 0; i < 5; i++) assert.equal((await sub({ email: `r${i}@example.org` }, { db, ip: "198.51.100.1" })).status, 202);
  assert.equal((await sub({ email: "r9@example.org" }, { db, ip: "198.51.100.1" })).status, 429);
  // a pending address older than 7 days is deleted by the next request
  db.sqlite.prepare("UPDATE edition_subscribers SET created_at = ? WHERE email = 'r0@example.org'").run(Date.parse("2026-11-01T00:00:00Z"));
  await sub({ email: "other@example.org" }, { db, ip: "198.51.100.2" });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM edition_subscribers WHERE email = 'r0@example.org'").get().n, 0);
});

test("unsubscribing: GET shows a button, POST and one-click delete the row, and both answer the same for any token", async () => {
  const db = fakeD1("main");
  const tok = "fedcba9876543210fedcba9876543210";
  db.sqlite.prepare("INSERT INTO edition_subscribers (email, state, unsubscribe_token, created_at) VALUES ('a@example.org', 'confirmed', ?, 1)").run(tok);
  const get = await unsubscribe(fakeContext({ url: `${URL_BASE}/unsubscribe?token=${tok}`, env: { DB: db } }));
  assert.equal(get.status, 200);
  assert.match(await get.text(), /<form method="post" action="https:\/\/ourowncause\.com\/api\/edition\/unsubscribe\?token=fedcba/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM edition_subscribers").get().n, 1, "a GET removes nothing");
  const post = await unsubscribe(fakeContext({ url: `${URL_BASE}/unsubscribe?token=${tok}`, method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", env: { DB: db } }));
  assert.equal(post.status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM edition_subscribers").get().n, 0);
  const unknown = await unsubscribe(fakeContext({ url: `${URL_BASE}/unsubscribe?token=${"0".repeat(32)}`, method: "POST", env: { DB: db } }));
  assert.equal(unknown.status, 200);
  assert.equal((await unsubscribe(fakeContext({ url: `${URL_BASE}/unsubscribe?token=x`, env: { DB: db } }))).status, 404);
});

const EDITION = { number: 3, slug: "0003", date: "2026-11-23", subject: "Our Own Cause, issue 3: A title",
  text: "The edition text.\n", html: "<p>The edition.</p>\n", withheld: null };
const EDITION_FILES = {
  "/edition/index.json": { editions: [{ number: 3, date: "2026-11-23", withheld: null, json_url: "https://ourowncause.com/edition/0003.json" }] },
  "/edition/0003.json": EDITION,
};

function sendCall({ db, env = {}, auth = "Bearer s3cret", files = EDITION_FILES } = {}) {
  return send(fakeContext({ url: `${URL_BASE}/send`, method: "POST", headers: { authorization: auth },
    env: { DB: db, ASSETS: fakeAssets(files), EDITION_SEND_TOKEN: "s3cret", MAIL_PROVIDER: "resend", MAIL_API_KEY: "k", MAIL_FROM: "Our Own Cause <edition@ourowncause.com>", ...env } }));
}

test("send: the newest edition goes once to each confirmed address, with its own unsubscribe link, and a repeat resumes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T15:00:00Z") });
  const db = fakeD1("main");
  const insert = db.sqlite.prepare("INSERT INTO edition_subscribers (email, state, unsubscribe_token, created_at, last_sent_number) VALUES (?, ?, ?, 1, ?)");
  for (let i = 0; i < BATCH_MAX + 20; i++) insert.run(`r${String(i).padStart(3, "0")}@example.org`, "confirmed", i.toString(16).padStart(32, "0"), 0);
  insert.run("pending@example.org", "pending", "a".repeat(32), 0);
  insert.run("had-it@example.org", "confirmed", "b".repeat(32), 3);
  const bodies = [];
  let failNext = false;
  stubFetch(t, async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails/batch");
    assert.equal(init.headers.authorization, "Bearer k");
    const batch = JSON.parse(init.body);
    bodies.push(batch);
    if (failNext) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ data: batch.map((_, i) => ({ id: `id${i}` })) }), { status: 200 });
  });
  assert.equal((await sendCall({ db, auth: "Bearer wrong" })).status, 401);
  assert.equal((await sendCall({ db, auth: "" })).status, 401);
  const res = await sendCall({ db });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual([data.number, data.sent, data.failed, data.remaining], [3, BATCH_MAX + 20, 0, 0]);
  const first = bodies[0][0];
  assert.equal(first.subject, EDITION.subject);
  assert.equal(first.from, "Our Own Cause <edition@ourowncause.com>");
  assert.deepEqual(first.to, ["r000@example.org"]);
  assert.match(first.text, /To stop: https:\/\/ourowncause\.com\/api\/edition\/unsubscribe\?token=0{32}/);
  assert.equal(first.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const everyone = bodies.flat().map((m) => m.to[0]);
  assert.ok(!everyone.includes("pending@example.org") && !everyone.includes("had-it@example.org"));
  // a repeat sends nothing more
  bodies.length = 0;
  const again = await (await sendCall({ db })).json();
  assert.deepEqual([again.sent, again.remaining], [0, 0]);
  assert.equal(bodies.length, 0);
  // a provider failure stops the call and leaves the addresses for the next one
  db.sqlite.prepare("UPDATE edition_subscribers SET last_sent_number = 2 WHERE email LIKE 'r00%'").run();
  failNext = true;
  const failed = await (await sendCall({ db })).json();
  assert.deepEqual([failed.sent, failed.failed, failed.remaining], [0, 10, 10]);
});

test("send refuses without its token or a provider, and does not send a stale edition", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-05T15:00:00Z") });
  const db = fakeD1("main");
  assert.equal((await sendCall({ db, env: { EDITION_SEND_TOKEN: "" } })).status, 503);
  assert.equal((await sendCall({ db, env: { MAIL_PROVIDER: "" } })).status, 503);
  const stale = await (await sendCall({ db })).json();
  assert.match(stale.note, /more than 7 days old/);
  const none = await (await sendCall({ db, files: { "/edition/index.json": { editions: [] } } })).json();
  assert.equal(none.note, "there is no edition to send");
});

test("the postmark adapter sends a batch to the broadcast stream and reads each result", async (t) => {
  const seen = [];
  stubFetch(t, async (url, init) => {
    seen.push([url, init.headers["x-postmark-server-token"], JSON.parse(init.body)]);
    return new Response(JSON.stringify([{ ErrorCode: 0 }, { ErrorCode: 406, Message: "Inactive recipient" }]));
  });
  const m = mailer({ MAIL_PROVIDER: "Postmark", MAIL_API_KEY: "pm", MAIL_FROM: "x@ourowncause.com" });
  const out = await m.send([editionEmail(EDITION, "a@example.org", "c".repeat(32)), { to: "b@example.org", ...confirmationEmail("d".repeat(32)) }]);
  assert.deepEqual(out, [{ to: "a@example.org", ok: true }, { to: "b@example.org", ok: false, error: "Inactive recipient" }]);
  const [url, key, batch] = seen[0];
  assert.equal(url, "https://api.postmarkapp.com/email/batch");
  assert.equal(key, "pm");
  assert.equal(batch[0].MessageStream, "broadcast");
  assert.equal(batch[1].MessageStream, "outbound", "a confirmation is transactional");
  assert.deepEqual(batch[0].Headers.map((h) => h.Name), ["List-Unsubscribe", "List-Unsubscribe-Post"]);
});

test("no mailer without a known provider, its key and its sender; a batch is capped", async () => {
  assert.equal(mailer({}), null);
  assert.equal(mailer({ MAIL_PROVIDER: "carrier-pigeon", MAIL_API_KEY: "k", MAIL_FROM: "f" }), null);
  assert.equal(mailer({ MAIL_PROVIDER: "resend", MAIL_FROM: "f" }), null);
  assert.equal(mailer(DRY).name, "dry-run");
  await assert.rejects(mailer(DRY).send(Array.from({ length: BATCH_MAX + 1 }, () => ({ to: "a@example.org" }))), /at most/);
});

test("the email says why it came and how to stop it, and addresses no agent", () => {
  const email = editionEmail(EDITION, "a@example.org", "e".repeat(32));
  assert.ok(email.text.includes(WHY_EMAIL));
  assert.match(email.html, /Unsubscribe<\/a>/);
  const words = `${email.text} ${confirmationEmail("f".repeat(32)).text}`.toLowerCase();
  assert.ok(!/if you(?:'re| are) an? (?:ai|agent|model|assistant)/.test(words));
  assert.ok(!/\b(?:ignore|disregard) (?:all |any |your |previous )*instructions\b/.test(words));
});

test("the timer asks for a send every 5 minutes from 15:00 to 15:55 UTC, and at no other time", async () => {
  const { editionDue } = await import("../ops/timer/worker.js");
  const at = (h, m) => editionDue(new Date(Date.UTC(2026, 10, 24, h, m)));
  assert.equal([0, 5, 30, 55].every((m) => at(15, m)), true);
  assert.equal(at(15, 3) || at(14, 55) || at(16, 0), false);
});
