// D1 queries on the STATS database. Its hits table holds counts only: day, path class,
// agent family, status code.

const DAY_MS = 86_400_000;

export function utcDay(offsetDays = 0, now = Date.now()) {
  return new Date(now - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

// D1 binds at most 100 values in one statement, and a row takes five.
const ROWS_PER_STATEMENT = 20;

// Adds the rows from addHit to the stored counts: one statement for up to 20 distinct rows.
export async function writeHits(db, rows) {
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    await db.prepare(
      `INSERT INTO hits (day, path_class, agent, status, n) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")} `
      + "ON CONFLICT (day, path_class, agent, status) DO UPDATE SET n = n + excluded.n",
    ).bind(...chunk.flatMap((r) => [r.day, r.pathClass, r.agent, r.status, r.n])).run();
  }
}

export async function readStats(db, sinceDay) {
  const { results } = await db.prepare(
    "SELECT day, path_class, agent, SUM(n) AS n FROM hits WHERE day >= ? "
    + "GROUP BY day, path_class, agent ORDER BY day DESC, path_class, agent",
  ).bind(sinceDay).all();
  return results;
}
