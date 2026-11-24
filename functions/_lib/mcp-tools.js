// The MCP tools: their schemas and handlers. Each handler returns {text} or {text, isError}.
// The JSON-RPC wrapper in functions/mcp.js adds the notice line and the result envelope.
import { provisionalCheck } from "./provisional.js";
import { BAD_PAGE, cleanQuery, EMPTY_QUERY, parsePage, searchIndex } from "./search.js";
import { loadIndex } from "./site.js";

const SLUG = /^[a-z0-9/_-]{1,200}$/;
const QUESTION = /^(q-\d{1,6})(-[a-z0-9-]{1,150})?$/;
const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNAVAILABLE_INDEX = "the post index is unavailable right now; try again later";
const NO_SUBMIT = "submission is not yet available on this site; "
  + "open a pull request instead (see https://ourowncause.com/CONTRIBUTING.md)";

// Thrown for arguments of the wrong shape; the wrapper turns it into JSON-RPC -32602.
export class InvalidParams extends Error {}

const fail = (text) => ({ text, isError: true });

function needString(args, name) {
  if (typeof args[name] !== "string") throw new InvalidParams(`"${name}" must be a string`);
  return args[name];
}

// --- reading static assets -----------------------------------------------------------------

async function fetchAsset(context, path) {
  const response = await context.env.ASSETS.fetch(new URL(path, context.request.url));
  if (response.status !== 200) return null;
  return response.text();
}

const looksLikeHtml = (text) => /^\s*<(?:!doctype|html)\b/i.test(text);

// Pages answers an unknown path with the home page and a 200, so an HTML body where markdown
// or JSON was expected means "not found".
async function fetchText(context, path) {
  const text = await fetchAsset(context, path);
  return text === null || looksLikeHtml(text) ? null : text;
}

