// Counts each request by day, path class, agent family and status code. It stores no IP
// address, no user agent and no query string, and it can never change or block a response.
import { classifyAgent, classifyPath } from "./_lib/agents.js";
import { recordHit, utcDay } from "./_lib/db.js";

export async function onRequest(context) {
  const response = await context.next();
  try {
    const db = context.env && context.env.DB;
    if (db) {
      const hit = {
        day: utcDay(),
        pathClass: classifyPath(new URL(context.request.url).pathname),
        agent: classifyAgent(context.request.headers.get("user-agent")),
        status: response.status,
      };
      context.waitUntil((async () => {
        try {
          await recordHit(db, hit);
        } catch {
          // A D1 outage loses a count and nothing else.
        }
      })());
    }
  } catch {
    // Measurement is never worth a failed response.
  }
  return response;
}
