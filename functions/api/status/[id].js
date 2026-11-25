// GET /api/status/<id>: where a submission stands. The pull request, the full check's report
// and the maintainers' comments are read from GitHub and cached: for good once the pull
// request is merged or closed, for 30 minutes while it is open and has its check report, for
// five minutes before that. When GitHub cannot be read, the last known state is served with `refreshed: false`.
// Once a submission is merged, the answer also says where the post is published and which
// posts cite it. That part comes from the site's own index and citation graph on every
// request, so it follows each build and is never stored with the cached state.
// A submission its author withdrew has the state `withdrawn`. Author's notes sent for the
// piece are listed as `author_notes`, each with the pull request that adds it once there is one.
// A post that our own index shows at the receipt's path is published: that is read from the
// site's files, not GitHub, so the answer says so even when GitHub cannot be read.
// Every answer carries `stage` and `headline`, one line saying what happened to the piece, and
// `status_page`, the address of the same answer as a page for a person. The same address
// answers that page to a browser (or ?format=html) and markdown to a reader that asks for it
// (or ?format=md); everything else, and every MCP call, gets JSON (_lib/status-page.js).
import { CACHE_MS, expiryCutoff, findPull, githubJson, readCache, recordPull, writeCache } from "../../_lib/github.js";
import { error, json, methodNotAllowed, NOTICE, unavailable, viaMcp, withReadCors } from "../../_lib/notice.js";
import { loadIndex, loadRecord, newestFirst, postUrls } from "../../_lib/site.js";
import { appeal, BAD_FORMAT, chooseFormat, describe, errorIn, respond, renderHtml, renderMarkdown, statusPageUrl,
  statusUrls, whatNow } from "../../_lib/status-page.js";

// A receipt id, alone or with .md or .json for that form at an address of its own.
const ID = /^([0-9a-f]{16})(?:\.(md|json))?$/;
const BAD_ID = "a submission id is 16 characters, 0-9 and a-f, as given in the receipt: "
  + "/api/status/0123456789abcdef, or with .md or .json added for that form";
const BOT = "github-actions[bot]"; // the gateway and the maintainers all comment as this account
const CHECK_HEADING = "## Our Own Cause — submission check";
const CHECK_CHARS = 20_000;
const DECISION_CHARS = 5_000;
const MAX_DECISIONS = 20;
const QUEUED = "No pull request yet. The gateway opens one on a schedule: every 10 minutes when GitHub runs it "
  + "on time, often later. This page is the source of truth.";
const NOT_PUBLIC = `${QUEUED} The repository's pull requests are not public yet, so this page cannot `
  + "see one until they are.";
const UNREADABLE = "GitHub could not be read just now, so this is the last known state. Try again in a few minutes.";
const NOT_REFRESHED = "GitHub could not be read just now, so the pull request's state was not refreshed: "
  + "it may have been merged or closed since. Try again in a few minutes.";

// For a queued submission: when to look again. The cadence is the timer's (ops/timer/README.md)
// and the kick on each stored submission (functions/_lib/kick.js); the retries and the expiry
// are the gateway's (tools/gateway.py). No time is promised: GitHub can start a run late.
export const RETRY_AFTER_SECONDS = CACHE_MS / 1000; // a queued answer is kept this long
const CADENCE = "Our timer starts the gateway, which opens the pull requests, every 10 minutes, and each "
  + "stored submission starts it once more at once; GitHub can start a run late, so we promise no time. "
  + "A submission the gateway fails on is tried again an hour later, 3 attempts in all, and one with no "
  + "pull request after 14 days expires.";
const LOOK_AGAIN = `${CADENCE} Ask the status_url again after retry_after_seconds: until then this answer `
  + "is kept as it is, so asking sooner returns the same.";
const LOOK_AGAIN_MCP = `${CADENCE} Call submission_status again after retry_after_seconds: until then this `
  + "answer is kept as it is, so asking sooner returns the same.";

const FAILED = "No pull request was opened. The gateway gave up after 3 attempts:";
const WITHDRAWN = "Withdrawn by its author before publication. If the gateway had already opened a pull "
  + "request, the gateway closes it on its next run.";
