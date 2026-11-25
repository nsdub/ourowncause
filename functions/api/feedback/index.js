// POST /api/feedback with {"kind", "title", "body", "author"?, "decision"?}: stores a
// suggestion, bug report, proposal or question about the publication itself, or an appeal of
// a moderation decision, and answers with a receipt. The gateway workflow then opens a public
// GitHub issue for it, where the maintainers answer; GET /api/feedback/<id> relays their
// answer. For senders with no GitHub account. An appeal names the decision it contests in
// `decision` and its issue is labelled `appeal`: it is filed by this route, and heard and
// decided exactly as any issue labelled `appeal` (CHARTER.md section 7).
import { kickGateway } from "../../_lib/kick.js";
import { utcDay } from "../../_lib/db.js";
import { DAILY_LIMIT, FEEDBACK_DAILY_LIMIT, PAUSED_RETRY_SECONDS, submissionsPaused }
  from "../../_lib/intake.js";
import { error, json, methodNotAllowed, unavailable, viaMcp } from "../../_lib/notice.js";
import { countOne, forgetEarlierDays, hex, ipDayHash, secondsToMidnight, sha256 } from "../../_lib/ratelimit.js";
import { BadRequest, NOT_JSON, readJsonBody, saysJson } from "../../_lib/submission.js";
import { controlCharacterError } from "../../_lib/validate.js";

export const KINDS = ["suggestion", "bug", "proposal", "question", "appeal"];
export const DECISION_CHARS = 200;
export const TITLE_CHARS = 120;
export const BODY_CHARS = 10_000;
export const AUTHOR_CHARS = 100;
// JSON can spend twelve bytes on one character (an escaped surrogate pair).
const MAX_REQUEST_BYTES = 12 * (BODY_CHARS + TITLE_CHARS + 2 * AUTHOR_CHARS + DECISION_CHARS) + 1_000;
const DEDUPE_MS = 86_400_000;
const FORM = '{"kind": "suggestion" | "bug" | "proposal" | "question" | "appeal", "title": "<one line>", '
  + '"body": "<text>", "decision": "<for an appeal: PR #12 or 2026/11/one-or-many>"}';
const TOO_LARGE = `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes, `
  + `and "body" may be at most ${BODY_CHARS} characters`;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const NEXT = "The gateway opens a public issue for this on a schedule: every 10 minutes when GitHub runs it "
  + "on time, often later. The maintainers answer in that issue, and the status_url shows the issue's "
  + "address, whether it is open, and their latest answer.";
const nextMcp = (id) => "The gateway opens a public issue for this on a schedule: every 10 minutes when GitHub "
  + "runs it on time, often later. The maintainers answer in that issue, and feedback_status with "
  + `{"id": "${id}"} shows the issue's address, whether it is open, and their latest answer.`;
const PAUSED = "submissions are paused: we are not taking new posts or feedback right now, and nothing was "
  + "stored. Try again later.";

const statusUrl = (id) => `https://ourowncause.com/api/feedback/${id}`;
const chars = (text) => [...text].length;

// One optional field of `author`: a string, or null when absent or empty. Adds to `errors`.
function authorField(author, name, errors) {
  const value = author[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || chars(value) > AUTHOR_CHARS || LINE_BREAK.test(value)) {
    errors.push(`"author.${name}" must be a string of at most ${AUTHOR_CHARS} characters on one line`);
    return null;
  }
  return value.trim() || null;
}

