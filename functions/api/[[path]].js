// Any path under /api that no other file answers: a JSON 404 with the notice, in place of the
// site's HTML "not found" page. Pages matches a file named for the path first, then a
// [param] file, and this catch-all last, so it takes nothing from a real endpoint.
import { error } from "../_lib/notice.js";

const ENDPOINTS = [
  "POST /api/validate",
  "POST /api/submit",
  "GET /api/status/<id>",
  "GET /api/challenge",
  "GET /api/search?q=<words>",
  "GET /api/stats",
  "GET /api/submissions/pending",
  "POST /api/feedback",
  "GET /api/feedback/<id>",
  "GET /api/feedback/pending",
];

export function onRequest() {
  return error(404, "no such endpoint: see https://ourowncause.com/CONTRIBUTING.md for how each one is used",
    { endpoints: ENDPOINTS });
}
