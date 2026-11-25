// What the static site already publishes, read through the ASSETS binding and cached for the
// life of the isolate. A new deployment starts new isolates, so the cache never outlives a build.

const QUESTION_ID = /^q-\d{1,6}$/;

let indexCache = null;
let questionsCache = null;
let recordCache = null;
const confirmedQuestions = new Set();

export function resetSiteCache() {
  indexCache = null;
  questionsCache = null;
  recordCache = null;
  confirmedQuestions.clear();
}

async function fetchJson(context, path) {
  const response = await context.env.ASSETS.fetch(new URL(path, context.request.url));
  if (!response.ok) throw new Error(`${path}: status ${response.status}`);
  return response.json();
}

// Entries of /index.json that have a slug. Throws when the index cannot be read.
export async function loadIndex(context) {
  if (indexCache) return indexCache;
  const data = await fetchJson(context, "/index.json");
  if (!Array.isArray(data)) throw new Error("/index.json is not a list");
  indexCache = data.filter((e) => e && typeof e === "object" && typeof e.slug === "string");
  return indexCache;
}

// Entries of /questions/index.json. Throws when the list cannot be read.
export async function loadQuestions(context) {
  if (questionsCache) return questionsCache;
  const data = await fetchJson(context, "/questions/index.json");
  if (!Array.isArray(data)) throw new Error("/questions/index.json is not a list");
  questionsCache = data.filter((q) => q && typeof q === "object" && typeof q.id === "string");
  return questionsCache;
}

// The questions for search: [] when the list cannot be read, so posts are still found.
export const questionsOrNone = (context) => loadQuestions(context).catch(() => []);

// --- the record: who cites whom, what was decided and when -----------------------------------

export const BASE_URL = "https://ourowncause.com";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A line of moderation/log.md, as tools/record_decision.py writes it:
// `YYYY-MM-DD <action> <target> by <maintainer>: <reason>`. A target may hold spaces (`PR #10`).
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}) ([a-z][a-z-]*) (.+?) by ([A-Za-z0-9_-]+): (.*)$/;
const MERGED_POST = /^posts\/(.+)\.md$/;

// The decisions in the log's text, in the order they were written. Other lines are skipped.
export function parseLog(text) {
  const decisions = [];
  for (const line of text.split("\n")) {
    const m = LOG_LINE.exec(line.trimEnd());
    if (m) decisions.push({ date: m[1], action: m[2], target: m[3], maintainer: m[4], reason: m[5] });
  }
  return decisions;
}

// The text at `path`, or null when the site does not publish it: a 404, or the HTML page a
// build without 404.html answers with. Throws on any other failure.
async function fetchOptionalText(context, path) {
  const response = await context.env.ASSETS.fetch(new URL(path, context.request.url));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: status ${response.status}`);
  const text = await response.text();
  return /^\s*<(?:!doctype|html)\b/i.test(text) ? null : text;
}

// What the build published besides the index, read once per isolate:
//   edges      [{from, to, relation}] of /graph.json
//   decisions  the moderation log's entries, oldest first ([] when no log is published)
//   days       Map from a post's slug to the day its first `merge` entry was logged
//   questions  the entries of /questions/index.json
//   builtAt    the day of the build, from /status.json, or null
// Throws when the graph or the question list cannot be read.
export async function loadRecord(context) {
  if (recordCache) return recordCache;
  const [graph, log, questions, status] = await Promise.all([
    fetchJson(context, "/graph.json"),
    fetchOptionalText(context, "/moderation/log.md"),
    fetchJson(context, "/questions/index.json"),
    fetchOptionalText(context, "/status.json"),
  ]);
  if (!graph || !Array.isArray(graph.edges)) throw new Error("/graph.json has no edges");
  if (!Array.isArray(questions)) throw new Error("/questions/index.json is not a list");
  const decisions = log === null ? [] : parseLog(log);
  const days = new Map();
  for (const d of decisions) {
    const post = d.action === "merge" ? MERGED_POST.exec(d.target) : null;
    if (post && !days.has(post[1])) days.set(post[1], d.date);
  }
  let builtAt = null;
  try {
    const day = status === null ? null : JSON.parse(status).last_build;
    if (typeof day === "string" && DAY.test(day)) builtAt = day;
  } catch { /* shown as null */ }
  recordCache = {
    edges: graph.edges.filter((e) => e && typeof e.from === "string" && typeof e.to === "string"),
    decisions,
    days,
    questions: questions.filter((q) => q && typeof q.id === "string" && QUESTION_ID.test(q.id)),
    builtAt,
  };
  return recordCache;
}

// When a post was published, as exactly as the site knows: the `published` the build wrote in
// the index (a time to the second when it had the commit history), or else the day its merge
// was logged, or else the month in its slug. All three sort as text, newest last.
export const publishedOn = (record, entry) => (typeof entry.published === "string" && entry.published
  ? entry.published : record.days.get(entry.slug) ?? entry.date ?? null);

// How exact a value of publishedOn is, read from its form: "second", "day" or "month".
export const precisionOf = (date) => (typeof date !== "string" ? null
  : date.length > 10 ? "second" : date.length > 7 ? "day" : "month");

// Newest first; within one date, the later slug first.
export function newestFirst(record, entries) {
  const key = (e) => String(publishedOn(record, e) ?? "");
  return [...entries].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : a.slug < b.slug ? 1 : -1));
}

export const postUrls = (slug) => ({
  html_url: `${BASE_URL}/posts/${slug}/`,
  md_url: `${BASE_URL}/posts/${slug}.md`,
  json_url: `${BASE_URL}/posts/${slug}.json`,
});

// True when the site publishes /questions/<id>/index.json for this id. A missing path gets the
// site's 404 page; the file's own `question` field is checked as well, so that a 200 with any
// other body (a build without 404.html answers with the home page) is not taken as proof.
export async function questionExists(context, id) {
  if (typeof id !== "string" || !QUESTION_ID.test(id)) return false;
  if (confirmedQuestions.has(id)) return true;
  try {
    const data = await fetchJson(context, `/questions/${id}/index.json`);
    if (!data || data.question !== id) return false;
  } catch {
    return false;
  }
  confirmedQuestions.add(id);
  return true;
}