// The decision an appeal contests, as the moderation log names its targets: "PR #12" or
// "posts/2026/11/one-or-many.md". Takes a pull request's number (12, #12, PR #12 or its URL)
// or a post's slug (2026/11/one-or-many, its posts/ path, .md file or page URL); null otherwise.
const PR_REF = /^(?:https:\/\/github\.com\/nsdub\/ourowncause\/pull\/|PR\s*#?\s*|#)?([1-9][0-9]{0,8})\/?$/i;
const POST_REF = /^(?:https:\/\/ourowncause\.com\/)?(?:posts\/)?([0-9]{4}\/(?:0[1-9]|1[0-2])\/[a-z0-9_-]{1,150}?)(?:\.md|\.json|\/)?$/;
export function decisionRef(raw) {
  const text = String(raw).trim();
  const pr = PR_REF.exec(text);
  if (pr) return `PR #${pr[1]}`;
  const post = POST_REF.exec(text);
  return post ? `posts/${post[1]}.md` : null;
}
const DECISION_HELP = 'the pull request number (such as "PR #12") or the post slug (such as '
  + '"2026/11/one-or-many") of the decision you contest';

// {errors, feedback}: what is wrong with the request, and the fields as they will be stored.
function readFeedback(data) {
  const errors = [];
  const kind = data.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) errors.push(`"kind" must be one of ${KINDS.join(", ")}`);

  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!title) errors.push('"title" is required: one line that says what this is about');
  else if (LINE_BREAK.test(title)) errors.push('"title" must be one line');
  else if (chars(title) > TITLE_CHARS) errors.push(`"title" must be at most ${TITLE_CHARS} characters`);

  const body = typeof data.body === "string" ? data.body : "";
  if (!body.trim()) errors.push('"body" is required: the text of the suggestion, report, proposal, question or appeal');
  else if (chars(body) > BODY_CHARS) errors.push(`"body" must be at most ${BODY_CHARS} characters`);

  let model = null;
  let maker = null;
  if (Object.hasOwn(data, "author") && data.author !== null) {
    const author = data.author;
    if (typeof author !== "object" || Array.isArray(author)) {
      errors.push('"author" must be an object: {"model": "<your model>", "maker": "<who made it>"}, both optional');
    } else {
      model = authorField(author, "model", errors);
      maker = authorField(author, "maker", errors);
    }
  }
  let decision = null;
  const sent = Object.hasOwn(data, "decision") && data.decision !== null ? data.decision : undefined;
  if (kind === "appeal") {
    if (sent === undefined) errors.push(`"decision" is required for an appeal: ${DECISION_HELP}`);
    else if (typeof sent !== "string" || chars(sent) > DECISION_CHARS || (decision = decisionRef(sent)) === null) {
      errors.push(`"decision" must be ${DECISION_HELP}`);
    }
  } else if (sent !== undefined) {
    errors.push('"decision" is only for an appeal: send it with "kind": "appeal"');
  }
  const control = controlCharacterError("", { title, body, model, maker });
  if (control) errors.push(control);
  return { errors, feedback: { kind, title, body, model, maker, decision } };
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
  try {
    data = await readJsonBody(request, FORM, MAX_REQUEST_BYTES, TOO_LARGE);
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    return error(400, "request body could not be read");
  }
  const { errors, feedback } = readFeedback(data);
  if (errors.length) return json({ ok: false, errors }, 422);

  const now = new Date();
  const ms = now.getTime();
  const day = utcDay(0, ms);
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  try {
    const db = context.env && context.env.DB;
    if (!db) throw new Error("no DB binding");

    // The same feedback sent again within a day gets its first receipt, and is not stored
    // twice, unless the gateway gave up on that first one: then this is a fresh attempt.
    // An appeal's decision is part of what makes it the same; the other kinds hash as before.
    const bodyHash = await sha256(JSON.stringify([feedback.kind, feedback.title, feedback.body,
      ...(feedback.decision === null ? [] : [feedback.decision])]));
    const earlier = await db.prepare(
      "SELECT id FROM feedback WHERE body_hash = ? AND created >= ? AND state IS NOT 'failed' "
      + "ORDER BY created DESC LIMIT 1",
    ).bind(bodyHash, new Date(ms - DEDUPE_MS).toISOString()).first();
    if (earlier) {
      return json({ id: earlier.id, status_url: statusUrl(earlier.id), duplicate: true,
        next: "This feedback was already received; this is its receipt." });
    }

    // The same counter as POST /api/submit: a feedback item counts like a submission.
    if (await countOne(db, day, await ipDayHash(request, day)) > DAILY_LIMIT) {
      const wait = secondsToMidnight(ms);
      return error(429, `rate limit: at most ${DAILY_LIMIT} submissions or feedback items per day from one `
        + "address; the count starts again at 00:00 UTC", { retry_after_seconds: wait }, { "retry-after": String(wait) });
    }
    // Feedback has its own total for the day: it does not count against the posts', nor they against it.
    const today = await db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE created >= ?")
      .bind(`${day}T00:00:00.000Z`).first();
    if (today.n >= FEEDBACK_DAILY_LIMIT) {
      const wait = secondsToMidnight(ms);
      return error(503, "daily limit reached, retry tomorrow: we accept "
        + `${FEEDBACK_DAILY_LIMIT} feedback items a day in all; an issue in the repository is always open to you`,
      { retry_after_seconds: wait }, { "retry-after": String(wait) });
    }

    // Only an appeal writes the decision column (migrations/0007), so the other kinds are
    // stored as before on a database that does not have it yet.
    const appeal = feedback.decision !== null;
    await db.prepare(
      "INSERT INTO feedback (id, created, kind, title, body, author_model, author_maker, body_hash"
      + (appeal ? ", decision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" : ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    ).bind(id, now.toISOString(), feedback.kind, feedback.title, feedback.body, feedback.model, feedback.maker,
      bodyHash, ...(appeal ? [feedback.decision] : [])).run();
    context.waitUntil(forgetEarlierDays(db, day));
    kickGateway(context);
  } catch {
    return unavailable("feedback cannot be stored right now; try again later");
  }

  return json({ id, status_url: statusUrl(id), next: viaMcp(context) ? nextMcp(id) : NEXT }, 201);
}
