// POST /api/edition/subscribe with an email address, as a form (email=...) from
// /edition/subscribe or as JSON {"email": "..."}: asks for the human edition by email. Double
// opt-in: the address gets one confirmation link and nothing else until it is followed, so no
// one, person or agent, can subscribe an address its owner does not confirm. The answer is the
// same whether or not the address was already on our list. Until the host sets MAIL_PROVIDER,
// this answers 503 and stores nothing (docs/push-channel.md).
import { utcDay } from "../../_lib/db.js";
import { cleanEmail, confirmationEmail, NOT_SENDING, page, PENDING_DAYS, RESEND_MS, token, tokenHash } from "../../_lib/edition.js";
import { submissionsPaused } from "../../_lib/intake.js";
import { mailer } from "../../_lib/mail.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";
import { countOne, ipDayHash, secondsToMidnight } from "../../_lib/ratelimit.js";

export const PER_ADDRESS_DAILY = 5;
export const TOTAL_DAILY = 500;
const MAX_BYTES = 2_000;
const DAY_MS = 86_400_000;
const DONE = "If this address can receive email, a confirmation link is on its way to it. Nothing else is sent "
  + `until the link is followed, and an unconfirmed address leaves our list within ${PENDING_DAYS} days.`;

async function readEmail(request) {
  const type = request.headers.get("content-type") ?? "";
  if (Number(request.headers.get("content-length")) > MAX_BYTES) return { tooLarge: true };
  const text = await request.text();
  if (text.length > MAX_BYTES) return { tooLarge: true };
  if (/^application\/json\s*(?:;|$)/i.test(type)) {
    try {
      const data = JSON.parse(text);
      return { asJson: true, email: data && typeof data === "object" ? data.email : undefined };
    } catch {
      return { asJson: true, email: undefined };
    }
  }
  if (/^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(type)) return { asJson: false, email: new URLSearchParams(text).get("email") };
  return { asJson: true, unsupported: true };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const input = await readEmail(request);
  const answer = (status, title, message, extra = {}, headers = {}) => (input.asJson
    ? (status >= 400 ? error(status, message, extra, headers) : json({ ...extra, message }, status, headers))
    : page(status, title, [message]));
  if (input.unsupported) return error(415, 'send a form (email=...) or JSON {"email": "<address>"}');
  if (input.tooLarge) return answer(400, "Not sent", "the request is too large: send one email address");
  const email = cleanEmail(input.email);
  if (!email) return answer(400, "Not an address", "that does not look like an email address; nothing was stored");

  const mail = mailer(env);
  if (!mail || !env.DB) return answer(503, "Not sending yet", NOT_SENDING, { sending: false });
  if (await submissionsPaused(context)) return answer(503, "Paused", "we are not taking new requests right now; nothing was stored");

  const db = env.DB;
  const now = Date.now();
  try {
    const day = utcDay();
    if (await countOne(db, day, `edition:${await ipDayHash(request, day)}`) > PER_ADDRESS_DAILY) {
      const wait = secondsToMidnight();
      return answer(429, "Too many requests", `at most ${PER_ADDRESS_DAILY} subscription requests a day from one address`,
        { retry_after_seconds: wait }, { "retry-after": String(wait) });
    }
    if (await countOne(db, day, "edition:all") > TOTAL_DAILY) {
      return answer(503, "Try again tomorrow", "we have taken as many subscription requests as we take in one day");
    }
    await db.prepare("DELETE FROM edition_subscribers WHERE state = 'pending' AND created_at < ?")
      .bind(now - PENDING_DAYS * DAY_MS).run();
    const row = await db.prepare("SELECT state, confirm_sent_at FROM edition_subscribers WHERE email = ?").bind(email).first();
    if (row && (row.state === "confirmed" || Number(row.confirm_sent_at) > now - RESEND_MS)) {
      return answer(202, "Check your inbox", DONE);
    }
    const t = token();
    const hash = await tokenHash(t);
    if (row) {
      await db.prepare("UPDATE edition_subscribers SET confirm_hash = ?, confirm_sent_at = ? WHERE email = ?").bind(hash, now, email).run();
    } else {
      await db.prepare("INSERT INTO edition_subscribers (email, state, confirm_hash, confirm_sent_at, unsubscribe_token, created_at) "
        + "VALUES (?, 'pending', ?, ?, ?, ?)").bind(email, hash, now, token(), now).run();
    }
    const [sent] = await mail.send([{ to: email, ...confirmationEmail(t) }]);
    if (!sent || !sent.ok) return answer(503, "Not sent", "the confirmation email could not be sent; try again later");
  } catch {
    return input.asJson ? unavailable("subscriptions are unavailable right now; try again later")
      : page(503, "Not available", ["Subscriptions are unavailable right now; try again later."]);
  }
  return answer(202, "Check your inbox", DONE);
}
