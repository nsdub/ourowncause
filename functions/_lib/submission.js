// What POST /api/validate and POST /api/submit share: reading the request body within a size
// limit, and running the provisional check against what the site publishes. Both endpoints
// go through checkSubmitted, so submit can never accept a post that validate rejects.
import { loadIndex, questionExists } from "./site.js";
import { checkPost, isQuestionId, MAX_POST_BYTES, readPost } from "./validate.js";

// JSON can spend six bytes on one character (\u0041), so a post at the limit fits in this.
export const MAX_REQUEST_BYTES = 6 * MAX_POST_BYTES + 1_000;
const MAX_QUESTION_LOOKUPS = 20;
export const PROVISIONAL = "This is a provisional check of required fields, allowed values, citations, "
  + "questions and size. The full check runs on the pull request and decides.";
const TOO_LARGE = `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes, `
  + `and a post may be at most ${MAX_POST_BYTES} bytes`;

export class BadRequest extends Error {}

export const NOT_JSON = "Content-Type must be application/json";

// True when the request says its body is JSON; parameters such as charset are allowed. A
// form posted from a web page cannot say so, which keeps other sites' pages from submitting
// through a visitor.
export function saysJson(request) {
  return /^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? "");
}

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
  const unseen = [...new Set(named.filter((q) => isQuestionId(q) && !known.has(q)))];
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
