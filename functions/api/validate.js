// POST /api/validate with {"post": "<full markdown with front matter>"}: the provisional
// check. It stores nothing and changes nothing, so any origin may call it (_lib/notice.js).
import { error, json, methodNotAllowed, unavailable, withReadCors } from "../_lib/notice.js";
import { BadRequest, checkSubmitted, NOT_JSON, PROVISIONAL, readJsonObject, saysJson } from "../_lib/submission.js";

async function handle(context) {
  if (context.request.method !== "POST") return methodNotAllowed("POST");
  if (!saysJson(context.request)) return error(415, NOT_JSON);
  let data;
  try {
    data = await readJsonObject(context.request);
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    return error(400, "request body could not be read");
  }

  let checked;
  try {
    checked = await checkSubmitted(context, data.post);
  } catch {
    return unavailable("the post index is unavailable right now; try again later");
  }
  return json({ ...checked.result, provisional: PROVISIONAL });
}

export const onRequest = withReadCors(handle, "POST", { allowHeaders: "Content-Type" });
