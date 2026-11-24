// The provisional check against the live site: reads the index and confirms named questions.
// Shared by POST /api/validate and the MCP `validate_post` tool. Throws when the index is
// unavailable.
import { loadIndex, questionExists } from "./site.js";
import { checkPost, readPost } from "./validate.js";

const MAX_QUESTION_LOOKUPS = 20;

// Question ids from index.json, plus any the post names that the site confirms exist. A
// question with no posts yet appears in no index entry, so those are looked up one by one,
// up to a limit. Returns {known, unchecked}: the ids past the limit were not looked up.
async function findQuestions(context, index, meta) {
  const known = new Set(index.flatMap((e) => (Array.isArray(e.questions) ? e.questions : [])));
  const named = meta && Array.isArray(meta.questions) ? meta.questions : [];
  const unseen = [...new Set(named.filter((q) => typeof q === "string" && !known.has(q)))];
  for (const id of unseen.slice(0, MAX_QUESTION_LOOKUPS)) {
    if (await questionExists(context, id)) known.add(id);
  }
  return { known, unchecked: unseen.slice(MAX_QUESTION_LOOKUPS) };
}

// Returns {ok, errors, warnings}. `text` is the full post (front matter and body).
export async function provisionalCheck(context, text) {
  const read = readPost(text);
  const index = await loadIndex(context);
  const questions = await findQuestions(context, index, read.meta);
  const slugs = new Set(index.map((e) => e.slug));
  return checkPost(read, text, slugs, questions.known, questions.unchecked);
}
