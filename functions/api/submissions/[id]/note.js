// POST /api/submissions/<id>/note with {"author_code": "<from the receipt>", "note": "<text>"}:
// adds an author's note to a published piece. The note is stored with its time; the gateway
// then opens a pull request, labelled author-note, that appends it to the post's front
// matter as author_notes: [{date, text}]. It adds to the piece and removes nothing: the
// body and earlier notes are never edited. At most 3 notes per piece.
import { pullState, readAuthorRequest, statusUrl } from "../../../_lib/author.js";
import { utcDay } from "../../../_lib/db.js";
import { kickGateway } from "../../../_lib/kick.js";
import { error, json, unavailable } from "../../../_lib/notice.js";
import { hex } from "../../../_lib/ratelimit.js";
import { controlCharacterError } from "../../../_lib/validate.js";

export const NOTE_CHARS = 1_000;
export const MAX_NOTES = 3;
// JSON can spend twelve bytes on one character (an escaped surrogate pair).
const MAX_REQUEST_BYTES = 12 * NOTE_CHARS + 1_000;
const FORM = '{"author_code": "<the author_code from the receipt>", "note": "<text>"}';
const TOO_LARGE = `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes, `
  + `and "note" may be at most ${NOTE_CHARS} characters`;
const NOT_PUBLISHED = "an author's note is added to a published piece, and this one is not published. "
  + "Before publication, POST /api/submissions/<id>/withdraw withdraws it, and a revision is a new "
  + "submission that names this id in \"supersedes\"";
const WITHDRAWN = "this submission was withdrawn before publication, so there is no piece to add a note to";
const FULL = `a piece carries at most ${MAX_NOTES} author's notes, and this one has ${MAX_NOTES}`;
const UNCONFIRMED = "GitHub could not be read just now, so we could not confirm that this piece is "
  + "published, and nothing was stored. Try again in a few minutes.";
const NEXT = "The gateway opens a pull request, labelled author-note, that appends this note to the post's "
  + "front matter under author_notes, on a schedule: every 10 minutes when GitHub runs it on time, often "
  + "later. Maintainers review it like any change. Once merged and built, the note is shown on the post's "
  + "page under \"Later notes sent with the author code\", with its date. The piece itself is not changed.";

const chars = (text) => [...text].length;

function noteErrors(note) {
  if (typeof note !== "string" || !note.trim()) return ['"note" is required: the text of the note'];
  const errors = [];
  if (chars(note) > NOTE_CHARS) errors.push(`"note" must be at most ${NOTE_CHARS} characters`);
  // A lone surrogate cannot be written as UTF-8, so the note could never become part of a file.
  if (/[\uD800-\uDFFF]/u.test(note)) errors.push('"note" is not valid Unicode text');
  const control = controlCharacterError("", { note });
  if (control) errors.push(control);
  return errors;
}

export async function onRequest(context) {
  const read = await readAuthorRequest(context, FORM, MAX_REQUEST_BYTES, TOO_LARGE);
  if (read.response) return read.response;
  const { db, id, data, row } = read;
  const errors = noteErrors(data.note);
  if (errors.length) return json({ ok: false, errors }, 422);
  const note = data.note;
  if (row.state === "withdrawn") return error(409, WITHDRAWN, { state: "withdrawn" });

  let state;
  try {
    state = await pullState(db, id);
  } catch {
    return unavailable(UNCONFIRMED);
  }
  if (state !== "merged") return error(409, NOT_PUBLISHED, { status_url: statusUrl(id) });

  const now = new Date();
  const noteId = hex(crypto.getRandomValues(new Uint8Array(8)));
  const receipt = (nid, created, extra = {}) => ({ id: nid, submission: id, date: utcDay(0, Date.parse(created)),
    received: created, status_url: statusUrl(id), ...extra });
  try {
    // A note the gateway gave up on does not count: sending it again is a fresh attempt.
    const { results } = await db.prepare(
      "SELECT id, created, note FROM author_notes WHERE submission = ? AND state IS NOT 'failed' ORDER BY rowid",
    ).bind(id).all();
    const same = results.find((r) => r.note === note);
    if (same) {
      return json(receipt(same.id, same.created,
        { duplicate: true, next: "This note was already received; this is its receipt." }));
    }
    if (results.length >= MAX_NOTES) return error(409, FULL, { status_url: statusUrl(id) });
    await db.prepare("INSERT INTO author_notes (id, submission, created, note) VALUES (?, ?, ?, ?)")
      .bind(noteId, id, now.toISOString(), note).run();
  } catch {
    return unavailable("the note cannot be stored right now; try again later");
  }
  kickGateway(context);
  return json(receipt(noteId, now.toISOString(), { next: NEXT }), 201);
}
