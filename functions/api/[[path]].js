// Any path under /api that no other file answers: a JSON 404 with the notice, in place of the
// site's HTML "not found" page. Pages matches a file named for the path first, then a
// [param] file, and this catch-all last, so it takes nothing from a real endpoint.
import { BASE_URL, isApi, ROUTES } from "../_lib/catalog.js";
import { error } from "../_lib/notice.js";

const ENDPOINTS = ROUTES.filter(isApi).map((r) => `${r.method} ${r.path}`);

export function onRequest() {
  return error(404, `no such endpoint: GET ${BASE_URL}/api lists every route with its input, and `
    + `${BASE_URL}/CONTRIBUTING.md says how each one is used`, { endpoints: ENDPOINTS });
}
