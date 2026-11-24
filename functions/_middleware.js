// Counts each request by day, path class, agent family and status code, in the STATS
// database. It stores no IP address, no user agent and no query string, it writes at most
// once per 50 requests or 60 seconds, and measurement can never change or block a response.
// One correction is made: the static "not found" page is HTML, so a 404 for a missing
// static file is labelled text/html even where _headers would label the extension
// (for example a missing .json). API and MCP responses are left exactly as they are.
import { classifyAgent, classifyPath } from "./_lib/agents.js";
import { utcDay, writeHits } from "./_lib/db.js";
import { addHit } from "./_lib/hits.js";

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
  const response = labelNotFound(context.request, await context.next());
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