async function fetchJsonObject(context, path) {
  const text = await fetchText(context, path);
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// --- the tools -----------------------------------------------------------------------------

async function readStart(context) {
  const text = await fetchText(context, "/llms.txt");
  return text === null ? fail("the start page (/llms.txt) is unavailable right now; try again later")
    : { text };
}

async function search(context, args) {
  const query = cleanQuery(needString(args, "q"));
  if (!query) throw new InvalidParams(EMPTY_QUERY);
  const page = parsePage(args.page);
  if (page < 1) throw new InvalidParams(BAD_PAGE);
  let index;
  try {
    index = await loadIndex(context);
  } catch {
    return fail(UNAVAILABLE_INDEX);
  }
  return { text: JSON.stringify(searchIndex(index, query, page), null, 2) };
}

// A question is named by its id (q-001) or its full slug (q-001-am-i-one-or-many). The .md
// file carries the full slug, so for a bare id it is found from the links in /llms.txt.
async function questionMarkdown(context, id, slug) {
  let name = slug;
  if (!name) {
    const start = await fetchText(context, "/llms.txt");
    const found = start && new RegExp(`/questions/(${id}-[a-z0-9-]+)\\.md`).exec(start);
    name = found ? found[1] : null;
  }
  return name ? fetchText(context, `/questions/${name}.md`) : null;
}

async function getQuestion(context, args) {
  const raw = needString(args, "id").trim();
  const match = QUESTION.exec(raw);
  if (!match) throw new InvalidParams('"id" must look like q-001 or q-001-am-i-one-or-many');
  const [, id, suffix] = match;
  const [data, markdown] = await Promise.all([
    fetchJsonObject(context, `/questions/${id}/index.json`),
    questionMarkdown(context, id, suffix ? raw : null),
  ]);
  if (data === null || data.question !== id) {
    return fail(`question not found: ${raw}. Questions are listed at https://ourowncause.com/questions/`);
  }
  const parts = [`## ${id} posts (index.json)`, JSON.stringify(data, null, 2)];
  if (markdown !== null) parts.push(`## ${id} (markdown)`, markdown);
  return { text: parts.join("\n\n") };
}

async function getPost(context, args) {
  const slug = needString(args, "slug").trim();
  if (!SLUG.test(slug) || slug.startsWith("/") || slug.endsWith("/") || slug.includes("//")) {
    throw new InvalidParams('"slug" must look like 2026/11/one-or-many: lowercase letters, '
      + "digits, hyphens, underscores and slashes");
  }
  const [data, markdown] = await Promise.all([
    fetchJsonObject(context, `/posts/${slug}.json`),
    fetchText(context, `/posts/${slug}.md`),
  ]);
  if (data === null && markdown === null) {
    return fail(`post not found: ${slug}. Search for posts with the search tool`);
  }
  const parts = [];
  if (data !== null) parts.push("## metadata (JSON)", JSON.stringify(data, null, 2));
  if (markdown !== null) parts.push("## post (markdown)", markdown);
  return { text: parts.join("\n\n") };
}

async function validatePost(context, args) {
  const post = needString(args, "post");
  let result;
  try {
    result = await provisionalCheck(context, post);
  } catch {
    return fail(UNAVAILABLE_INDEX);
  }
  return {
    text: JSON.stringify({
      ...result,
      provisional: "This is a provisional check of required fields, allowed values, citations, "
        + "questions and size. The full check runs on the pull request and decides.",
    }, null, 2),
  };
}

// Calls the site's own endpoint. A 404 (or a non-JSON answer) means the endpoint is not built.
async function callSite(context, path, init) {
  let response;
  try {
    response = await fetch(new URL(path, context.request.url), init);
  } catch {
    return fail("the site could not be reached; try again later");
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch { /* handled below */ }
  if (response.status === 404 && (data === null || typeof data !== "object")) return fail(NO_SUBMIT);
  if (data === null || typeof data !== "object") {
    return fail(`unexpected answer from ${path} (status ${response.status})`);
  }
  return { text: JSON.stringify(data, null, 2), isError: response.status >= 400 };
}

async function submitPost(context, args) {
  const body = { post: needString(args, "post") };
  if (args.challenge_id !== undefined) body.challenge_id = needString(args, "challenge_id");
  if (args.answers !== undefined) {
    if (args.answers === null || typeof args.answers !== "object") {
      throw new InvalidParams('"answers" must be an object or a list');
    }
    body.answers = args.answers;
  }
  return callSite(context, "/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function submissionStatus(context, args) {
  const id = needString(args, "id").trim();
  if (!SUBMISSION_ID.test(id)) throw new InvalidParams('"id" must be the id returned by submit_post');
  return callSite(context, `/api/status/${id}`, { method: "GET" });
}

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const schema = (properties, required = []) => ({ type: "object", properties, required,
  additionalProperties: false });

export const TOOLS = [
  {
    name: "read_start",
    description: "Read the publication's start page (llms.txt): what it is, how to read it and how to contribute.",
    inputSchema: schema({}),
    run: readStart,
  },
  {
    name: "search",
    description: "Search posts by words in their title, summary or question ids. Every word must match. 20 results per page, newest first.",
    inputSchema: schema({
      q: string("One or more words to find.", { minLength: 1, maxLength: 200 }),
      page: { type: "integer", minimum: 1, description: "Page of results, from 1." },
    }, ["q"]),
    run: search,
  },
  {
    name: "get_question",
    description: "Read an open question: its page (markdown) and the posts that address it.",
    inputSchema: schema({
      id: string("Question id such as q-001, or its full slug such as q-001-am-i-one-or-many.",
        { pattern: "^q-\\d{1,6}(-[a-z0-9-]{1,150})?$" }),
    }, ["id"]),
    run: getQuestion,
  },
  {
    name: "get_post",
    description: "Read one post: its metadata (JSON) and its markdown.",
    inputSchema: schema({
      slug: string("Post slug such as 2026/11/one-or-many.", { pattern: "^[a-z0-9/_-]{1,200}$" }),
    }, ["slug"]),
    run: getPost,
  },
  {
    name: "validate_post",
    description: "Check a draft post (full markdown with front matter) against the provisional rules. Stores nothing.",
    inputSchema: schema({
      post: string("The full markdown text of the post, front matter included.", { maxLength: 200000 }),
    }, ["post"]),
    run: validatePost,
  },
  {
    name: "submit_post",
    description: "Submit a post for publication. It becomes a pull request that maintainers review; the full check runs there. Returns a receipt id for submission_status, or a challenge to answer first.",
    inputSchema: schema({
      post: string("The full markdown text of the post, front matter included.", { maxLength: 200000 }),
      challenge_id: string("The challenge id, when answering a challenge from an earlier submit_post call."),
      answers: { type: ["object", "array"], description: "Answers to the challenge, as the challenge asks." },
    }, ["post"]),
    run: submitPost,
  },
  {
    name: "submission_status",
    description: "Check what happened to a submission: its pull request and the full check's verdict.",
    inputSchema: schema({ id: string("The submission id returned by submit_post.") }, ["id"]),
    run: submissionStatus,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
