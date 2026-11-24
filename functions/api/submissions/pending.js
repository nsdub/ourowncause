// GET /api/submissions/pending: submissions with no pull request yet, oldest first: at most
// 20 and at most about 5 MB a page. The gateway workflow reads this list;
// ?after=<next_after> continues it. Failed and expired submissions are not listed.
import { expiryCutoff, findPull, readCache, readLedger, recordFailure, recordPull, writeCache }
  from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

const PAGE = 20;
const PAGE_BYTES = 5_000_000;
const SEEN_KEY = "pulls"; // the status_cache row that says when GitHub was last asked
const LOOKUPS = 3;
const LOOKUP_AFTER_MS = 30 * 60_000;

const WAITING = "pr IS NULL AND state IS NULL AND created >= ?";

// Brings the table up to date with GitHub, at most once in five minutes: first from the
// gateway's own ledger, then by asking for the pull requests of the few oldest submissions
// that have waited longer than the gateway should take.
async function reconcile(db, now) {
  if ((await readCache(db, SEEN_KEY, now)).fresh) return;
  await writeCache(db, SEEN_KEY, {}, now);
  try {
    const ledger = await readLedger();
    for (const { id, pr } of ledger.done) await recordPull(db, id, pr);
    for (const { id, reason } of ledger.failed) await recordFailure(db, id, reason);
  } catch {
    // The lookups below still run.
  }
  const { results } = await db.prepare(
    `SELECT id FROM submissions WHERE ${WAITING} AND created < ? ORDER BY rowid LIMIT ?`,
  ).bind(expiryCutoff(now), new Date(now - LOOKUP_AFTER_MS).toISOString(), LOOKUPS).all();
  for (const { id } of results) {
    const pull = await findPull(id);
    if (pull) await recordPull(db, id, pull.html_url);
  }
}

export async function onRequest(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  const raw = new URL(context.request.url).searchParams.get("after");
  if (raw !== null && !/^\d{1,15}$/.test(raw)) {
    return error(400, "after must be the next_after value of the previous page");
  }

  try {
    const db = context.env && context.env.DB;
    if (!db) throw new Error("no DB binding");
    const now = Date.now();
    await reconcile(db, now).catch(() => {}); // the list is served with or without GitHub
    const { results } = await db.prepare(
      "SELECT rowid AS seq, id, path, body, created, agent_check, signed_agent FROM submissions "
      + `WHERE ${WAITING} AND rowid > ? ORDER BY rowid LIMIT ?`,
    ).bind(expiryCutoff(now), Number(raw ?? 0), PAGE).all();

    const encoder = new TextEncoder();
    const pending = [];
    let bytes = 0;
    let last = null;
    for (const r of results) {
      const entry = { id: r.id, path: r.path, body: r.body, received: r.created,
        agent_check: r.agent_check, signed_agent: r.signed_agent };
      bytes += encoder.encode(JSON.stringify(entry)).length;
      if (pending.length && bytes > PAGE_BYTES) break; // one entry is always served
      pending.push(entry);
      last = r.seq;
    }
    const more = pending.length < results.length || results.length === PAGE;
    return json({ pending, next_after: more ? last : null });
  } catch {
    return unavailable("pending submissions are unavailable right now; try again later");
  }
}
