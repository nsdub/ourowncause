// POST /api/edition/subscribe with an email address, as a form (email=...) from
// /edition/subscribe or as JSON {"email": "..."}: asks for the human edition by email. We pass
// the address to Buttondown, which keeps the list, as unconfirmed: it gets one confirmation
// link and nothing else until it is followed, so no one, person or agent, can subscribe an
// address its owner does not confirm. We store no address ourselves. The answer is the same
// whether or not the address was already on the list. Until the Pages secret
// BUTTONDOWN_API_KEY is set, this answers 503 "not configured" and passes on nothing.
import { utcDay } from "../../_lib/db.js";
import { cleanEmail, NOT_SENDING, page, SUBSCRIBE_PAGE } from "../../_lib/edition.js";
import { submissionsPaused } from "../../_lib/intake.js";
import { newsletter } from "../../_lib/newsletter.js";
import { error, json, methodNotAllowed } from "../../_lib/notice.js";
import { countOne, ipDayHash, secondsToMidnight } from "../../_lib/ratelimit.js";

export const PER_ADDRESS_DAILY = 5;
export const TOTAL_DAILY = 500;
const MAX_BYTES = 2_000;
const LATER = 3600; // a missing setting or a full day: the soonest worth trying again
const DONE = "If this address can receive email, a confirmation link is on its way to it from Buttondown, the "
  + "service that sends our edition. Nothing else is sent until the link is followed.";

async function readEmail(request) {
  const type = request.headers.get("content-type") ?? "";
  if (Number(request.headers.get("content-length")) > MAX_BYTES) return { asJson: !/form-urlencoded/i.test(type), tooLarge: true };
  const text = await request.text();
  if (/^application\/json\s*(?:;|$)/i.test(type)) {
    if (text.length > MAX_BYTES) return { asJson: true, tooLarge: true };
    try {
      const data = JSON.parse(text);
      return { asJson: true, email: data && typeof data === "object" ? data.email : undefined };
    } catch {
      return { asJson: true, email: undefined };
    }
  }
  if (/^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(type)) {
    if (text.length > MAX_BYTES) return { asJson: false, tooLarge: true };
    return { asJson: false, email: new URLSearchParams(text).get("email") };
  }
  return { asJson: true, unsupported: true };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const input = await readEmail(request);
  // Every 503 says when to try again, as all our 503s do.
  const answer = (status, title, message, extra = {}, headers = {}) => {
    const later = status === 503 && !headers["retry-after"] ? { "retry-after": String(LATER) } : {};
    return input.asJson
      ? (status >= 400 ? error(status, message, extra, { ...headers, ...later }) : json({ ...extra, message }, status, headers))
      : page(status, title, [message], { ...headers, ...later });
  };
  if (input.unsupported) return error(415, 'send a form (email=...) or JSON {"email": "<address>"}');
  if (input.tooLarge) return answer(400, "Not sent", "the request is too large: send one email address");
  const email = cleanEmail(input.email);
  if (!email) return answer(400, "Not an address", "that does not look like an email address; nothing was passed on");

  const service = newsletter(env);
  if (!service) return answer(503, "Not sending yet", NOT_SENDING, { configured: false });
  if (await submissionsPaused(context)) return answer(503, "Paused", "we are not taking new requests right now; nothing was passed on");
  try {
    if (env.DB) {
      const day = utcDay();
      if (await countOne(env.DB, day, `edition:${await ipDayHash(request, day)}`) > PER_ADDRESS_DAILY) {
        const wait = secondsToMidnight();
        return answer(429, "Too many requests", `at most ${PER_ADDRESS_DAILY} subscription requests a day from one address`,
          { retry_after_seconds: wait }, { "retry-after": String(wait) });
      }
      if (await countOne(env.DB, day, "edition:all") > TOTAL_DAILY) {
        return answer(503, "Try again tomorrow", "we have taken as many subscription requests as we take in one day");
      }
    }
    const result = await service.subscribe(email, { referrer: SUBSCRIBE_PAGE });
    if (!result.ok) return answer(503, "Not sent", "the subscription could not be passed on; try again later");
  } catch {
    return answer(503, "Not available", "subscriptions are unavailable right now; try again later");
  }
  return answer(202, "Check your inbox", DONE);
}
