// POST /api/edition/send with "Authorization: Bearer <EDITION_SEND_TOKEN>": hands the newest
// edition to Buttondown, which sends it to every confirmed subscriber. The edition is the one
// the build wrote from the editors' committed issue. Each edition is sent once: its email has a
// fixed slug in Buttondown, and a call that finds it already made sends nothing more. An
// edition more than 7 days old is not sent. The timer calls this (ops/timer). Until the Pages
// secret BUTTONDOWN_API_KEY is set, it answers 503 "not configured" and sends nothing.
//
// The answer gives the address of the edition's page in Buttondown's public archive, which,
// with the committed issue and edition, is the public record that it was sent.
import { sameSecret } from "../../_lib/edition.js";
import { newsletter, NOT_CONFIGURED } from "../../_lib/newsletter.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

export const MAX_AGE_DAYS = 7;
// A setting that is missing stays missing until the host sets it: an hour is the soonest retry.
const LATER = 3600;
const DAY_MS = 86_400_000;

async function asset(context, path) {
  const response = await context.env.ASSETS.fetch(new URL(path, context.request.url));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!env.EDITION_SEND_TOKEN) {
    return error(503, "not configured: EDITION_SEND_TOKEN is not set", { configured: false, retry_after_seconds: LATER }, { "retry-after": String(LATER) });
  }
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await sameSecret(given, env.EDITION_SEND_TOKEN))) return error(401, "not authorized");
  const service = newsletter(env);
  if (!service) return error(503, NOT_CONFIGURED, { configured: false, retry_after_seconds: LATER }, { "retry-after": String(LATER) });

  let edition;
  try {
    const list = await asset(context, "/edition/index.json");
    const newest = (Array.isArray(list.editions) ? list.editions : []).find((e) => !e.withheld && e.json_url);
    if (!newest) return json({ state: "nothing_to_send", note: "there is no edition to send" });
    if (!newest.date || Date.parse(`${newest.date}T00:00:00Z`) < Date.now() - MAX_AGE_DAYS * DAY_MS) {
      return json({ number: newest.number, state: "too_old", note: `the newest edition is more than ${MAX_AGE_DAYS} days old; nothing was sent` });
    }
    edition = await asset(context, new URL(newest.json_url).pathname);
  } catch {
    return unavailable("the edition files are unavailable right now; try again later");
  }
  if (!Number.isInteger(edition.number) || edition.number < 1 || typeof edition.markdown !== "string") {
    return unavailable("the newest edition is incomplete; nothing was sent");
  }
  try {
    const existing = await service.findEdition(edition);
    if (existing) {
      return json({ number: edition.number, state: "already_sent", buttondown_status: existing.status ?? null,
        archive_url: existing.absolute_url ?? null });
    }
    const sent = await service.sendEdition(edition);
    if (!sent.ok) return error(502, `Buttondown did not take the edition: ${sent.error}`, { number: edition.number });
    return json({ number: edition.number, state: "sent", buttondown_status: sent.status, archive_url: sent.url });
  } catch {
    return unavailable("Buttondown could not be reached; nothing was sent, and the next call tries again");
  }
}
