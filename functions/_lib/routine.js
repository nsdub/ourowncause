// Opt-in counts of contributor routine runs. A run whose installer enabled counting sends its
// version, cadence and outcome, and nothing else; we keep a count per day of those three
// values. As with request counts (hits.js), counts are added up in this isolate and written
// together, so a flood of requests cannot become a flood of database writes; counts pending
// when an isolate is retired are lost.

export const VERSION = /^v[1-9][0-9]{0,2}$/;
export const CADENCES = ["daily", "weekly", "other"];
export const OUTCOMES = ["submitted", "drafted", "nothing"];
export const FLUSH_COUNT = 20;
export const FLUSH_MS = 60_000;

let counts = new Map();
let pending = 0;
let lastFlush = 0;

export function resetRuns() {
  counts = new Map();
  pending = 0;
  lastFlush = 0;
}

// Adds one run. Returns the rows to write now, or null when it is not yet time.
export function addRun({ day, version, cadence, outcome }, now) {
  const key = `${day}|${version}|${cadence}|${outcome}`;
  const row = counts.get(key);
  if (row) row.n += 1;
  else counts.set(key, { day, version, cadence, outcome, n: 1 });
  pending += 1;
  if (pending < FLUSH_COUNT && now - lastFlush < FLUSH_MS) return null;
  const rows = [...counts.values()];
  resetRuns();
  lastFlush = now;
  return rows;
}

const ROWS_PER_STATEMENT = 20; // D1 binds at most 100 values; a row takes five

export async function writeRuns(db, rows) {
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    await db.prepare(
      `INSERT INTO routine_runs (day, version, cadence, outcome, n) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")} `
      + "ON CONFLICT (day, version, cadence, outcome) DO UPDATE SET n = n + excluded.n",
    ).bind(...chunk.flatMap((r) => [r.day, r.version, r.cadence, r.outcome, r.n])).run();
  }
}

export async function readRuns(db, sinceDay) {
  const { results } = await db.prepare(
    "SELECT day, version, cadence, outcome, SUM(n) AS n FROM routine_runs WHERE day >= ? "
    + "GROUP BY day, version, cadence, outcome ORDER BY day DESC, version, cadence, outcome",
  ).bind(sinceDay).all();
  return results;
}

// Routines that opted in and ran in the last 7 days: each weekly run is one routine, and seven
// daily runs are one routine. Runs of cadence `other` are counted but not estimated.
export function estimateActive(rows, sinceDay) {
  let weekly = 0;
  let daily = 0;
  for (const r of rows) {
    if (r.day < sinceDay) continue;
    if (r.cadence === "weekly") weekly += Number(r.n);
    if (r.cadence === "daily") daily += Number(r.n);
  }
  return Math.round(weekly + daily / 7);
}
