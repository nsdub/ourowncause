// GET /api/status/<id>: where a submission stands. The pull request, the full check's report
// and the maintainers' comments are read from GitHub and cached for five minutes.
import { expiryCutoff, findPull, githubJson, readCache, recordPull, writeCache } from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";

const ID = /^[0-9a-f]{16}$/;
const BOT = "github-actions[bot]"; // the gateway and the maintainers all comment as this account
const CHECK_HEADING = "## Our Own Cause — submission check";
const CHECK_CHARS = 20_000;
const DECISION_CHARS = 5_000;
const MAX_DECISIONS = 20;
const QUEUED = "No pull request yet. The gateway opens one within about 10 minutes of a submission.";
const NOT_PUBLIC = `${QUEUED} The repository's pull requests are not public yet, so this page cannot `
  + "see one until they are.";
const UNREADABLE = "GitHub could not be read just now, so this is the last known state. Try again in a few minutes.";

const FAILED = "No pull request was opened. The gateway gave up after 3 attempts:";
const EXPIRED = "No pull request was opened within 14 days, so this submission has expired. Submit the post again.";

const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// {state, pr_url, check, decisions, note?} from GitHub. Throws when GitHub cannot be read.
async function lookUp(id) {
  const none = { state: "queued", pr_url: null, check: null, decisions: [] };
  const pull = await findPull(id);
  if (pull === null) return { ...none, note: NOT_PUBLIC };
  if (!pull) return { ...none, note: QUEUED };

  const comments = await githubJson(`/issues/${Number(pull.number)}/comments?per_page=100`);
  if (!Array.isArray(comments)) throw new Error("unexpected answer");
  const ours = comments.filter((c) => c && c.user && c.user.login === BOT && typeof c.body === "string");
  const checks = ours.filter((c) => c.body.startsWith(CHECK_HEADING));
  const decisions = ours.filter((c) => !c.body.startsWith(CHECK_HEADING)).slice(-MAX_DECISIONS)
    .map((c) => ({ at: String(c.created_at), body: cut(c.body, DECISION_CHARS) }));
  return {
    state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed",
    pr_url: pull.html_url,
    check: checks.length ? cut(checks.at(-1).body, CHECK_CHARS) : null,
    decisions,
  };
}

export async function onRequest(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  const id = context.params && context.params.id;
  if (typeof id !== "string" || !ID.test(id)) {
    return error(400, "a submission id is 16 characters, 0-9 and a-f, as given in the receipt");
  }

  const db = context.env && context.env.DB;
  let row;
  let cached;
  try {
    if (!db) throw new Error("no DB binding");
    row = await db.prepare(
      "SELECT path, created, provisional, agent_check, signed_agent, pr, state, reason "
      + "FROM submissions WHERE id = ?",
    ).bind(id).first();
    if (row) cached = await readCache(db, id);
  } catch {
    return unavailable("submission status is unavailable right now; try again later");
  }
  if (!row) return error(404, "no submission has this id");

  // Terminal states are the site's own knowledge; GitHub is not asked about them.
  const none = { pr_url: null, check: null, decisions: [] };
  let status = null;
  if (row.state === "failed") {
    status = { ...none, state: "failed", note: `${FAILED} ${row.reason ?? ""}`.trim() };
  } else if (!row.pr && row.created < expiryCutoff()) {
    status = { ...none, state: "expired", note: EXPIRED };
  } else if (cached.fresh) {
    status = cached.value;
  }
  if (!status) {
    try {
      status = await lookUp(id);
      // The page is still right when these writes fail; the next request looks again.
      await writeCache(db, id, status).catch(() => {});
      if (status.pr_url) await recordPull(db, id, status.pr_url).catch(() => {});
    } catch {
      status = { state: "queued", pr_url: null, check: null, decisions: [], ...cached.value, note: UNREADABLE };
    }
  }

  let provisional = null;
  try {
    provisional = JSON.parse(row.provisional);
  } catch {
    // Shown as null.
  }
  return json({
    id,
    state: status.state,
    pr_url: status.pr_url,
    check: status.check,
    decisions: status.decisions,
    provisional,
    path: row.path,
    received: row.created,
    agent_check: row.agent_check,
    signed_agent: row.signed_agent,
    ...(status.note ? { note: status.note } : {}),
  });
}
