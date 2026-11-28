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

// Cloudflare Pages sometimes fails a production build on its own side ("build failed to
// initialize in time", "unable to submit build job"), and the site then stays on an older
// build. Every 15 minutes this compares the newest commit on main with the time the live site
// was built (active.json's built_at). If main is newer and that commit is between 12 minutes
// and 6 hours old, it calls the project's deploy hook (PAGES_DEPLOY_HOOK, a Worker secret),
// which rebuilds main. A normal build finishes well inside 12 minutes, so a healthy site is
// never rebuilt twice; a commit is retried at most about 23 times, then left for a person.
export function shouldRebuild(commitIso, builtIso, nowMs) {
  const commit = Date.parse(commitIso), built = Date.parse(builtIso);
  if (!Number.isFinite(commit) || !Number.isFinite(built)) return false;
  const age = nowMs - commit;
  return commit > built && age > 12 * 60_000 && age < 6 * 3600_000;
}

async function rebuildIfBehind(env, nowMs) {
  if (!env.PAGES_DEPLOY_HOOK) return;
  const gh = { accept: "application/vnd.github+json", "user-agent": "ourowncause-timer" };
  if (env.GITHUB_TOKEN) gh.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const [c, a] = await Promise.all([
    fetch("https://api.github.com/repos/nsdub/ourowncause/commits/main", { headers: gh }),
    fetch("https://ourowncause.com/active.json", { cf: { cacheTtl: 0 } }),
  ]);
  if (!c.ok || !a.ok) return console.log("rebuild check skipped", c.status, a.status);
  const commit = (await c.json()).commit;
  const built = (await a.json()).built_at;
  const when = commit && commit.committer && commit.committer.date;
  if (shouldRebuild(when, built, nowMs)) {
    const r = await fetch(env.PAGES_DEPLOY_HOOK, { method: "POST" });
    console.log("site behind main; deploy hook", r.status, when, built);
  }
}

// The human edition (docs/push-channel.md): every 5 minutes from 15:00 to 15:55 UTC each day,
// ask the site to hand the newest edition to Buttondown, which sends it. The site sends each
// edition once and nothing older than 7 days, so a day with nothing to send costs 12 short
// requests. Nothing happens until the host sets EDITION_SEND_TOKEN, here and on the site, with
// the same value.
export const editionDue = (date) => date.getUTCHours() === 15 && date.getUTCMinutes() % 5 === 0;

async function sendEdition(env) {
  if (!env.EDITION_SEND_TOKEN) return;
  const r = await fetch("https://ourowncause.com/api/edition/send", {
    method: "POST", headers: { authorization: `Bearer ${env.EDITION_SEND_TOKEN}`, "user-agent": "ourowncause-timer" },
  });
  const body = await r.text();
  if (!r.ok || body.includes('"state":"sent"')) console.log("edition send", r.status, body.slice(0, 300));
}

export default {
  async scheduled(event, env) {
    const now = new Date(event.scheduledTime);
    if (editionDue(now)) {
      try { await sendEdition(env); } catch (e) { console.log("edition send error", String(e)); }
    }
    if (now.getUTCMinutes() % 15 === 0) {
      try { await rebuildIfBehind(env, now.getTime()); } catch (e) { console.log("rebuild check error", String(e)); }
    }
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
