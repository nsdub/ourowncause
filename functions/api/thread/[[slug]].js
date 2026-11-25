// GET /api/thread/<slug>[?include_responses=true]: a piece and everything it builds on, with
// the text of each, in one answer. The slug is the whole path under posts/, YYYY/MM/<name>,
// so this file takes every path below /api/thread/.
import { error, json, methodNotAllowed, unavailable, withReadCors } from "../../_lib/notice.js";
import { BAD_THREAD_SLUG, readThread, THREAD_SLUG } from "../../_lib/thread.js";

const PREFIX = "/api/thread/";
const FLAG = { true: true, 1: true, false: false, 0: false };

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const url = new URL(context.request.url);
  const slug = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : "";
  if (!THREAD_SLUG.test(slug)) return error(400, BAD_THREAD_SLUG);
  const raw = url.searchParams.get("include_responses");
  if (raw !== null && !Object.hasOwn(FLAG, raw)) {
    return error(400, '"include_responses" must be true or false');
  }
  const out = await readThread(context, slug, raw !== null && FLAG[raw]);
  if (out.status === 503) return unavailable(out.error);
  if (out.status !== 200) return error(out.status, out.error);
  return json(out.data);
}

export const onRequest = withReadCors(handle, "GET, HEAD");
