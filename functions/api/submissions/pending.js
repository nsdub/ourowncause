// GET /api/submissions/pending: submissions with no pull request yet, oldest first: at most
// 20 and at most about 5 MB a page. The gateway workflow reads this list;
// ?after=<next_after> continues it. Failed, expired and withdrawn submissions are not listed.
import { expiryCutoff, findPull, OPEN_CACHE_MS, readCache, readLedger, recordFailure, recordPull, undoWithdrawal,
  writeCache } from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

const PAGE = 20;
const PAGE_BYTES = 5_000_000;
const SEEN_KEY = "pulls"; // the status_cache row that says when the ledger was last read
const LOOKED_UP_KEY = "lookups"; // and the one that says when pull requests were last looked up
const LOOKUPS = 3;
const LOOKUP_AFTER_MS = 30 * 60_000;

// state is NULL for a submission that waits: 'failed' and 'withdrawn' are never listed.
const WAITING = "pr IS NULL AND state IS NULL AND created >= ?";

// Brings the table up to date with GitHub. At most once in five minutes, from the gateway's
// own ledger, which is a raw file and costs nothing against GitHub's API limit. At most once
// in 30 minutes, by asking the API for the pull requests of the few oldest submissions that
// have waited longer than the gateway should take.
async function reconcile(db, now) {
  if ((await readCache(db, SEEN_KEY, now)).fresh) return;
  await writeCache(db, SEEN_KEY, {}, now);
  try {
    const ledger = await readLedger();
    for (const { id, pr } of ledger.done) await recordPull(db, id, pr);
    for (const { id, reason } of ledger.failed) await recordFailure(db, id, reason);
    for (const { id, merged } of ledger.withdrawn) if (merged) await undoWithdrawal(db, id);
  } catch {
    // The lookups below still run.
  }
  if ((await readCache(db, LOOKED_UP_KEY, now, OPEN_CACHE_MS)).fresh) return;
  const { results } = await db.prepare(
    `SELECT id FROM submissions WHERE ${WAITING} AND created < ? ORDER BY rowid LIMIT ?`,
  ).bind(expiryCutoff(now), new Date(now - LOOKUP_AFTER_MS).toISOString(), LOOKUPS).all();
  if (results.length) await writeCache(db, LOOKED_UP_KEY, {}, now);
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
      "SELECT rowid AS seq, id, path, body, created, agent_check, signed_agent, supersedes FROM submissions "
      + `WHERE ${WAITING} AND rowid > ? ORDER BY rowid LIMIT ?`,
    ).bind(expiryCutoff(now), Number(raw ?? 0), PAGE).all();

    const encoder = new TextEncoder();
    const pending = [];
    let bytes = 0;
    let last = null;
    for (const r of results) {
      const entry = { id: r.id, path: r.path, body: r.body, received: r.created,
        agent_check: r.agent_check, signed_agent: r.signed_agent, supersedes: r.supersedes };
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
