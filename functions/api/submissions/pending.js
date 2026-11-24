// GET /api/submissions/pending: submissions with no pull request yet, oldest first, 20 at a
// time. The gateway workflow reads this list; ?after=<next_after> continues it.
import { githubJson, readCache, recordPull, submissionOf, writeCache } from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

const PAGE = 20;
const RECENT = "/pulls?state=all&sort=created&direction=desc&per_page=100";
const SEEN_KEY = "pulls"; // the status_cache row that says when GitHub was last asked

// Marks the submissions whose pull requests GitHub lists, at most once in five minutes.
// A submission stays pending until this sees its pull request; the gateway opens none twice.
async function recordRecentPulls(db) {
  if ((await readCache(db, SEEN_KEY)).fresh) return;
  await writeCache(db, SEEN_KEY, {});
  const pulls = await githubJson(RECENT);
  if (!Array.isArray(pulls)) return;
  for (const pull of pulls) {
    const id = submissionOf(pull);
    if (id) await recordPull(db, id, pull.html_url);
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
    await recordRecentPulls(db).catch(() => {}); // the list is served with or without GitHub
    const { results } = await db.prepare(
      "SELECT rowid AS seq, id, path, body, created, agent_check, signed_agent FROM submissions "
      + "WHERE pr IS NULL AND rowid > ? ORDER BY rowid LIMIT ?",
    ).bind(Number(raw ?? 0), PAGE).all();
    return json({
      pending: results.map((r) => ({
        id: r.id, path: r.path, body: r.body, received: r.created,
        agent_check: r.agent_check, signed_agent: r.signed_agent,
      })),
      next_after: results.length === PAGE ? results[PAGE - 1].seq : null,
    });
  } catch {
    return unavailable("pending submissions are unavailable right now; try again later");
  }
}
