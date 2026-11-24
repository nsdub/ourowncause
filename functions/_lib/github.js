// Reads of the repository's public pull requests and of the gateway's ledger, without
// credentials. Nothing about the requester is sent: the only variable in a request is a
// submission id.
//
// GitHub's API allows 60 requests an hour from one address without a token, and Cloudflare's
// addresses are shared. So the API is asked only for the state of a pull request, and each
// answer is kept: a merged or closed pull request for good, an open one that has its check
// report for 30 minutes, anything else for five. The ledger is read from raw.githubusercontent.com, which that
// limit does not cover.

export const REPO = "nsdub/ourowncause";
export const CACHE_MS = 5 * 60_000;
export const OPEN_CACHE_MS = 30 * 60_000;
const API = `https://api.github.com/repos/${REPO}`;
export const LEDGER_URL = `https://raw.githubusercontent.com/${REPO}/gateway-state/state.json`;
const TIMEOUT_MS = 5_000;
const GATEWAY_REF = /^gateway\/([0-9a-f]{16})$/;

// The JSON at `path` under the repository's API, or null when GitHub answers 404 (as it
// does for every path while the repository is not public). Throws on any other failure.
export async function githubJson(path) {
  return fetchJson(`${API}${path}`, "application/vnd.github+json");
}

async function fetchJson(url, accept) {
  const response = await fetch(url, {
    headers: { accept, "user-agent": "ourowncause.com" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

// The submission id a pull request was opened for, or null. Only a branch of this repository
// counts: anyone can open a pull request from a fork with a branch named gateway/<id>.
export function submissionOf(pull) {
  const head = pull && typeof pull === "object" ? pull.head : null;
  if (!head || typeof head.ref !== "string" || !head.repo) return null;
  if (String(head.repo.full_name).toLowerCase() !== REPO) return null;
  const match = GATEWAY_REF.exec(head.ref);
  return match && typeof pull.html_url === "string" ? match[1] : null;
}

// The pull request opened for submission `id`, or undefined. `null` when GitHub answers 404.
export async function findPull(id) {
  const query = new URLSearchParams({ head: `${REPO.split("/")[0]}:gateway/${id}`, state: "all", per_page: "10" });
  const pulls = await githubJson(`/pulls?${query}`);
  if (pulls === null) return null;
  if (!Array.isArray(pulls)) throw new Error("unexpected answer");
  return pulls.find((p) => submissionOf(p) === id);
}

const PULL_URL = new RegExp(`^https://github\\.com/${REPO}/pull/[0-9]{1,9}$`);
const REASON_CHARS = 300;

// What the gateway workflow has recorded about each submission, from the state.json it keeps
// on the gateway-state branch: [{id, pr}] for those with a pull request and [{id, reason}]
// for those it gave up on. Only people who can push to the repository can write that file.
// A 404 (no ledger yet, or the repository is not public) is an empty ledger.
export async function readLedger() {
  const entries = await fetchJson(LEDGER_URL, "application/json");
  const done = [];
  const failed = [];
  if (entries === null) return { done, failed };
  if (typeof entries !== "object" || Array.isArray(entries)) throw new Error("unexpected ledger");
  for (const [id, entry] of Object.entries(entries)) {
    if (!/^[0-9a-f]{16}$/.test(id) || entry === null || typeof entry !== "object") continue;
    if (typeof entry.pr === "string" && PULL_URL.test(entry.pr)) {
      done.push({ id, pr: entry.pr }); // it has its pull request, whatever happened afterwards
    } else if (entry.state === "failed" && entry.pr === undefined) {
      failed.push({ id, reason: String(entry.reason ?? "").slice(0, REASON_CHARS) });
    }
  }
  return { done, failed };
}

// How long a cached value stands in for asking again. A merged or closed pull request does
// not change, so it is never asked about again. An open one is asked about every five
// minutes until the full check's report is on it: that report is what a submitter is
// waiting for, and it arrives minutes after the pull request does.
function keepFor(value) {
  if (value.state === "merged" || value.state === "closed") return Infinity;
  return value.state === "open" && typeof value.check === "string" ? OPEN_CACHE_MS : CACHE_MS;
}

// {fresh, value}. `keep` overrides how long the value counts as fresh.
export async function readCache(db, id, now = Date.now(), keep = null) {
  const row = await db.prepare("SELECT fetched, json FROM status_cache WHERE id = ?").bind(id).first();
  if (!row) return { fresh: false, value: null };
  let value = null;
  try {
    value = JSON.parse(row.json);
  } catch {
    // An unreadable row is the same as no row.
  }
  return { fresh: value !== null && now - Date.parse(row.fetched) < (keep ?? keepFor(value)), value };
}

export async function writeCache(db, id, value, now = Date.now()) {
  await db.prepare(
    "INSERT INTO status_cache (id, fetched, json) VALUES (?, ?, ?) "
    + "ON CONFLICT (id) DO UPDATE SET fetched = excluded.fetched, json = excluded.json",
  ).bind(id, new Date(now).toISOString(), JSON.stringify(value)).run();
}

export async function recordPull(db, id, url) {
  await db.prepare("UPDATE submissions SET pr = ? WHERE id = ? AND pr IS NULL").bind(url, id).run();
}

export async function recordFailure(db, id, reason) {
  await db.prepare("UPDATE submissions SET state = 'failed', reason = ? WHERE id = ? AND pr IS NULL AND state IS NULL")
    .bind(reason, id).run();
}

// A submission with no pull request this long after it was received has expired.
export const EXPIRY_MS = 14 * 86_400_000;
export const expiryCutoff = (now = Date.now()) => new Date(now - EXPIRY_MS).toISOString();
