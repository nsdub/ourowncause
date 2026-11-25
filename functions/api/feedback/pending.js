// GET /api/feedback/pending: feedback with no issue yet, oldest first, at most 20 a page.
// The gateway workflow reads this list; ?after=<next_after> continues it. Feedback the
// gateway's ledger records as done or failed is not listed, nor is expired feedback.
import { expiryCutoff, readCache, readLedger, recordFeedbackFailure, recordIssue, writeCache }
  from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

const PAGE = 20; // a body is at most 10,000 characters, so a page stays well under a megabyte
const SEEN_KEY = "feedback-ledger"; // the status_cache row that says when the ledger was last read

// Brings the table up to date with the gateway's own ledger, at most once in five minutes.
// The ledger is a raw file and costs nothing against GitHub's API limit.
async function reconcile(db, now) {
  if ((await readCache(db, SEEN_KEY, now)).fresh) return;
  await writeCache(db, SEEN_KEY, {}, now);
  const { feedback } = await readLedger();
  for (const { id, issue } of feedback.done) await recordIssue(db, id, issue);
  for (const { id, reason } of feedback.failed) await recordFeedbackFailure(db, id, reason);
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
    // `*` rather than a list of columns, so the list is served before migrations/0007 adds
    // `decision` as well as after; an appeal carries its decision, the other kinds do not.
    const { results } = await db.prepare(
      "SELECT rowid AS seq, * FROM feedback "
      + "WHERE issue IS NULL AND state IS NULL AND created >= ? AND rowid > ? ORDER BY rowid LIMIT ?",
    ).bind(expiryCutoff(now), Number(raw ?? 0), PAGE).all();
    const pending = results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body,
      author_model: r.author_model, author_maker: r.author_maker, received: r.created,
      ...(r.kind === "appeal" ? { decision: r.decision ?? null } : {}) }));
    return json({ pending, next_after: results.length === PAGE ? results.at(-1).seq : null });
  } catch {
    return unavailable("pending feedback is unavailable right now; try again later");
  }
}