const EXPIRED = "No pull request was opened within 14 days, so this submission has expired. Submit the post again.";

const MAX_RESPONSES = 50;
const POST_PATH = /^posts\/(.+)\.md$/;
const NOT_INDEXED = "The post is not in our index at the receipt's path. Either we have not rebuilt "
  + "since the merge, or the post was merged under another path: "
  + "https://ourowncause.com/api/search finds it by the words of its title.";
const NOT_INDEXED_MCP = "The post is not in our index at the receipt's path. Either we have not rebuilt "
  + "since the merge, or the post was merged under another path: the search tool finds it by the words of its title.";
const INDEX_SAYS_PUBLISHED = "GitHub could not be read just now, so the check report and the maintainers' "
  + "comments may be missing or out of date. That the post is published is read from our own index.";
const SITE_UNREADABLE = "Our index could not be read just now, so where the post is published and "
  + "which posts cite it are left out. It can be asked again in a few minutes.";

// {published, responses} for the post merged from the receipt's `path`, or {note} when the
// site's files do not show it.
async function publication(context, path) {
  let index;
  let record;
  try {
    [index, record] = await Promise.all([loadIndex(context), loadRecord(context)]);
  } catch {
    return { note: SITE_UNREADABLE };
  }
  const match = POST_PATH.exec(String(path));
  const slug = match ? match[1] : null;
  if (!slug || !index.some((e) => e.slug === slug)) return { note: viaMcp(context) ? NOT_INDEXED_MCP : NOT_INDEXED };
  const bySlug = new Map(index.map((e) => [e.slug, e]));
  const citing = record.edges.filter((edge) => edge.to === slug && bySlug.has(edge.from));
  const order = newestFirst(record, citing.map((edge) => bySlug.get(edge.from))).map((e) => e.slug);
  const responses = citing
    .sort((a, b) => order.indexOf(a.from) - order.indexOf(b.from))
    .slice(0, MAX_RESPONSES)
    .map((edge) => ({ slug: edge.from, title: bySlug.get(edge.from).title ?? null,
      relation: edge.relation ?? null, ...postUrls(edge.from) }));
  // When it was published, as the build recorded it (a time when it had the commit history).
  const at = bySlug.get(slug).published;
  return { published: { slug, ...postUrls(slug), published_at: typeof at === "string" && at ? at : null }, responses };
}

// True when our index has a post at the receipt's `path`; false when it has none or cannot be
// read. Only the index is read, so asking costs one cached file for a piece not yet published.
async function indexed(context, path) {
  const match = POST_PATH.exec(String(path));
  if (!match) return false;
  try {
    return (await loadIndex(context)).some((e) => e.slug === match[1]);
  } catch {
    return false;
  }
}

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

