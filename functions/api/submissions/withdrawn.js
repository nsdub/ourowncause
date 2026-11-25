// GET /api/submissions/withdrawn: submissions their authors withdrew in the last 14 days,
// oldest first, at most 100 a page. The gateway workflow reads this list to close the pull
// request of a submission that was withdrawn after one was opened; ?after=<next_after>
// continues it. Only ids and times are listed.
import { expiryCutoff } from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

const PAGE = 100;

export async function onRequest(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  const raw = new URL(context.request.url).searchParams.get("after");
  if (raw !== null && !/^\d{1,15}$/.test(raw)) {
    return error(400, "after must be the next_after value of the previous page");
  }
  try {
    const db = context.env && context.env.DB;
    if (!db) throw new Error("no DB binding");
    const { results } = await db.prepare(
      "SELECT rowid AS seq, id, withdrawn FROM submissions "
      + "WHERE state = 'withdrawn' AND withdrawn >= ? AND rowid > ? ORDER BY rowid LIMIT ?",
    ).bind(expiryCutoff(), Number(raw ?? 0), PAGE).all();
    const pending = results.map((r) => ({ id: r.id, withdrawn_at: r.withdrawn }));
    return json({ pending, next_after: results.length === PAGE ? results.at(-1).seq : null });
  } catch {
    return unavailable("withdrawn submissions are unavailable right now; try again later");
  }
}
