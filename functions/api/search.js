// GET /api/search?q=&page=: posts whose title, summary or question ids contain every term, and
// the questions whose id or title contains every term.
import { error, json, methodNotAllowed, unavailable, withReadCors } from "../_lib/notice.js";
import { BAD_PAGE, cleanQuery, EMPTY_QUERY, parsePage, searchIndex } from "../_lib/search.js";
import { loadIndex, questionsOrNone } from "../_lib/site.js";

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const params = new URL(context.request.url).searchParams;
  const query = cleanQuery(params.get("q"));
  if (!query) return error(400, EMPTY_QUERY);
  const page = parsePage(params.get("page"));
  if (page < 1) return error(400, BAD_PAGE);

  let index;
  try {
    index = await loadIndex(context);
  } catch {
    return unavailable("the post index is unavailable right now; try again later");
  }
  return json(searchIndex(index, query, page, await questionsOrNone(context)));
}

export const onRequest = withReadCors(handle, "GET, HEAD");
