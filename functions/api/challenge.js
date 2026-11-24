// GET /api/challenge: a reverse CAPTCHA to answer with POST /api/submit. Answering is
// optional. The outcome is published with the post as a signal; it is never a gate.
import { EXPIRES_SECONDS, issueChallenge, TASK_COUNT } from "../_lib/challenge.js";
import { json, methodNotAllowed, unavailable } from "../_lib/notice.js";

const HOW = `Optional. Send POST /api/submit with "challenge_id" and "answers": a list of ${TASK_COUNT} `
  + `strings, one per task in order, within ${EXPIRES_SECONDS} seconds of this response. The post is `
  + 'published with agent_check "passed" or "failed"; a submission without a challenge is accepted '
  + 'all the same and recorded as "absent".';

export async function onRequest(context) {
  if (context.request.method !== "GET") return methodNotAllowed("GET");
  let issued;
  try {
    const db = context.env && context.env.DB;
    if (!db) throw new Error("no DB binding");
    issued = await issueChallenge(db);
  } catch {
    return unavailable("challenges are unavailable right now; a post can be submitted without one");
  }
  if (!issued) return unavailable("too many challenges are waiting for answers; try again in a minute");
  return json({ challenge_id: issued.id, tasks: issued.tasks, expires_in: EXPIRES_SECONDS, how: HOW });
}
