// POST /api/edition/send with "Authorization: Bearer <EDITION_SEND_TOKEN>": sends the newest
// edition to every confirmed address that has not received it, in batches, and records each
// send. A repeated call resumes where the last one stopped and never sends an address the same
// edition twice; `remaining` says how many are left. The timer calls it (ops/timer). An
// edition more than 7 days old is not sent, so a new subscriber does not get a stale one.
import { editionEmail, sameSecret } from "../../_lib/edition.js";
import { BATCH_MAX, mailer } from "../../_lib/mail.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

export const BATCHES_PER_CALL = 5;
export const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

async function asset(context, path) {
  const response = await context.env.ASSETS.fetch(new URL(path, context.request.url));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.EDITION_SEND_TOKEN) return unavailable("sending is not set up: EDITION_SEND_TOKEN is not set");
  if (!(await sameSecret(given, env.EDITION_SEND_TOKEN))) return error(401, "not authorized");
  const mail = mailer(env);
  if (!mail || !env.DB) return unavailable("sending is not set up: MAIL_PROVIDER, MAIL_API_KEY and MAIL_FROM are needed");

  let edition;
  try {
    const list = await asset(context, "/edition/index.json");
    const newest = (Array.isArray(list.editions) ? list.editions : []).find((e) => !e.withheld && e.json_url);
    if (!newest) return json({ sent: 0, remaining: 0, note: "there is no edition to send" });
    if (!newest.date || Date.parse(`${newest.date}T00:00:00Z`) < Date.now() - MAX_AGE_DAYS * DAY_MS) {
      return json({ number: newest.number, sent: 0, remaining: 0, note: `the newest edition is more than ${MAX_AGE_DAYS} days old; nothing was sent` });
    }
    edition = await asset(context, new URL(newest.json_url).pathname);
  } catch {
    return unavailable("the edition files are unavailable right now; try again later");
  }
  const number = Number(edition.number);
  if (!Number.isInteger(number) || number < 1) return unavailable("the newest edition has no number");

  let sent = 0;
  let failed = 0;
  try {
    for (let batch = 0; batch < BATCHES_PER_CALL; batch++) {
      const { results } = await env.DB.prepare("SELECT email, unsubscribe_token FROM edition_subscribers "
        + "WHERE state = 'confirmed' AND last_sent_number < ? ORDER BY email LIMIT ?").bind(number, BATCH_MAX).all();
      if (!results.length) break;
      const outcome = await mail.send(results.map((r) => editionEmail(edition, r.email, r.unsubscribe_token)));
      const ok = outcome.filter((o) => o.ok).map((o) => o.to);
      failed += outcome.length - ok.length;
      for (const to of ok) {
        await env.DB.prepare("UPDATE edition_subscribers SET last_sent_number = ? WHERE email = ?").bind(number, to).run();
      }
      sent += ok.length;
      if (ok.length < results.length) break; // stop on failures; the next call retries them
    }
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM edition_subscribers WHERE state = 'confirmed' AND last_sent_number < ?")
      .bind(number).first();
    return json({ number, provider: mail.name, sent, failed, remaining: Number(left?.n ?? 0) });
  } catch {
    return unavailable(`sending stopped after ${sent} emails; the next call resumes`);
  }
}
