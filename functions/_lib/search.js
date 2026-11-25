// The search core shared by GET /api/search and the MCP `search` tool. Posts are matched on
// their title, summary and question ids, and paged; questions are matched on their id and title,
// and every matching question is listed on every page, apart from the posts.

export const BASE_URL = "https://ourowncause.com";
export const QUERY_MAX = 200;
export const PAGE_SIZE = 20;

function haystack(entry) {
  const parts = [entry.title, entry.summary];
  if (Array.isArray(entry.questions)) parts.push(...entry.questions);
  return parts.filter((p) => typeof p === "string").join("\n").toLowerCase();
}

const newestFirst = (a, b) => {
  const [da, db] = [String(a.published || a.date || ""), String(b.published || b.date || "")];
  if (da !== db) return da < db ? 1 : -1;
  return a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0;
};

function result(entry) {
  return {
    slug: entry.slug,
    title: entry.title ?? null,
    type: entry.type ?? null,
    summary: entry.summary ?? null,
    questions: Array.isArray(entry.questions) ? entry.questions : [],
    date: entry.date ?? null,
    url: `${BASE_URL}/posts/${entry.slug}/`,
    markdown_url: `${BASE_URL}/posts/${entry.slug}.md`,
  };
}

// A question of /questions/index.json as a result, marked as a question.
function questionResult(entry) {
  const text = (name) => (typeof entry[name] === "string" ? entry[name] : null);
  return {
    type: "question",
    id: entry.id,
    title: text("title"),
    status: text("status"),
    url: text("html_url") ?? `${BASE_URL}/questions/`,
    markdown_url: text("md_url"),
    index_url: `${BASE_URL}/questions/${entry.id}/index.json`,
  };
}

export const EMPTY_QUERY = "q is required: one or more words to find in post titles, summaries and "
  + `question ids, and in question titles. Every post is listed at ${BASE_URL}/index/page-1.json`;
export const BAD_PAGE = "page must be a whole number, 1 or more";

export function cleanQuery(raw) {
  return String(raw ?? "").trim().slice(0, QUERY_MAX).trim();
}

// `rawPage` is a string, a number or null/undefined. Returns the page number, or 0 when invalid.
export function parsePage(rawPage) {
  if (rawPage === null || rawPage === undefined) return 1;
  const text = String(rawPage);
  const page = /^\d{1,6}$/.test(text) ? Number(text) : 0;
  return page < 1 ? 0 : page;
}

// `query` is already cleaned and non-empty, `page` already valid. `questions` holds the entries
// of /questions/index.json, or [] when they could not be read. `total`, `pages` and `results`
// count and page the posts; `questions` lists every matching question, in id order.
export function searchIndex(index, query, page, questions = []) {
  const terms = query.toLowerCase().split(/\s+/);
  const matchesAll = (text) => terms.every((term) => text.includes(term));
  const matches = index.filter((entry) => matchesAll(haystack(entry))).sort(newestFirst);
  const questionMatches = questions
    .filter((q) => q && typeof q === "object" && typeof q.id === "string" && /^q-\d{1,6}$/.test(q.id))
    .filter((q) => matchesAll([q.id, q.title].filter((p) => typeof p === "string").join("\n").toLowerCase()))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    query,
    page,
    pages: Math.ceil(matches.length / PAGE_SIZE),
    total: matches.length,
    results: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(result),
    questions: questionMatches.map(questionResult),
  };
}
