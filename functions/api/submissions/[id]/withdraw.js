// POST /api/submissions/<id>/withdraw with {"author_code": "<from the receipt>"}: withdraws
// a submission before publication. It is marked withdrawn here, so the pending list drops
// it and the gateway opens no pull request; a pull request the gateway already opened is
// closed by the gateway on its next run. A published piece is never removed this way: the
// answer is then 409, and an author's note (POST /api/submissions/<id>/note) is the route.
import { pullState, readAuthorRequest, statusUrl } from "../../../_lib/author.js";
import { kickGateway } from "../../../_lib/kick.js";
import { error, json, unavailable } from "../../../_lib/notice.js";

const MAX_REQUEST_BYTES = 2_000;
const FORM = '{"author_code": "<the author_code from the receipt>"}';
const TOO_LARGE = `request body too large: the limit is ${MAX_REQUEST_BYTES} bytes`;
export const PUBLISHED = "this piece is published, and published pieces are not removed by their authors: "
  + "a published piece cannot be quietly made to disappear. An author's note is the route: "
  + "POST /api/submissions/<id>/note adds a public, dated note under the piece and removes nothing";
const UNCONFIRMED = "GitHub could not be read just now, so we could not confirm that this piece is "
  + "unpublished, and nothing was changed. Try again in a few minutes.";
const NEXT = "This submission is withdrawn: it is no longer waiting for a pull request. If the gateway had "
  + "already opened one, the gateway closes it on its next run with the comment \"Withdrawn by its author "
  + "before publication.\" The status_url shows the state withdrawn.";

export async function onRequest(context) {
  const read = await readAuthorRequest(context, FORM, MAX_REQUEST_BYTES, TOO_LARGE);
  if (read.response) return read.response;
  const { db, id, row } = read;
  const answer = (withdrawn, extra = {}) => json({ id, state: "withdrawn", withdrawn_at: withdrawn,
    status_url: statusUrl(id), ...extra, next: NEXT });
  if (row.state === "withdrawn") return answer(row.withdrawn, { already: true });

  let state;
  try {
    state = await pullState(db, id);
  } catch {
    return unavailable(UNCONFIRMED);
  }
  if (state === "merged") return error(409, PUBLISHED, { state: "merged", status_url: statusUrl(id) });

  const now = new Date().toISOString();
  try {
    await db.prepare("UPDATE submissions SET state = 'withdrawn', withdrawn = ?, reason = NULL WHERE id = ?")
      .bind(now, id).run();
  } catch {
    return unavailable("the withdrawal cannot be stored right now; try again later");
  }
  kickGateway(context);
  return answer(now);
}
