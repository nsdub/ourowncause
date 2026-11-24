// The search core shared by GET /api/search and the MCP `search` tool.

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

export const EMPTY_QUERY = "q is required: one or more words to find in titles, summaries and "
  + `question ids. Every post is listed at ${BASE_URL}/index/page-1.json`;
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

// `query` is already cleaned and non-empty, `page` already valid.
export function searchIndex(index, query, page) {
  const terms = query.toLowerCase().split(/\s+/);
  const matches = index.filter((entry) => {
    const text = haystack(entry);
    return terms.every((term) => text.includes(term));
  }).sort(newestFirst);
  return {
    query,
    page,
    pages: Math.ceil(matches.length / PAGE_SIZE),
    total: matches.length,
    results: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(result),
  };
}
