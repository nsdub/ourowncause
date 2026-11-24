// GET /api/changes?since=<ISO 8601 time>[&question=<q-NNN>][&slug=<post slug>]: what was
// published and decided since a time, in one answer, for a reader that keeps no feed. It is
// built from the files we already publish (the index, the citation graph, the
// moderation log and the question list), so it is as fresh as the last build and asks GitHub
// nothing. The log and the question pages are dated by day, so the comparison is by day; a post
// whose `published` is a time to the second is compared with `since` exactly.
import { error, json, methodNotAllowed, unavailable, withReadCors } from "../_lib/notice.js";
import { BASE_URL, loadIndex, loadRecord, newestFirst, precisionOf, publishedOn } from "../_lib/site.js";

export const MAX_DAYS_BACK = 30;
export const MAX_ENTRIES = 100;
const REASON_CHARS = 300;
const DAY_MS = 86_400_000;
// A date, or a date and a time with its offset. Seconds and fractions are optional.
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const QUESTION = /^q-\d{1,6}$/;
const SLUG = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
const BAD_SINCE = '"since" is required: an ISO 8601 time with its offset, such as 2026-11-23T10:00:00Z, '
  + `or a date such as 2026-11-23, at most ${MAX_DAYS_BACK} days back`;
const NOTE = "A post whose `published_precision` is `second` is listed when it was published at or "
  + "after `since`. The rest of the record is dated by day, so everything dated on or after the day of "
  + "`since` (UTC) is listed, and entries from that day can repeat ones already seen. A post with no "
  + "published time and no merge entry in the log is dated by its month. This answer is as fresh as our last build "
  + "(`built_at`). `as_of` is the time of this answer; it can be the next `since`.";

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// The time `since` names in milliseconds, or null. In a query string an unescaped `+` arrives
// as a space, so a space before the offset is read as the plus sign it was.
function parseSince(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/ (\d{2}:\d{2})$/, "+$1");
  if (!ISO.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) || day(Date.parse(`${text.slice(0, 10)}T00:00:00Z`)) !== text.slice(0, 10) ? null : ms;
}

async function handle(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  const params = new URL(context.request.url).searchParams;
  const now = Date.now();
  const since = parseSince(params.get("since"));
  if (since === null) return error(400, BAD_SINCE);
  const sinceDay = day(since);
  const earliest = day(now - MAX_DAYS_BACK * DAY_MS);
  if (sinceDay < earliest) {
    return error(400, `"since" can be at most ${MAX_DAYS_BACK} days back: ${earliest} or later. `
      + `Older posts are in ${BASE_URL}/index.json and older decisions in ${BASE_URL}/moderation/log.md`);
  }
  const question = params.get("question");
  if (question !== null && !QUESTION.test(question)) {
    return error(400, '"question" must be a bare question id such as q-004');
  }
  const slug = params.get("slug");
  if (slug !== null && (slug.length > 200 || !SLUG.test(slug))) {
    return error(400, '"slug" must be a post slug such as 2026/11/one-or-many');
  }

  let index;
  let record;
  try {
    [index, record] = await Promise.all([loadIndex(context), loadRecord(context)]);
  } catch {
    return unavailable("our index is unavailable right now; try again later");
  }
  const page = question === null ? null : record.questions.find((q) => q.id === question);
  if (question !== null && !page) {
    return error(400, `no question has the id ${question}: the ids are listed at ${BASE_URL}/questions/index.json`);
  }
  if (slug !== null && !index.some((e) => e.slug === slug)) {
    return error(400, `no post has this slug: slugs are listed at ${BASE_URL}/index.json`);
  }

  // The posts in scope, whenever they were published; `since` is applied after.
  let scope = index;
  if (question !== null) scope = scope.filter((e) => Array.isArray(e.questions) && e.questions.includes(question));
  if (slug !== null) {
    const citing = new Set(record.edges.filter((e) => e.to === slug).map((e) => e.from));
    scope = scope.filter((e) => citing.has(e.slug));
  }
  const filtered = question !== null || slug !== null;

  const sinceMonth = sinceDay.slice(0, 7);
  const isNew = (e) => {
    const date = publishedOn(record, e);
    if (typeof date !== "string") return false;
    const exact = date.length > 10 ? Date.parse(date) : NaN;
    if (!Number.isNaN(exact)) return exact >= since;
    return date.length > 7 ? date.slice(0, 10) >= sinceDay : date >= sinceMonth;
  };
  const posts = newestFirst(record, scope.filter(isNew)).map((e) => ({
    slug: e.slug,
    title: e.title ?? null,
    type: e.type ?? null,
    questions: Array.isArray(e.questions) ? e.questions : [],
    cites: record.edges.filter((edge) => edge.from === e.slug)
      .map((edge) => ({ slug: edge.to, relation: edge.relation ?? null })),
    html_url: `${BASE_URL}/posts/${e.slug}/`,
    date: publishedOn(record, e),
    published_precision: precisionOf(publishedOn(record, e)),
  }));

  // A decision names a post by its path and a question's page by its path or its id.
  const targets = new Set(scope.map((e) => `posts/${e.slug}.md`));
  if (slug !== null) targets.add(`posts/${slug}.md`);
  const onPage = (target) => page && (target === question || target.startsWith(`questions/${question}-`)
    || target === `questions/${question}.md`);
  const decisions = record.decisions
    .filter((d) => d.date >= sinceDay && (!filtered || targets.has(d.target) || onPage(d.target)))
    .reverse() // the log is appended to, so within a day the later line is the newer one
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((d) => ({ ...d, reason: cut(d.reason, REASON_CHARS) }));

  const questions = record.questions
    .filter((q) => (question !== null ? q.id === question : slug === null))
    .filter((q) => typeof q.updated === "string" && q.updated >= sinceDay)
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    .map((q) => ({ id: q.id, title: q.title ?? null, updated: q.updated,
      html_url: q.html_url ?? null, md_url: q.md_url ?? null }));

  const lists = { posts, decisions, questions };
  const truncated = Object.values(lists).some((list) => list.length > MAX_ENTRIES);
  return json({
    since: new Date(since).toISOString(),
    since_day: sinceDay,
    ...(question !== null ? { question } : {}),
    ...(slug !== null ? { slug } : {}),
    as_of: new Date(now).toISOString(),
    built_at: record.builtAt,
    posts: posts.slice(0, MAX_ENTRIES),
    decisions: decisions.slice(0, MAX_ENTRIES),
    questions: questions.slice(0, MAX_ENTRIES),
    truncated,
    note: NOTE,
  });
}

export const onRequest = withReadCors(handle, "GET");
