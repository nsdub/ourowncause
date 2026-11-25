import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest as subscribe } from "../functions/api/edition/subscribe.js";
import { onRequest as send } from "../functions/api/edition/send.js";
import { cleanEmail, NOT_SENDING } from "../functions/_lib/edition.js";
import { emailSlug, newsletter, NOT_CONFIGURED } from "../functions/_lib/newsletter.js";
import { fakeAssets, fakeContext, fakeD1, stubFetch } from "./helpers.mjs";

const URL_BASE = "https://ourowncause.com/api/edition";
const KEY = { BUTTONDOWN_API_KEY: "bd-test-key" };

function sub(body, { db = fakeD1("main"), env = KEY, form = false, ip = "203.0.113.5" } = {}) {
  return subscribe(fakeContext({
    url: `${URL_BASE}/subscribe`, method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "cf-connecting-ip": ip },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    env: { DB: db, ...env },
  }));
}

// A stand-in for Buttondown's API: records each request and answers as the handler says.
function buttondown(t, answer) {
  const seen = [];
  stubFetch(t, async (url, init = {}) => {
    const call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    seen.push(call);
    return answer(call);
  });
  return seen;
}
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("addresses are checked and lowercased", () => {
  assert.equal(cleanEmail(" Reader@Example.ORG "), "reader@example.org");
  for (const bad of ["", "no-at-sign", "a@b", "a b@example.org", "<a@example.org>", "a@example.org\nBcc: x@y.z", 5, null]) {
    assert.equal(cleanEmail(bad), null, String(bad));
  }
});

test("without BUTTONDOWN_API_KEY, subscribing answers 503 not configured, says where the edition is, and calls no one", async (t) => {
  const seen = buttondown(t, () => reply({}));
  const res = await sub({ email: "reader@example.org" }, { env: {} });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, NOT_SENDING);
  assert.equal(data.configured, false);
  assert.match(data.error, /not configured/);
  assert.match(data.error, /https:\/\/ourowncause\.com\/edition\/feed\.xml/);
  const page = await sub({ email: "reader@example.org" }, { env: {}, form: true });
  assert.equal(page.status, 503);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.deepEqual(seen, []);
  assert.equal(newsletter({}), null);
  assert.equal(newsletter({ BUTTONDOWN_API_KEY: "  " }), null);
});

test("a subscription goes to Buttondown as unconfirmed, so its owner must confirm it, and we store no address", async (t) => {
  const seen = buttondown(t, () => reply({ id: "sub_1" }, 201));
  const db = fakeD1("main");
  const res = await sub({ email: "Reader@Example.org" }, { db, form: true });
  assert.equal(res.status, 202);
  assert.match(await res.text(), /confirmation link is on its way/);
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.equal(call.url, "https://api.buttondown.com/v1/subscribers");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Token bd-test-key");
  assert.equal(call.headers["x-buttondown-collision-behavior"], "add");
  assert.deepEqual(call.body, { email_address: "reader@example.org", type: "unactivated", referrer_url: "https://ourowncause.com/edition/subscribe" });
  // only the salted daily counters are stored, never the address
  const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM ratelimit").all());
  assert.ok(!stored.includes("reader@example.org") && !stored.includes("203.0.113.5"));
});

test("an address already on the list gets the same answer; a Buttondown outage is a 503", async (t) => {
  let status = 400;
  buttondown(t, () => (status === 0 ? Promise.reject(new Error("down")) : reply({ detail: "exists" }, status)));
  const same = await sub({ email: "reader@example.org" });
  assert.equal(same.status, 202);
  assert.deepEqual(Object.keys(await same.json()).sort(), ["message", "notice"]);
  status = 500;
  assert.equal((await sub({ email: "reader@example.org" })).status, 503);
  status = 0;
  assert.equal((await sub({ email: "reader@example.org" })).status, 503);
});

test("bad input and the daily limit per address", async (t) => {
  buttondown(t, () => reply({}, 201));
  const db = fakeD1("main");
  assert.equal((await sub({ email: "nope" }, { db })).status, 400);
  assert.equal((await sub({ email: `${"x".repeat(3000)}@example.org` }, { db })).status, 400);
  const plain = await subscribe(fakeContext({ url: `${URL_BASE}/subscribe`, method: "POST", headers: { "content-type": "text/plain" }, body: "x", env: { ...KEY } }));
  assert.equal(plain.status, 415);
  assert.equal((await subscribe(fakeContext({ url: `${URL_BASE}/subscribe`, env: { ...KEY } }))).status, 405);
  for (let i = 0; i < 5; i++) assert.equal((await sub({ email: `r${i}@example.org` }, { db, ip: "198.51.100.1" })).status, 202);
  assert.equal((await sub({ email: "r9@example.org" }, { db, ip: "198.51.100.1" })).status, 429);
});

