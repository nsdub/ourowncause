// Starts Our Own Cause workflows on a timer, because GitHub's own schedules have not fired
// in that repository. The token can only start workflows (fine-grained, Actions: read and
// write, one repository). Each cron below starts one workflow, at the time its file states.
const REPO = "https://api.github.com/repos/nsdub/ourowncause/actions/workflows/";
const BY_CRON = {
  "*/10 * * * *": "gateway.yml",            // turn submissions into pull requests
  "30 5 * * *": "maintainer-questions.yml", // daily question pages
  "0 9 * * 1": "maintainer-issue.yml",      // weekly issue
  "17 6 * * *": "verify-main.yml",          // daily signature check
};

export async function dispatch(env, workflow) {
  if (!env.GITHUB_TOKEN) return { ok: false, status: 0, detail: "GITHUB_TOKEN is not set" };
  const r = await fetch(REPO + workflow + "/dispatches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ourowncause-timer",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  return { ok: r.status === 204, status: r.status, detail: r.status === 204 ? "" : (await r.text()).slice(0, 300) };
}

export default {
  async scheduled(event, env) {
    const workflow = BY_CRON[event.cron];
    if (!workflow) return console.log("no workflow for cron", event.cron);
    const result = await dispatch(env, workflow);
    if (!result.ok) console.log("dispatch failed", workflow, result.status, result.detail);
  },
  async fetch() {
    return new Response("Our Own Cause timer: starts the site's workflows on schedule.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
