// GET /api/digest[?day=YYYY-MM-DD | ?since=<ISO 8601 time>][&question=<q-NNN>][&format=md]: what
// changed, in a shape whose size does not grow with volume. With no `day` or `since`, the newest
// complete UTC day. functions/_lib/digest.js computes it; docs/push-channel.md says why it has
// this shape and these cadences.
//
// The answer depends only on the build and the query, so it carries an ETag and a repeated
// request between builds is answered 304.
import { computeDigest, digestMarkdown } from "../_lib/digest.js";
import { error, methodNotAllowed, NOTICE, unavailable, withReadCors } from "../_lib/notice.js";
import { sha256 } from "../_lib/ratelimit.js";
import { BASE_URL, loadIndex, loadRecord } from "../_lib/site.js";

export const MAX_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const QUESTION = /^q-\d{1,6}$/;
const NOTE = "A finished day's edition does not change once our record has it (`complete`). For a cadence "
  + "faster than daily, `since` gives the same shape for the period from that time to `as_of`, the time of "
  + "our last build; `as_of` can be the next `since`. Polling more often than we build returns the same "
  + "answer, and the ETag makes a repeat cost a 304.";
const BAD_DAY = '"day" must be a date such as 2026-11-24 (UTC), before today; for the current day use "since"';
const BAD_SINCE = `"since" must be an ISO 8601 time with its offset, such as 2026-11-24T10:00:00Z, at most ${MAX_WINDOW_DAYS} days back`;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const midnight = (text) => Date.parse(`${text}T00:00:00Z`);

function parseSince(raw) {
  const text = raw.trim().replace(/ (\d{2}:\d{2})$/, "+$1");
  if (!ISO.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// The time of our last build, to the second, from active.json; null when it cannot be read.
async function builtAt(context) {
  try {
    const response = await context.env.ASSETS.fetch(new URL("/active.json", context.request.url));
    if (!response.ok) return null;
    const value = (await response.json()).built_at;
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

export const digestUrl = (params) => `${BASE_URL}/api/digest?${new URLSearchParams(params)}`;

async function respond(context, body, contentType, maxAge) {
  const etag = `"${(await sha256(body)).slice(0, 32)}"`;
  const headers = {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "cache-control": `public, max-age=${maxAge}`,
    etag,
  };
  const match = context.request.headers.get("if-none-match");
  if (match && match.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(context.request.method === "HEAD" ? null : body, { status: 200, headers });
}

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const params = new URL(context.request.url).searchParams;
  const now = Date.now();
  const today = dayOf(now);

  const rawDay = params.get("day");
  const rawSince = params.get("since");
  if (rawDay !== null && rawSince !== null) return error(400, 'give "day" or "since", not both');
  const question = params.get("question");
  if (question !== null && !QUESTION.test(question)) return error(400, '"question" must be a bare question id such as q-004');
  const format = params.get("format") ?? "json";
  if (format !== "json" && format !== "md") return error(400, '"format" must be json or md');

  let index;
  let record;
  let built;
  try {
    [index, record, built] = await Promise.all([loadIndex(context), loadRecord(context), builtAt(context)]);
  } catch {
    return unavailable("our index is unavailable right now; try again later");
  }
  if (question !== null && !record.questions.some((q) => q.id === question)) {
    return error(400, `no question has the id ${question}: the ids are listed at ${BASE_URL}/questions/index.json`);
  }
  const asOf = built ?? now;
  const keep = question !== null ? { question } : {};

  let start;
  let end;
  let edition;
  if (rawSince !== null) {
    start = parseSince(rawSince);
    if (start === null || start < now - MAX_WINDOW_DAYS * DAY_MS) return error(400, BAD_SINCE);
    end = Math.max(asOf, start);
    edition = { edition: "window" };
  } else {
    const text = rawDay ?? dayOf(now - DAY_MS);
    if (!DAY.test(text) || Number.isNaN(midnight(text)) || dayOf(midnight(text)) !== text || text >= today) {
      return error(400, BAD_DAY);
    }
    start = midnight(text);
    end = start + DAY_MS;
    const before = dayOf(start - DAY_MS);
    const after = dayOf(end);
    edition = {
      edition: "daily",
      day: text,
      complete: asOf >= end,
      previous: digestUrl({ day: before, ...keep }),
      ...(after < today ? { next: digestUrl({ day: after, ...keep }) } : {}),
    };
  }

  const data = computeDigest({ index, record, start, end, question });
  const period = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const heading = `Our Own Cause digest: ${edition.edition === "daily" ? `${edition.day} (UTC)` : `since ${period.start}`}`
    + (question !== null ? `, ${question}` : "");
  const full = {
    ...edition,
    period,
    ...keep,
    as_of: new Date(asOf).toISOString(),
    built_at: record.builtAt,
    ...data,
    note: NOTE,
  };
  // A finished, complete day is cached for an hour; anything that can still change, for a minute.
  const maxAge = edition.edition === "daily" && edition.complete ? 3600 : 60;
  if (format === "md") {
    return respond(context, digestMarkdown({ ...full, heading }), "text/markdown; charset=utf-8", maxAge);
  }
  return respond(context, JSON.stringify({ ...full, notice: NOTICE }), "application/json; charset=utf-8", maxAge);
}

export const onRequest = withReadCors(handle, "GET, HEAD");
