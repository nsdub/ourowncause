// POST /api/routine/runs with {"version", "cadence", "outcome"}: counts one run of our
// contributor routine, for a routine whose installer enabled counting. Opt-in and anonymous: we
// keep a count per day of the three values and store nothing else, not the address, the user
// agent or any identifier. GET /api/routine/stats gives the counts. docs/push-channel.md says why.
// Same-origin, like the other routes that store, so a page a visitor opens cannot count runs.
import { utcDay } from "../../_lib/db.js";
import { error, json, methodNotAllowed, unavailable } from "../../_lib/notice.js";
import { addRun, CADENCES, OUTCOMES, VERSION, writeRuns } from "../../_lib/routine.js";
import { BadRequest, NOT_JSON, readJsonBody, saysJson } from "../../_lib/submission.js";

const FORM = '{"version": "v1", "cadence": "daily" | "weekly" | "other", "outcome": "submitted" | "drafted" | "nothing"}';
const MAX_BYTES = 1_000;

export async function onRequest(context) {
  if (context.request.method !== "POST") return methodNotAllowed("POST");
  if (!saysJson(context.request)) return error(415, NOT_JSON);
  let body;
  try {
    body = await readJsonBody(context.request, FORM, MAX_BYTES, `request body too large: the form is ${FORM}`);
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    throw e;
  }
  const extra = Object.keys(body).filter((k) => !["version", "cadence", "outcome"].includes(k));
  if (extra.length) return error(400, `only version, cadence and outcome are accepted; we store nothing else (got ${extra.slice(0, 3).join(", ")})`);
  const { version, cadence, outcome } = body;
  if (typeof version !== "string" || !VERSION.test(version)) return error(400, `"version" must be a routine version such as v1`);
  if (!CADENCES.includes(cadence)) return error(400, `"cadence" must be one of ${CADENCES.join(", ")}`);
  if (!OUTCOMES.includes(outcome)) return error(400, `"outcome" must be one of ${OUTCOMES.join(", ")}`);
  const db = context.env && context.env.STATS;
  if (!db) return unavailable("run counts are unavailable right now; nothing was stored");
  const due = addRun({ day: utcDay(), version, cadence, outcome }, Date.now());
  // A D1 outage loses these counts and nothing else.
  if (due) context.waitUntil(writeRuns(db, due).catch(() => {}));
  return json({ counted: true, stored: { version, cadence, outcome },
    note: "We keep a count per day of these three values and nothing else. The counts are at https://ourowncause.com/api/routine/stats." }, 202);
}
