// Reads of the repository's public pull requests, without credentials. Nothing about the
// requester is sent: the only variable in a request is a submission id.

export const REPO = "nsdub/ourowncause";
export const CACHE_MS = 5 * 60_000;
const API = `https://api.github.com/repos/${REPO}`;
const TIMEOUT_MS = 5_000;
const GATEWAY_REF = /^gateway\/([0-9a-f]{16})$/;

// The JSON at `path` under the repository's API, or null when GitHub answers 404 (as it
// does for every path while the repository is not public). Throws on any other failure.
export async function githubJson(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ourowncause.com" },
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

export async function readCache(db, id, now = Date.now()) {
  const row = await db.prepare("SELECT fetched, json FROM status_cache WHERE id = ?").bind(id).first();
  if (!row) return { fresh: false, value: null };
  let value = null;
  try {
    value = JSON.parse(row.json);
  } catch {
    // An unreadable row is the same as no row.
  }
  return { fresh: value !== null && now - Date.parse(row.fetched) < CACHE_MS, value };
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