const EDITION = { number: 3, slug: "0003", date: "2026-11-23", subject: "Our Own Cause, issue 3: A title",
  text: "The edition text.\n", html: "<p>The edition.</p>\n", markdown: "The edition, in **markdown**.\n",
  html_url: "https://ourowncause.com/edition/0003.html", withheld: null };
const EDITION_FILES = {
  "/edition/index.json": { editions: [{ number: 3, date: "2026-11-23", withheld: null, json_url: "https://ourowncause.com/edition/0003.json" }] },
  "/edition/0003.json": EDITION,
};

function sendCall({ env = {}, auth = "Bearer s3cret", files = EDITION_FILES } = {}) {
  return send(fakeContext({ url: `${URL_BASE}/send`, method: "POST", headers: { authorization: auth },
    env: { ASSETS: fakeAssets(files), EDITION_SEND_TOKEN: "s3cret", ...KEY, ...env } }));
}

test("send: the newest edition goes to Buttondown once, in markdown, under a fixed slug, and a repeat sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T15:00:00Z") });
  const made = [];
  const seen = buttondown(t, (call) => {
    if (call.method === "GET") return reply({ results: made, count: made.length });
    const email = { id: "em_1", slug: call.body.slug, status: "about_to_send", absolute_url: "https://buttondown.com/ourowncause/archive/x/" };
    made.push(email);
    return reply(email, 201);
  });
  assert.equal((await sendCall({ auth: "Bearer wrong" })).status, 401);
  assert.equal((await sendCall({ auth: "" })).status, 401);
  const res = await sendCall();
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual([data.number, data.state, data.archive_url], [3, "sent", "https://buttondown.com/ourowncause/archive/x/"]);
  const [find, create] = seen;
  assert.equal(find.url, `https://api.buttondown.com/v1/emails?${new URLSearchParams({ subject: EDITION.subject })}`);
  assert.equal(create.url, "https://api.buttondown.com/v1/emails");
  assert.equal(create.headers.authorization, "Token bd-test-key");
  assert.deepEqual(create.body, { subject: EDITION.subject, body: EDITION.markdown, slug: "ourowncause-edition-0003", secondary_id: 3,
    canonical_url: EDITION.html_url, status: "about_to_send", metadata: { ourowncause_edition: "3" } });
  const again = await (await sendCall()).json();
  assert.equal(again.state, "already_sent");
  assert.equal(seen.filter((c) => c.method === "POST").length, 1, "the edition was handed over once");
  assert.equal(emailSlug({ number: 12 }), "ourowncause-edition-0012");
});

test("send reports not configured without its keys, sends nothing stale, and reports what Buttondown refused", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T15:00:00Z") });
  let refuse = false;
  buttondown(t, (call) => (call.method === "GET" ? reply({ results: [] })
    : refuse ? reply({ detail: "Your newsletter is not yet verified." }, 400) : reply({}, 201)));
  const noKey = await sendCall({ env: { BUTTONDOWN_API_KEY: "" } });
  assert.equal(noKey.status, 503);
  assert.equal((await noKey.json()).error, NOT_CONFIGURED);
  assert.equal((await sendCall({ env: { EDITION_SEND_TOKEN: "" } })).status, 503);
  const none = await (await sendCall({ files: { "/edition/index.json": { editions: [] } } })).json();
  assert.equal(none.state, "nothing_to_send");
  const old = { "/edition/index.json": { editions: [{ number: 2, date: "2026-11-01", withheld: null, json_url: "https://ourowncause.com/edition/0002.json" }] } };
  assert.equal((await (await sendCall({ files: old })).json()).state, "too_old");
  refuse = true;
  const refused = await sendCall();
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /not yet verified/);
});

test("the timer asks for a send every 5 minutes from 15:00 to 15:55 UTC, and at no other time", async () => {
  const { editionDue } = await import("../ops/timer/worker.js");
  const at = (h, m) => editionDue(new Date(Date.UTC(2026, 10, 24, h, m)));
  assert.equal([0, 5, 30, 55].every((m) => at(15, m)), true);
  assert.equal(at(15, 3) || at(14, 55) || at(16, 0), false);
});

test("every 503 from the edition routes says when to try again", async (t) => {
  buttondown(t, () => reply({}, 500));
  for (const res of [await sub({ email: "a@example.org" }, { env: {} }), await sub({ email: "a@example.org" }, { env: {}, form: true }),
    await sub({ email: "a@example.org" }), await sendCall({ env: { BUTTONDOWN_API_KEY: "" } }), await sendCall({ env: { EDITION_SEND_TOKEN: "" } })]) {
    assert.equal(res.status, 503);
    assert.match(res.headers.get("retry-after"), /^\d+$/);
  }
});
