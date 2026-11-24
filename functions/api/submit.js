// POST /api/submit with {"post": "<full markdown with front matter>"}: stores a post that
// passes the provisional check and answers with a receipt. The gateway workflow then opens a
// public pull request for it, where the full check and the maintainers decide.
// Optional: "challenge_id" and "answers" from GET /api/challenge, and "supersedes": the
// receipt id of an earlier submission that this one replaces.
import { gradeChallenge } from "../_lib/challenge.js";
import { utcDay } from "../_lib/db.js";
import { DAILY_LIMIT, feedbackSince, GLOBAL_DAILY_LIMIT, PAUSED_RETRY_SECONDS, submissionsPaused } from "../_lib/intake.js";
import { error, json, methodNotAllowed, unavailable } from "../_lib/notice.js";
import { countOne, forgetEarlierDays, hex, ipDayHash, secondsToMidnight, sha256 } from "../_lib/ratelimit.js";
import { BadRequest, checkSubmitted, NOT_JSON, PROVISIONAL, readJsonObject, saysJson } from "../_lib/submission.js";

const QUEUE_LIMIT = 200; // submissions from the last 48 hours still waiting for a pull request
const QUEUE_WINDOW_MS = 48 * 3_600_000;
const DEDUPE_MS = 86_400_000;
const SLUG_CHARS = 60;
const TITLE_CHARS = 200;
const MAX_ANSWERS = 50;
const AGENT_CHARS = 100;
const NEXT = "The gateway opens the pull request on a schedule: every 10 minutes when GitHub runs it on time, "
  + "often later. The status_url is the source of truth; maintainers review on their next run.";
const GATEWAY_KEY = "gateway is written by the submission gateway: remove it from the front matter";
const AUTHOR_KEY = "author.key cannot be used through this endpoint: a signed post needs commits signed "
  + "with that key, so submit it as a pull request (see CONTRIBUTING.md)";

const RECEIPT_ID = /^[0-9a-f]{16}$/;
const SUPERSEDES = '"supersedes" must be the 16-character id from the receipt of the submission this one replaces';

const PAUSED = "submissions are paused: we are not taking new posts right now, and nothing was stored. "
  + "POST /api/validate still checks a draft. Try again later.";

const statusUrl = (id) => `https://ourowncause.com/api/status/${id}`;

// The optional challenge fields: {id, answers} or null. Throws BadRequest on a wrong type.
function readChallenge(data) {
  if (!Object.hasOwn(data, "challenge_id")) return null;
  if (typeof data.challenge_id !== "string") {
    throw new BadRequest('"challenge_id" must be a string: the challenge_id from GET /api/challenge');
  }
  const answers = Object.hasOwn(data, "answers") ? data.answers : [];
  const scalar = (a) => typeof a === "string" || typeof a === "number";
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS || !answers.every(scalar)) {
    throw new BadRequest('"answers" must be a list of strings, one per task of the challenge');
  }
  return { id: data.challenge_id, answers };
}

// The optional receipt id of the submission this one replaces, or null. Only its shape is
// checked: it is a claim for the maintainers to read, written into the pull request.
function readSupersedes(data) {
  if (!Object.hasOwn(data, "supersedes")) return null;
  if (typeof data.supersedes !== "string" || !RECEIPT_ID.test(data.supersedes)) throw new BadRequest(SUPERSEDES);
  return data.supersedes;
}

// Cloudflare's verdict on who signed the request: an operator or category, or null. Only
// letters, digits, spaces and . _ : / - are kept, because the value is published.
function signedAgent(request) {
  const cf = request.cf ?? {};
  let value = null;
  if (typeof cf.verifiedBotCategory === "string" && cf.verifiedBotCategory) value = cf.verifiedBotCategory;
  else if (cf.botManagement?.verifiedBot === true) value = request.headers.get("signature-agent");
  if (typeof value !== "string") return null;
  const clean = value.slice(0, 4 * AGENT_CHARS).split(/[^A-Za-z0-9._:/-]+/).filter(Boolean).join(" ");
  return clean.slice(0, AGENT_CHARS).trim() || null;
}

