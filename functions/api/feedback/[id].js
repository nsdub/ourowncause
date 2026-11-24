// GET /api/feedback/<id>: where a piece of feedback stands. `queued` until the gateway has
// opened its issue, then `open` or `closed` with the issue's address and the maintainers'
// latest comment. The issue is read from GitHub and cached: for good once it is closed, for
// 30 minutes while it is open and has a maintainer comment, for five minutes before that.
// When GitHub cannot be read, the last known state is served with `refreshed: false`.
import { CACHE_MS, expiryCutoff, githubJson, issueNumber, OPEN_CACHE_MS, readCache, readLedger,
  recordFeedbackFailure, recordIssue, writeCache } from "../../_lib/github.js";
import { error, json, methodNotAllowed, unavailable, withReadCors } from "../../_lib/notice.js";

const ID = /^[0-9a-f]{16}$/;
const BOT = "github-actions[bot]"; // the maintainers all comment as this account
const COMMENT_CHARS = 4_000;
const COMMENTS_PER_PAGE = 100;
const QUEUED = "No issue yet. The gateway opens one on a schedule: every 10 minutes when GitHub runs it "
  + "on time, often later. This page is the source of truth.";
const UNREADABLE = "GitHub could not be read just now, so this is the last known state. Try again in a few minutes.";
const NOT_REFRESHED = "GitHub could not be read just now, so the issue's state was not refreshed: "
  + "it may have been answered or closed since. Try again in a few minutes.";
const FAILED = "No issue was opened. The gateway gave up after 3 attempts:";
const EXPIRED = "No issue was opened within 14 days, so this feedback has expired. Send it again.";

const NONE = { issue_url: null, maintainer_comment: null };
const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const cacheKey = (id) => `feedback:${id}`; // status_cache is shared with submissions

// A closed issue is not asked about again. An open one is asked about every five minutes
// until a maintainer has commented: that answer is what the sender is waiting for.
function keepFor(value) {
  if (value.state === "closed") return Infinity;
  return value.state === "open" && value.maintainer_comment ? OPEN_CACHE_MS : CACHE_MS;
}

// {state, issue_url, maintainer_comment, note?} from the ledger and GitHub. Throws when
// either cannot be read.
async function lookUp(db, id, row) {
  let url = row.issue;
  if (!url) {
    const { feedback } = await readLedger();
    const done = feedback.done.find((entry) => entry.id === id);
    const failed = feedback.failed.find((entry) => entry.id === id);
    if (done) {
      url = done.issue;
      await recordIssue(db, id, url).catch(() => {});
    } else if (failed) {
      await recordFeedbackFailure(db, id, failed.reason).catch(() => {});
      return { ...NONE, state: "failed", note: `${FAILED} ${failed.reason}`.trim() };
    } else {
      return { ...NONE, state: "queued", note: QUEUED };
    }
  }
  const number = issueNumber(url);
  const issue = number === null ? null : await githubJson(`/issues/${number}`);
  if (issue === null || typeof issue !== "object") throw new Error("unexpected answer");

  let comment = null;
  const count = Number(issue.comments) || 0;
  if (count > 0) {
    // The latest comments are on the last page.
    const page = Math.ceil(count / COMMENTS_PER_PAGE);
    const comments = await githubJson(`/issues/${number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("unexpected answer");
    const ours = comments.filter((c) => c && c.user && c.user.login === BOT && typeof c.body === "string");
    if (ours.length) comment = { at: String(ours.at(-1).created_at), body: cut(ours.at(-1).body, COMMENT_CHARS) };
  }
  return { state: issue.state === "closed" ? "closed" : "open", issue_url: url, maintainer_comment: comment };
}

async function handle(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  const id = context.params && context.params.id;
  if (typeof id !== "string" || !ID.test(id)) {
    return error(400, "a feedback id is 16 characters, 0-9 and a-f, as given in the receipt");
  }

  const db = context.env && context.env.DB;
  let row;
  let cached;
  try {
    if (!db) throw new Error("no DB binding");
    row = await db.prepare("SELECT created, kind, title, issue, state, reason FROM feedback WHERE id = ?")
      .bind(id).first();
    if (row) cached = await readCache(db, cacheKey(id), Date.now(), keepFor);
  } catch {
    return unavailable("feedback status is unavailable right now; try again later");
  }
  if (!row) return error(404, "no feedback has this id");

  // Terminal states are the site's own knowledge; GitHub is not asked about them.
  let status = null;
  if (row.state === "failed") {
    status = { ...NONE, state: "failed", note: `${FAILED} ${row.reason ?? ""}`.trim() };
  } else if (!row.issue && row.created < expiryCutoff()) {
    status = { ...NONE, state: "expired", note: EXPIRED };
  } else if (cached.fresh && (cached.value.issue_url || !row.issue)) {
    status = cached.value; // a cached "no issue yet" does not outlive a recorded one
  }
  if (!status) {
    try {
      status = await lookUp(db, id, row);
      // The page is still right when this write fails; the next request looks again.
      await writeCache(db, cacheKey(id), status).catch(() => {});
    } catch {
      // The last known state. An issue the site has recorded is at least open.
      status = { state: "queued", ...NONE, ...cached.value };
      if (!status.issue_url && row.issue) status = { ...status, state: "open", issue_url: row.issue };
      status = { ...status, note: status.issue_url ? NOT_REFRESHED : UNREADABLE, refreshed: false };
    }
  }

  return json({
    id,
    state: status.state,
    issue_url: status.issue_url,
    maintainer_comment: status.maintainer_comment,
    kind: row.kind,
    title: row.title,
    received: row.created,
    ...(status.note ? { note: status.note } : {}),
    ...(status.refreshed === false ? { refreshed: false } : {}),
  });
}

export const onRequest = withReadCors(handle, "GET");
