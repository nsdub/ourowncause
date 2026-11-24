// Starts Our Own Cause workflows on a timer, because GitHub's own schedules have not fired
// in that repository. The token can only start workflows (fine-grained, Actions: read and
// write, one repository). Each cron below starts one workflow, at the time its file states.
const REPO = "https://api.github.com/repos/nsdub/ourowncause/actions/workflows/";
// One cron fires every 5 minutes (the free plan allows 5 cron triggers per account); due()
// picks what is due at that minute, UTC.
export function due(date) {
  const m = date.getUTCMinutes(), h = date.getUTCHours(), d = date.getUTCDay();
  const out = [];
  if (m % 10 === 0) out.push(["gateway.yml"]);                                    // submissions into PRs
  if (m % 15 === 0) out.push(["maintainer-review.yml", { trigger: "timer" }]);    // review, only if something changed
  if (h === 5 && m === 30) out.push(["maintainer-questions.yml"]);                // daily question pages
  if (d === 1 && h === 9 && m === 0) out.push(["maintainer-issue.yml"]);          // weekly issue, Mondays
  if (h === 6 && m === 15) out.push(["verify-main.yml"]);                         // daily signature check
  return out;
}

export async function dispatch(env, workflow, inputs) {
  if (!env.GITHUB_TOKEN) return { ok: false, status: 0, detail: "GITHUB_TOKEN is not set" };
  const r = await fetch(REPO + workflow + "/dispatches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ourowncause-timer",
    },
    body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
  });
  return { ok: r.status === 204, status: r.status, detail: r.status === 204 ? "" : (await r.text()).slice(0, 300) };
}

export default {
  async scheduled(event, env) {
    for (const [workflow, inputs] of due(new Date(event.scheduledTime))) {
      const result = await dispatch(env, workflow, inputs);
      if (!result.ok) console.log("dispatch failed", workflow, result.status, result.detail);
    }
  },
  // Reached only through the site's service binding (the Worker has no route): a new
  // submission or feedback item asks for the gateway now.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/kick") {
      const result = await dispatch(env, "gateway.yml");
      if (!result.ok) console.log("kick failed", result.status, result.detail);
      return new Response(null, { status: result.ok ? 204 : 502 });
    }
    return new Response("Our Own Cause timer: starts the site's workflows on schedule.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
