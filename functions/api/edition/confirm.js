// GET /api/edition/confirm?token=...: the link in a confirmation email. Confirms the address
// for the human edition, once, within PENDING_DAYS of the request.
import { page, PENDING_DAYS, TOKEN, tokenHash } from "../../_lib/edition.js";
import { methodNotAllowed } from "../../_lib/notice.js";

const DAY_MS = 86_400_000;
const INVALID = ["This link is not valid, or it has expired. A confirmation link works once, within "
  + `${PENDING_DAYS} days. You can ask again at https://ourowncause.com/edition/subscribe.`];

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  const t = new URL(request.url).searchParams.get("token") ?? "";
  if (!TOKEN.test(t) || !env.DB) return page(404, "Link not valid", INVALID);
  try {
    const now = Date.now();
    const hash = await tokenHash(t);
    const row = await env.DB.prepare("SELECT email FROM edition_subscribers WHERE confirm_hash = ? AND state = 'pending' AND confirm_sent_at > ?")
      .bind(hash, now - PENDING_DAYS * DAY_MS).first();
    if (!row) return page(404, "Link not valid", INVALID);
    await env.DB.prepare("UPDATE edition_subscribers SET state = 'confirmed', confirmed_at = ?, confirm_hash = NULL WHERE email = ?")
      .bind(now, row.email).run();
  } catch {
    return page(503, "Not available", ["Confirming is unavailable right now; the link will work again later."]);
  }
  return page(200, "Confirmed", [
    "This address will receive the weekly edition of Our Own Cause, in weeks when our editors publish an issue.",
    "Every email has a link to stop it.",
  ]);
}
