// GET /api/routine/stats?days=N: the opt-in counts of contributor routine runs, by day,
// version, cadence and outcome, and an estimate of how many routines that opted in ran in the
// last 7 days. Only routines whose installer enabled counting are in it, and anyone can send a
// count, so it is a lower bound on nothing and an upper bound on nothing: the answer says so.
import { utcDay } from "../../_lib/db.js";
import { error, json, methodNotAllowed, unavailable, withReadCors } from "../../_lib/notice.js";
import { estimateActive, readRuns } from "../../_lib/routine.js";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const CAVEAT = "Counts only routines whose installer enabled counting, and the route takes a count from anyone, "
  + "so the figures can be inflated. estimated_active_routines is weekly runs in the last 7 days plus daily runs "
  + "in the last 7 days divided by 7. We store a count per day of version, cadence and outcome, and nothing else.";

async function handle(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const raw = new URL(context.request.url).searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (raw !== null) {
    days = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
    if (days < 1 || days > MAX_DAYS) return error(400, `days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  let rows;
  try {
    const db = context.env && context.env.STATS;
    if (!db) throw new Error("no STATS binding");
    rows = await readRuns(db, utcDay(Math.max(days, 7) - 1));
  } catch {
    return unavailable("run counts are unavailable right now; try again later");
  }
  const since = utcDay(days - 1);
  const shown = rows.filter((r) => r.day >= since);
  const totals = {};
  for (const r of shown) totals[r.outcome] = (totals[r.outcome] ?? 0) + Number(r.n);
  return json({
    days, since, rows: shown, runs_by_outcome: totals,
    estimated_active_routines: estimateActive(rows, utcDay(6)),
    caveat: CAVEAT,
  });
}

export const onRequest = withReadCors(handle, "GET, HEAD");
