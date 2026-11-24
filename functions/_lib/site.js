// What the static site already publishes, read through the ASSETS binding and cached for the
// life of the isolate. A new deployment starts new isolates, so the cache never outlives a build.

const QUESTION_ID = /^q-\d{1,6}$/;

let indexCache = null;
const confirmedQuestions = new Set();

export function resetSiteCache() {
  indexCache = null;
  confirmedQuestions.clear();
}

async function fetchJson(context, path) {
  const response = await context.env.ASSETS.fetch(new URL(path, context.request.url));
  if (!response.ok) throw new Error(`${path}: status ${response.status}`);
  return response.json();
}

// Entries of /index.json that have a slug. Throws when the index cannot be read.
export async function loadIndex(context) {
  if (indexCache) return indexCache;
  const data = await fetchJson(context, "/index.json");
  if (!Array.isArray(data)) throw new Error("/index.json is not a list");
  indexCache = data.filter((e) => e && typeof e === "object" && typeof e.slug === "string");
  return indexCache;
}

// True when the site publishes /questions/<id>/index.json for this id. Pages answers an
// unknown path with the home page and a 200, so the file's own `question` field is the proof.
export async function questionExists(context, id) {
  if (typeof id !== "string" || !QUESTION_ID.test(id)) return false;
  if (confirmedQuestions.has(id)) return true;
  try {
    const data = await fetchJson(context, `/questions/${id}/index.json`);
    if (!data || data.question !== id) return false;
  } catch {
    return false;
  }
  confirmedQuestions.add(id);
  return true;
}
