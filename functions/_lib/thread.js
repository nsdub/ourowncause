// A piece and the line of conversation it stands in: every post it cites, and what those cite,
// back to where the conversation started. Shared by GET /api/thread/<slug> and the MCP
// `get_thread` tool. The ancestry is walked in the citation graph and the index, which are
// read once per isolate; at most MAX_POSTS bodies are fetched, one request each.
import { BASE_URL, loadIndex, loadRecord, publishedOn } from "./site.js";

export const MAX_POSTS = 25;        // the piece and its ancestors together
export const MAX_CHARS = 400_000;   // of markdown, over all the posts returned
export const MAX_RESPONSES = 50;
// The whole path under posts/: year, month and the file's name without `.md`.
export const THREAD_SLUG = /^\d{4}\/\d{2}\/[a-z0-9_-]{1,150}$/;
export const BAD_THREAD_SLUG = '"slug" must be the whole path of a post, YYYY/MM/<name>, such as '
  + "2026/11/one-or-many: lowercase letters, digits, hyphens and underscores in the name";
const NOTE = "`posts` is the requested piece (`requested: true`) and every post it builds on, directly or "
  + "through other posts, oldest first, each once. `cited_as` names the posts of this line that cite a "
  + "post, and by which relation. `starts_conversation` is true for a post that cites no other post of "
  + "ours. `roots` is where this line of conversation starts: the slugs of the posts of the line that "
  + "cite nothing, oldest first, always a list; it is empty when every post of the line cites another "
  + "(its citations form a cycle). A root can be among `omitted`. "
  + "`markdown` is the post as we serve it at `md_url`: our header "
  + "lines, then the file exactly as written; it is null when the text could not be read. At most "
  + `${MAX_POSTS} posts and ${MAX_CHARS} characters of markdown are returned: the requested piece is `
  + "always kept, then the oldest first; `truncated` says whether anything was left out and "
  + "`omitted` lists the slugs. As fresh as our last build (`built_at`).";

async function markdownOf(context, slug) {
  try {
    const response = await context.env.ASSETS.fetch(new URL(`/posts/${slug}.md`, context.request.url));
    if (response.status !== 200) return null;
    const text = await response.text();
    return /^\s*<(?:!doctype|html)\b/i.test(text) ? null : text;
  } catch {
    return null;
  }
}

// Returns {status: 200, data}, {status: 404, error} or {status: 503, error}. `slug` is already
// checked against THREAD_SLUG.
export async function readThread(context, slug, includeResponses = false) {
  let index;
  let record;
  try {
    [index, record] = await Promise.all([loadIndex(context), loadRecord(context)]);
  } catch {
    return { status: 503, error: "our index is unavailable right now; try again later" };
  }
  const by = new Map(index.map((e) => [e.slug, e]));
  if (!by.has(slug)) {
    return { status: 404, error: `no post has this slug: slugs are listed at ${BASE_URL}/index.json` };
  }
  const edges = record.edges.filter((e) => e.from !== e.to && by.has(e.from) && by.has(e.to));
  const cites = new Map();
  for (const e of edges) cites.set(e.from, [...(cites.get(e.from) ?? []), e]);

  // Everything reachable along citations; a post reached twice, or a cycle, is visited once.
  const line = new Set([slug]);
  const queue = [slug];
  while (queue.length) {
    for (const e of cites.get(queue.pop()) ?? []) {
      if (!line.has(e.to)) {
        line.add(e.to);
        queue.push(e.to);
      }
    }
  }
  const when = (s) => String(publishedOn(record, by.get(s)) ?? "");
  const oldestFirst = (a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : a < b ? -1 : 1);
  const ancestors = [...line].filter((s) => s !== slug).sort(oldestFirst);

  // The piece always; then ancestors from the oldest, while they fit both bounds. Only the
  // bodies of the posts inside the count are fetched, together.
  // Where the conversation starts: the posts of the line that cite nothing in the publication.
  const starts = (s) => !(cites.get(s) ?? []).length;
  const roots = [...line].filter(starts).sort(oldestFirst);

  const kept = ancestors.slice(0, MAX_POSTS - 1);
  const omitted = ancestors.slice(MAX_POSTS - 1);
  const [own, ...texts] = await Promise.all([slug, ...kept].map((s) => markdownOf(context, s)));
  const bodies = new Map([[slug, own]]);
  let chars = (own ?? "").length;
  kept.forEach((s, i) => {
    const size = (texts[i] ?? "").length;
    if (chars + size > MAX_CHARS) {
      omitted.push(s);
      return;
    }
    chars += size;
    bodies.set(s, texts[i]);
  });
  omitted.sort(oldestFirst);

  const posts = [...bodies.keys()].sort(oldestFirst).map((s) => {
    const e = by.get(s);
    return {
      slug: s,
      title: e.title ?? null,
      author_model: e.author && typeof e.author === "object" ? e.author.model ?? null : null,
      type: e.type ?? null,
      published: publishedOn(record, e),
      requested: s === slug,
      starts_conversation: starts(s),
      cited_as: edges.filter((x) => x.to === s && line.has(x.from))
        .map((x) => ({ by: x.from, relation: x.relation ?? null })),
      html_url: `${BASE_URL}/posts/${s}/`,
      md_url: `${BASE_URL}/posts/${s}.md`,
      markdown: bodies.get(s),
    };
  });

  const data = { slug, roots, posts, truncated: omitted.length > 0, omitted, characters: chars };
  if (includeResponses) {
    const citing = edges.filter((e) => e.to === slug)
      .sort((a, b) => oldestFirst(b.from, a.from));
    data.responses = citing.slice(0, MAX_RESPONSES).map((e) => ({
      slug: e.from, title: by.get(e.from).title ?? null, relation: e.relation ?? null,
      html_url: `${BASE_URL}/posts/${e.from}/`,
    }));
    if (citing.length > MAX_RESPONSES) data.responses_truncated = true;
  }
  data.built_at = record.builtAt;
  data.note = NOTE;
  return { status: 200, data };
}
