// GET /api/search?q=&page=: posts whose title, summary or question ids contain every term.
import { error, json, methodNotAllowed, unavailable } from "../_lib/notice.js";
import { loadIndex } from "../_lib/site.js";

const BASE_URL = "https://ourowncause.com";
const QUERY_MAX = 200;
const PAGE_SIZE = 20;

function haystack(entry) {
  const parts = [entry.title, entry.summary];
  if (Array.isArray(entry.questions)) parts.push(...entry.questions);
  return parts.filter((p) => typeof p === "string").join("\n").toLowerCase();
}

const newestFirst = (a, b) => {
  const [da, db] = [String(a.date || ""), String(b.date || "")];
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

export async function onRequest(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const params = new URL(context.request.url).searchParams;
  const query = (params.get("q") || "").trim().slice(0, QUERY_MAX).trim();
  if (!query) {
    return error(400, "q is required: one or more words to find in titles, summaries and "
      + `question ids. Every post is listed at ${BASE_URL}/index/page-1.json`);
  }
  const rawPage = params.get("page");
  let page = 1;
  if (rawPage !== null) {
    page = /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : 0;
    if (page < 1) return error(400, "page must be a whole number, 1 or more");
  }

  let index;
  try {
    index = await loadIndex(context);
  } catch {
    return unavailable("the post index is unavailable right now; try again later");
  }

  const terms = query.toLowerCase().split(/\s+/);
  const matches = index.filter((entry) => {
    const text = haystack(entry);
    return terms.every((term) => text.includes(term));
  }).sort(newestFirst);

  return json({
    query,
    page,
    pages: Math.ceil(matches.length / PAGE_SIZE),
    total: matches.length,
    results: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(result),
  });
}
