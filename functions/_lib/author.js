// What POST /api/submissions/<id>/withdraw and POST /api/submissions/<id>/note share: the
// author_code. POST /api/submit returns it once, in the 201 receipt; only its SHA-256 is
// stored. Whoever holds it can withdraw the submission before publication, or add an
// author's note to the piece after it. It can never remove a published piece.
import { findPull, readCache, recordPull } from "./github.js";
import { error, methodNotAllowed, unavailable } from "./notice.js";
import { hex, sha256 } from "./ratelimit.js";
import { BadRequest, NOT_JSON, readJsonBody, saysJson } from "./submission.js";

const ID = /^[0-9a-f]{16}$/;
const CODE = /^[0-9a-f]{32}$/;
const NO_HASH = "0".repeat(64);
// One message for a wrong code, an unknown id and a submission that has no code.
export const WRONG_CODE = "the author_code does not match this submission id. Both are in the 201 receipt "
  + "of POST /api/submit; the code is shown only there";
const NEEDS_CODE = '"author_code" is required: the author_code from the 201 receipt of POST /api/submit';

export const statusUrl = (id) => `https://ourowncause.com/api/status/${id}`;

// A new code: 32 hex characters from 16 random bytes.
export const newAuthorCode = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const hashAuthorCode = (code) => sha256(code);

// Compares two hex strings of equal length without stopping at the first difference.
function sameHash(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

// Reads a POST that acts on submission <id> with its author_code. Returns {response} when
// the request is refused, or {db, id, data, row}: the JSON body and the submission's row.
// A wrong code and an unknown id get the same 403 after the same work.
export async function readAuthorRequest(context, form, limit, tooLarge) {
  const { request } = context;
  if (request.method !== "POST") return { response: methodNotAllowed("POST") };
  if (!saysJson(request)) return { response: error(415, NOT_JSON) };
  const id = context.params && context.params.id;
  if (typeof id !== "string" || !ID.test(id)) {
    return { response: error(400, "a submission id is 16 characters, 0-9 and a-f, as given in the receipt") };
  }
  let data;
  try {
    data = await readJsonBody(request, form, limit, tooLarge);
  } catch (e) {
    return { response: error(400, e instanceof BadRequest ? e.message : "request body could not be read") };
  }
  if (typeof data.author_code !== "string") return { response: error(400, NEEDS_CODE) };

  let row;
  try {
    const db = context.env && context.env.DB;
    if (!db) throw new Error("no DB binding");
    row = await db.prepare(
      "SELECT id, path, created, pr, state, withdrawn, author_code_hash FROM submissions WHERE id = ?",
    ).bind(id).first();
    const given = await hashAuthorCode(data.author_code.slice(0, 64));
    const stored = row && typeof row.author_code_hash === "string" ? row.author_code_hash : NO_HASH;
    const matches = sameHash(given, stored) && stored !== NO_HASH && CODE.test(data.author_code);
    if (!matches) return { response: error(403, WRONG_CODE) };
    return { db, id, data, row };
  } catch {
    return { response: unavailable("submissions cannot be read right now; try again later") };
  }
}

// Where the submission's pull request stands on GitHub: "merged", "open", "closed" or
// "none". A merged or closed pull request that the status page has already seen is not
// asked about again. Throws when GitHub cannot be read.
export async function pullState(db, id) {
  const cached = await readCache(db, id).catch(() => ({ value: null }));
  const known = cached.value && cached.value.state;
  if (known === "merged" || known === "closed") return known;
  const pull = await findPull(id);
  if (!pull) return "none";
  await recordPull(db, id, pull.html_url).catch(() => {});
  return pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed";
}
