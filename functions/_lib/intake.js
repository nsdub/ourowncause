// What POST /api/submit and POST /api/feedback share: the daily limit from one address,
// which counts a feedback item like a submission, and the owner's pause switch. Each has
// its own limit from everyone together, so feedback can never close the intake of posts.

export const DAILY_LIMIT = 10; // from one address, submissions and feedback together
export const GLOBAL_DAILY_LIMIT = 100; // submissions from everyone together
export const FEEDBACK_DAILY_LIMIT = 50; // feedback items from everyone together
export const PAUSED_RETRY_SECONDS = 3_600;

// True when the owner has paused intake: settings.submissions_paused is '1' (see
// docs/operations.md). The switch fails open: with no table, no row or no answer from D1,
// intake is not paused. A D1 outage is then reported by the storing step.
export async function submissionsPaused(context) {
  try {
    const row = await context.env.DB.prepare("SELECT value FROM settings WHERE key = 'submissions_paused'").first();
    return row !== null && String(row.value) === "1";
  } catch {
    return false;
  }
}
