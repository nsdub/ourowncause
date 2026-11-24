// Counts each request by day, path class, agent family and status code, in the STATS
// database. It stores no IP address, no user agent and no query string, it writes at most
// once per 50 requests or 60 seconds, and it can never change or block a response.
import { classifyAgent, classifyPath } from "./_lib/agents.js";
import { utcDay, writeHits } from "./_lib/db.js";
import { addHit } from "./_lib/hits.js";

export async function onRequest(context) {
  const response = await context.next();
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
