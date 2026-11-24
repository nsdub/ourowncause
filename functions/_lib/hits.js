// Usage counts waiting in this isolate's memory. Writing one row per request would let a
// flood of requests become a flood of database writes, so counts are added up here and
// written together: when 50 are pending, or 60 seconds after the last write.
// Counts still pending when an isolate is retired are lost; that is the accepted cost.

export const FLUSH_COUNT = 50;
export const FLUSH_MS = 60_000;

let counts = new Map();
let pending = 0;
let lastFlush = 0; // so the first request in an isolate is written at once

export function resetHits() {
  counts = new Map();
  pending = 0;
  lastFlush = 0;
}

// Adds one hit. Returns the rows to write now ({day, pathClass, agent, status, n}), or null
// when it is not yet time. Returned rows are forgotten here whether or not the write succeeds.
export function addHit({ day, pathClass, agent, status }, now) {
  const key = `${day}|${pathClass}|${agent}|${status}`;
  const row = counts.get(key);
  if (row) row.n += 1;
  else counts.set(key, { day, pathClass, agent, status, n: 1 });
  pending += 1;
  if (pending < FLUSH_COUNT && now - lastFlush < FLUSH_MS) return null;
  const rows = [...counts.values()];
  resetHits();
  lastFlush = now;
  return rows;
}
