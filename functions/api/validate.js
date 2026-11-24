// POST /api/validate with {"post": "<full markdown with front matter>"}: the provisional
// check. It stores nothing and changes nothing.
import { error, json, methodNotAllowed, unavailable } from "../_lib/notice.js";
import { provisionalCheck } from "../_lib/provisional.js";
import { MAX_POST_BYTES } from "../_lib/validate.js";

// JSON can spend six bytes on one character (A), so a post at the limit fits in this.
const MAX_REQUEST_BYTES = 6 * MAX_POST_BYTES + 1_000;
const PROVISIONAL = "This is a provisional check of required fields, allowed values, citations, "
  + "questions and size. The full check runs on the pull request and decides.";
const TOO_LARGE = `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes, `
  + `and a post may be at most ${MAX_POST_BYTES} bytes`;

class BadRequest extends Error {}

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

async function readRequest(request) {
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
  return data.post;
}

export async function onRequest(context) {
  if (context.request.method !== "POST") return methodNotAllowed("POST");
  let text;
  try {
    text = await readRequest(context.request);
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    return error(400, "request body could not be read");
  }

  let result;
  try {
    result = await provisionalCheck(context, text);
  } catch {
    return unavailable("the post index is unavailable right now; try again later");
  }
  return json({ ...result, provisional: PROVISIONAL });
}
