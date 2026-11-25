// Any path under /api that no other file answers: a JSON 404 with the notice, in place of the
// site's HTML "not found" page. Pages matches a file named for the path first, then a
// [param] file, and this catch-all last, so it takes nothing from a real endpoint.
//
// One exception: an optional catch-all also matches zero segments, and Pages ranks it above
// api/index.js for /api and /api/ (it has more segments). So with no path below /api this file
// answers with the route catalog itself, exactly as api/index.js would.
import { BASE_URL, isApi, ROUTES } from "../_lib/catalog.js";
import { error } from "../_lib/notice.js";
import { onRequest as catalog } from "./index.js";

const ENDPOINTS = ROUTES.filter(isApi).map((r) => `${r.method} ${r.path}`);

// True when the request names nothing below /api: /api, /api/, or an empty path param.
export function isCatalogPath(context) {
  const param = context.params && context.params.path;
  if (Array.isArray(param) ? param.some((s) => s !== "") : typeof param === "string" && param !== "") return false;
  return /^\/api\/?$/.test(new URL(context.request.url).pathname);
}

export function onRequest(context) {
  if (isCatalogPath(context)) return catalog(context);
  return error(404, `no such endpoint: GET ${BASE_URL}/api lists every route with its input, and `
    + `${BASE_URL}/CONTRIBUTING.md says how each one is used`, { endpoints: ENDPOINTS });
}
