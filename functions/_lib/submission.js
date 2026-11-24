// What POST /api/validate and POST /api/submit share: reading the request body within a size
// limit, and running the provisional check against what the site publishes. Both endpoints
// go through checkSubmitted, so submit can never accept a post that validate rejects.
import { loadIndex, questionExists } from "./site.js";
import { checkPost, MAX_POST_BYTES, readPost } from "./validate.js";

// JSON can spend six bytes on one character (\u0041), so a post at the limit fits in this.
export const MAX_REQUEST_BYTES = 6 * MAX_POST_BYTES + 1_000;
const MAX_QUESTION_LOOKUPS = 20;
export const PROVISIONAL = "This is a provisional check of required fields, allowed values, citations, "
  + "questions and size. The full check runs on the pull request and decides.";
const TOO_LARGE = `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes, `
  + `and a post may be at most ${MAX_POST_BYTES} bytes`;

export class BadRequest extends Error {}

// The request body as bytes, refusing to buffer more than the limit.
async function readBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new BadRequest(TOO_LARGE);
  if (!request.body) return new Uint8Array();
  const chunks = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new BadRequest(TOO_LARGE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The request body as a JSON object whose `post` is a string. Throws BadRequest otherwise.
export async function readJsonObject(request) {
  const bytes = await readBody(request);
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequest('request body must be JSON in UTF-8, in the form {"post": "<markdown>"}');
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new BadRequest('request body must be a JSON object, in the form {"post": "<markdown>"}');
  }
  if (!Object.hasOwn(data, "post")) throw new BadRequest('"post" is required: the full markdown text of the post');
  if (typeof data.post !== "string") throw new BadRequest('"post" must be a string: the full markdown text of the post');
  return data;
}

// Question ids from index.json, plus any the post names that the site confirms exist. A
// question with no posts yet appears in no index entry, so those are looked up one by one,
// up to a limit. Returns {known, unchecked}: the ids past the limit were not looked up.
async function findQuestions(context, index, meta) {
  const known = new Set(index.flatMap((e) => (Array.isArray(e.questions) ? e.questions : [])));
  const named = meta && Array.isArray(meta.questions) ? meta.questions : [];
  const unseen = [...new Set(named.filter((q) => typeof q === "string" && !known.has(q)))];
  for (const id of unseen.slice(0, MAX_QUESTION_LOOKUPS)) {
    if (await questionExists(context, id)) known.add(id);
  }
  return { known, unchecked: unseen.slice(MAX_QUESTION_LOOKUPS) };
}

// The provisional check of a post's full text. Returns {meta, result}: `meta` is the front
// matter when it could be read, `result` is {ok, errors, warnings}. Throws when the site's
// index cannot be read.
export async function checkSubmitted(context, text) {
  const read = readPost(text);
  const index = await loadIndex(context);
  const questions = await findQuestions(context, index, read.meta);
  const slugs = new Set(index.map((e) => e.slug));
  return { meta: read.meta, result: checkPost(read, text, slugs, questions.known, questions.unchecked) };
}

// Characters that are refused anywhere in a submitted post: C0 controls other than tab and
// the line breaks, DEL, C1 controls, and the bidirectional overrides and isolates. They have
// no use in an essay, they hide or reorder what a reader sees, and some (U+0000) cannot be
// passed on to the tools that open the pull request.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
const MAX_WALK_DEPTH = 30;

function firstForbidden(value, depth = 0) {
  if (typeof value === "string") {
    const match = FORBIDDEN.exec(value);
    return match ? match[0] : null;
  }
  if (value === null || typeof value !== "object" || depth > MAX_WALK_DEPTH) return null;
  for (const [key, child] of Object.entries(value)) {
    const found = firstForbidden(key) ?? firstForbidden(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// An error message when the post's text, or any front matter value after its escapes are
// read (a title written "\x00"), holds such a character; otherwise null.
export function controlCharacterError(text, meta) {
  const found = firstForbidden(text) ?? firstForbidden(meta);
  if (!found) return null;
  const code = found.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
  return `control and text-direction characters are not accepted: remove U+${code}, written out or `
    + "as an escape (tabs and line breaks are fine)";
}
