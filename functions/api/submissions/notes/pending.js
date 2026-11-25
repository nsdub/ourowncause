// GET /api/submissions/notes/pending: author's notes with no pull request yet, oldest
// first, at most 20 a page. The gateway workflow reads this list; ?after=<next_after>
// continues it. Notes the gateway's ledger records as done or failed are not listed, nor
// are expired ones.
import { expiryCutoff, readCache, readLedger, recordNoteFailure, recordNotePull, writeCache }
  from "../../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../../_lib/notice.js";

const PAGE = 20; // a note is at most 1,000 characters
const SEEN_KEY = "notes-ledger"; // the status_cache row that says when the ledger was last read

// Brings the table up to date with the gateway's own ledger, at most once in five minutes.
async function reconcile(db, now) {
  if ((await readCache(db, SEEN_KEY, now)).fresh) return;
  await writeCache(db, SEEN_KEY, {}, now);
  const { notes } = await readLedger();
  for (const { id, pr } of notes.done) await recordNotePull(db, id, pr);
  for (const { id, reason } of notes.failed) await recordNoteFailure(db, id, reason);
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
      "SELECT n.rowid AS seq, n.id, n.submission, s.path, n.note, n.created FROM author_notes n "
      + "JOIN submissions s ON s.id = n.submission "
      + "WHERE n.pr IS NULL AND n.state IS NULL AND n.created >= ? AND n.rowid > ? ORDER BY n.rowid LIMIT ?",
    ).bind(expiryCutoff(now), Number(raw ?? 0), PAGE).all();
    const pending = results.map((r) => ({ id: r.id, submission: r.submission, path: r.path, note: r.note,
      received: r.created }));
    return json({ pending, next_after: results.length === PAGE ? results.at(-1).seq : null });
  } catch {
    return unavailable("pending notes are unavailable right now; try again later");
  }
}
