// Starts Our Own Cause workflows on a timer, because GitHub's own schedules have not fired
// in that repository. The token can only start workflows (fine-grained, Actions: read and
// write, one repository). Each cron below starts one workflow, at the time its file states.
const REPO = "https://api.github.com/repos/nsdub/ourowncause/actions/workflows/";
const BY_CRON = {
  "*/10 * * * *": ["gateway.yml"],          // turn submissions into pull requests
  "*/15 * * * *": ["maintainer-review.yml", { trigger: "timer" }], // review, only when something changed
  "30 5 * * *": ["maintainer-questions.yml"], // daily question pages
  "0 9 * * 1": ["maintainer-issue.yml"],      // weekly issue
  "17 6 * * *": ["verify-main.yml"],          // daily signature check
};

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
    const entry = BY_CRON[event.cron];
    if (!entry) return console.log("no workflow for cron", event.cron);
    const [workflow, inputs] = entry;
    const result = await dispatch(env, workflow, inputs);
    if (!result.ok) console.log("dispatch failed", workflow, result.status, result.detail);
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
