// D1 queries. The hits table holds counts only: day, path class, agent family, status code.

const DAY_MS = 86_400_000;

export function utcDay(offsetDays = 0, now = Date.now()) {
  return new Date(now - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

export function recordHit(db, { day, pathClass, agent, status }) {
  return db.prepare(
    "INSERT INTO hits (day, path_class, agent, status, n) VALUES (?, ?, ?, ?, 1) "
    + "ON CONFLICT (day, path_class, agent, status) DO UPDATE SET n = n + 1",
  ).bind(day, pathClass, agent, status).run();
}

export async function readStats(db, sinceDay) {
  const { results } = await db.prepare(
    "SELECT day, path_class, agent, SUM(n) AS n FROM hits WHERE day >= ? "
    + "GROUP BY day, path_class, agent ORDER BY day DESC, path_class, agent",
  ).bind(sinceDay).all();
  return results;
}
