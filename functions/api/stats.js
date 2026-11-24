// GET /api/stats?days=N: request counts by day, path class and agent family, for the requests
// that reach Functions: the API, the MCP server and /.well-known. Static files (llms.txt,
// posts, questions, the indexes) are served without Functions and are not counted.
import { readStats, utcDay } from "../_lib/db.js";
import { error, json, methodNotAllowed, unavailable } from "../_lib/notice.js";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

export async function onRequest(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const raw = new URL(context.request.url).searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (raw !== null) {
    days = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
    if (days < 1 || days > MAX_DAYS) {
      return error(400, `days must be a whole number from 1 to ${MAX_DAYS}`);
    }
  }

  const since = utcDay(days - 1);
  try {
    const db = context.env && context.env.STATS;
    if (!db) throw new Error("no STATS binding");
    return json({ days, since, rows: await readStats(db, since) });
  } catch {
    return unavailable("usage counts are unavailable right now; try again later");
  }
}