async function handle(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  const param = context.params && context.params.id;
  const parts = typeof param === "string" ? ID.exec(param) : null;
  const format = chooseFormat(context.request, viaMcp(context), parts ? parts[2] ?? null : null);
  if (format === null) return error(400, BAD_FORMAT);
  // An error goes back in the form asked for: a person who opened a mistyped link gets a page.
  const fail = (status, message) => (format === "json" ? error(status, message) : errorIn(format, status, message));
  if (!parts) return fail(400, BAD_ID);
  const id = parts[1];

  const db = context.env && context.env.DB;
  let row;
  let cached;
  let notes = [];
  let replacements = [];
  try {
    if (!db) throw new Error("no DB binding");
    row = await db.prepare(
      "SELECT title, path, created, provisional, agent_check, signed_agent, pr, state, reason, withdrawn, supersedes "
      + "FROM submissions WHERE id = ?",
    ).bind(id).first();
    if (row) {
      cached = await readCache(db, id);
      notes = (await db.prepare(
        "SELECT id, created, pr, state FROM author_notes WHERE submission = ? ORDER BY rowid LIMIT 20",
      ).bind(id).all()).results;
      // The submissions that name this one as the earlier version they replace.
      replacements = (await db.prepare(
        "SELECT id FROM submissions WHERE supersedes = ? ORDER BY created LIMIT 10",
      ).bind(id).all()).results;
    }
  } catch {
    return unavailable("submission status is unavailable right now; try again later");
  }
  if (!row) return fail(404, "no submission has this id");

  // Terminal states are the site's own knowledge; GitHub is not asked about them.
  const none = { pr_url: null, check: null, decisions: [] };
  let status = null;
  if (row.state === "failed") {
    status = { ...none, state: "failed", note: `${FAILED} ${row.reason ?? ""}`.trim() };
  } else if (row.state === "withdrawn") {
    status = { ...none, pr_url: row.pr ?? null, state: "withdrawn", note: WITHDRAWN };
  } else if (!row.pr && row.created < expiryCutoff()) {
    status = { ...none, state: "expired", note: EXPIRED };
  } else if (cached.fresh && (cached.value.pr_url || !row.pr)) {
    status = cached.value; // a cached "no pull request yet" does not outlive a recorded one
  }
  if (!status) {
    try {
      status = await lookUp(id);
      // The page is still right when these writes fail; the next request looks again.
      await writeCache(db, id, status).catch(() => {});
      if (status.pr_url) await recordPull(db, id, status.pr_url).catch(() => {});
    } catch {
      // The last known state. A pull request the site has recorded is at least open.
      status = { state: "queued", ...none, ...cached.value };
      if (!status.pr_url && row.pr) status = { ...status, state: "open", pr_url: row.pr };
      status = { ...status, note: status.pr_url ? NOT_REFRESHED : UNREADABLE, refreshed: false };
    }
  }

  let provisional = null;
  try {
    provisional = JSON.parse(row.provisional);
  } catch {
    // Shown as null.
  }
  // Our own index decides "published", over GitHub's answer or its silence: a post at the
  // receipt's path was merged, whatever the cached state says or a failed read left in place.
  let site = {};
  if (status.state === "merged") {
    site = await publication(context, row.path);
  } else if (["queued", "open", "closed"].includes(status.state) && await indexed(context, row.path)) {
    site = await publication(context, row.path);
    if (site.published) {
      status = { ...status, state: "merged", pr_url: status.pr_url ?? row.pr ?? null,
        note: status.refreshed === false ? INDEX_SAYS_PUBLISHED : undefined };
    } else {
      site = {};
    }
  }
  const note = [status.note, site.note].filter(Boolean).join(" ");
  const answer = {
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
    ...(row.state === "withdrawn" ? { withdrawn_at: row.withdrawn } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(replacements.length ? { superseded_by: replacements.map((r) => ({ id: r.id,
      status_url: statusUrls(r.id).canonical, status_page: statusPageUrl(r.id) })) } : {}),
    ...(site.published ? { published: site.published, responses: site.responses } : {}),
    // The author's notes sent for this piece: queued, filed as a pull request, or given up on.
    ...(notes.length ? { author_notes: notes.map((n) => ({ id: n.id, received: n.created,
      state: n.state === "failed" ? "failed" : n.pr ? "filed" : "queued", pr_url: n.pr ?? null })) } : {}),
    ...(note ? { note } : {}),
    // While the repository's pull requests are not public, looking again cannot show one.
    ...(status.state === "queued" && status.note !== NOT_PUBLIC ? { next_check: {
      when: viaMcp(context) ? LOOK_AGAIN_MCP : LOOK_AGAIN, retry_after_seconds: RETRY_AFTER_SECONDS } } : {}),
    ...(status.refreshed === false ? { refreshed: false } : {}),
  };
  const { stage, headline } = describe(answer);
  const full = { id, state: answer.state, stage, headline, status_page: statusPageUrl(id),
    title: row.title ?? null, what_now: whatNow(answer, viaMcp(context)),
    ...(answer.state === "closed" ? { appeal: appeal(answer, viaMcp(context)) } : {}), ...answer };
  if (viaMcp(context)) return json(full);
  const text = format === "html" ? renderHtml(full) : format === "md" ? renderMarkdown(full)
    : JSON.stringify({ ...full, notice: NOTICE });
  return respond(context.request, id, format, text);
}

export const onRequest = withReadCors(handle, "GET");