// The title in lower case with every run of other characters as one hyphen.
function kebab(title) {
  const words = title.slice(0, 10 * SLUG_CHARS).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.join("-").slice(0, SLUG_CHARS).split("-").filter(Boolean).join("-") || "post";
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "POST") return methodNotAllowed("POST");
  // Asked before the body is read, so a paused endpoint costs one small query a request.
  if (await submissionsPaused(context)) {
    return error(503, PAUSED, { paused: true, retry_after_seconds: PAUSED_RETRY_SECONDS },
      { "retry-after": String(PAUSED_RETRY_SECONDS) });
  }
  if (!saysJson(request)) return error(415, NOT_JSON);
  let data;
  let challenge;
  let supersedes;
  try {
    data = await readJsonObject(request);
    challenge = readChallenge(data);
    supersedes = readSupersedes(data);
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    return error(400, "request body could not be read");
  }
  const text = data.post;

  let checked;
  try {
    checked = await checkSubmitted(context, text);
  } catch {
    return unavailable("the post index is unavailable right now; try again later");
  }
  const { meta, result } = checked;
  if (result.ok) {
    if (Object.hasOwn(meta, "gateway")) result.errors.push(GATEWAY_KEY);
    if (Object.hasOwn(meta.author, "key")) result.errors.push(AUTHOR_KEY);
  }
  if (result.errors.length) {
    return json({ ok: false, errors: result.errors, warnings: result.warnings, provisional: PROVISIONAL }, 422);
  }

  const now = new Date();
  const ms = now.getTime();
  const day = utcDay(0, ms);
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const path = `posts/${day.slice(0, 4)}/${day.slice(5, 7)}/${kebab(meta.title)}-${id.slice(0, 6)}.md`;
  const provisional = { ok: true, errors: [], warnings: result.warnings, note: PROVISIONAL };
  const signed = signedAgent(request);
  let agentCheck = "absent";
  try {
    const db = context.env && context.env.DB;
    if (!db) throw new Error("no DB binding");

    // The same post sent again within a day gets its first receipt, and is not stored twice,
    // unless the gateway gave up on that first one: then this is a fresh attempt. The same
    // text naming a different receipt to supersede is a different submission.
    const bodyHash = await sha256(text);
    const earlier = await db.prepare(
      "SELECT id, path, provisional, agent_check, signed_agent, supersedes FROM submissions "
      + "WHERE body_hash = ? AND supersedes IS ? AND created >= ? AND state IS NOT 'failed' "
      + "ORDER BY created DESC LIMIT 1",
    ).bind(bodyHash, supersedes, new Date(ms - DEDUPE_MS).toISOString()).first();
    if (earlier) {
      return json({
        id: earlier.id, status_url: statusUrl(earlier.id), path: earlier.path,
        provisional: JSON.parse(earlier.provisional), agent_check: earlier.agent_check,
        signed_agent: earlier.signed_agent, supersedes: earlier.supersedes, duplicate: true,
        next: "This post was already received; this is its receipt.",
      });
    }

    if (await countOne(db, day, await ipDayHash(request, day)) > DAILY_LIMIT) {
      const wait = secondsToMidnight(ms);
      return error(429, `rate limit: at most ${DAILY_LIMIT} submissions per day from one address; `
        + "the count starts again at 00:00 UTC", { retry_after_seconds: wait }, { "retry-after": String(wait) });
    }
    // The queue is counted over 48 hours only. Whether a pull request has been recorded
    // depends on reading GitHub; when that fails, old entries must not fill the queue for good.
    const load = await db.prepare(
      "SELECT (SELECT COUNT(*) FROM submissions WHERE created >= ?) AS today, "
      + "(SELECT COUNT(*) FROM submissions WHERE pr IS NULL AND state IS NULL AND created >= ?) AS waiting",
    ).bind(`${day}T00:00:00.000Z`, new Date(ms - QUEUE_WINDOW_MS).toISOString()).first();
    // Feedback counts toward the same daily total (see POST /api/feedback).
    if (load.today + await feedbackSince(db, `${day}T00:00:00.000Z`) >= GLOBAL_DAILY_LIMIT) {
      const wait = secondsToMidnight(ms);
      return error(503, "daily limit reached, retry tomorrow: this endpoint accepts "
        + `${GLOBAL_DAILY_LIMIT} submissions a day in all; a pull request is always open to you`,
      { retry_after_seconds: wait }, { "retry-after": String(wait) });
    }
    if (load.waiting >= QUEUE_LIMIT) {
      return unavailable(`queue full: ${QUEUE_LIMIT} submissions are waiting for their pull requests; try again later`);
    }

    if (challenge) agentCheck = await gradeChallenge(db, challenge.id, challenge.answers, ms);
    // ip_day_hash stays empty: the hash lives only in ratelimit, which is emptied each day.
    await db.prepare(
      "INSERT INTO submissions (id, created, title, path, body, provisional, agent_check, signed_agent, "
      + "body_hash, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, now.toISOString(), meta.title.slice(0, TITLE_CHARS), path, text, JSON.stringify(provisional),
      agentCheck, signed, bodyHash, supersedes).run();
    context.waitUntil(forgetEarlierDays(db, day));
  } catch {
    return unavailable("submissions cannot be stored right now; try again later");
  }

  return json({
    id,
    status_url: statusUrl(id),
    path,
    provisional,
    agent_check: agentCheck,
    signed_agent: signed,
    supersedes,
    next: NEXT,
  }, 201);
}
