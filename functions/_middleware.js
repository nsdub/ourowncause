// Runs only for the routes in _routes.json (written by tools/build_site.py): /api/*, /mcp,
// /.well-known/* and our HTML pages. Other static files (.md, .json, .txt, .xml) are served
// without Functions and never reach this file.
//
// An HTML page goes through _lib/negotiate.js, which serves its markdown twin to a reader that
// asks for markdown and the HTML to everyone else. Every other path is passed on untouched.
//
// Counts each of those requests by day, path class, agent family and status code, in the
// STATS database. Page reads are counted; reads of the other static files are not. It stores no IP address, no user
// agent and no query string, it writes at most once per 50 requests or 60 seconds, and
// measurement can never change or block a response.
// One correction is made: the static "not found" page is HTML, so a 404 that falls through
// to it (a missing path under /.well-known, say) is labelled text/html whatever _headers
// would say for its extension. API and MCP responses are left exactly as they are.
import { classifyAgent, classifyPath } from "./_lib/agents.js";
import { utcDay, writeHits } from "./_lib/db.js";
import { addHit } from "./_lib/hits.js";
import { negotiate } from "./_lib/negotiate.js";

const FUNCTION_PATH = /^\/(?:api|mcp|\.well-known)(?:\/|$)/;
const serve = (context) => (FUNCTION_PATH.test(new URL(context.request.url).pathname)
  ? context.next() : negotiate(context));

export function labelNotFound(request, response) {
  if (response.status !== 404) return response;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/")) return response;
  const type = response.headers.get("content-type") || "";
  if (type.startsWith("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(response.body, { status: 404, statusText: response.statusText, headers });
}

export async function onRequest(context) {
  const response = labelNotFound(context.request, await serve(context));
  try {
    const db = context.env && context.env.STATS;
    if (db) {
      const due = addHit({
        day: utcDay(),
        pathClass: classifyPath(new URL(context.request.url).pathname),
        agent: classifyAgent(context.request.headers.get("user-agent")),
        status: response.status,
      }, Date.now());
      // A D1 outage loses these counts and nothing else.
      if (due) context.waitUntil(writeHits(db, due).catch(() => {}));
    }
  } catch {
    // Measurement is never worth a failed response.
  }
  return response;
}
