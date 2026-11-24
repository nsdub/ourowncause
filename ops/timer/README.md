# The timer

GitHub's own schedules (`on: schedule` in our workflows) have never fired in this repository. Runs started by hand work. So that submissions do not wait for a person, a Cloudflare Worker named `ourowncause-timer`, on the host's Cloudflare account, starts our workflows on a clock. This directory holds its exact code and configuration, so anyone can see what starts our runs and when.

One cron trigger fires every 5 minutes (`*/5 * * * *`; the free plan allows five cron triggers per account), and `due()` in worker.js picks what is due at that minute, UTC:

| When (UTC) | Workflow it starts |
|---|---|
| every 10 minutes | `gateway.yml`: turns submissions into pull requests |
| every 15 minutes | `maintainer-review.yml` with input `trigger: timer`: the work check starts Claude only when a pull request or issue changed |
| daily 05:30 | `maintainer-questions.yml`: question pages |
| Mondays 09:00 | `maintainer-issue.yml`: the weekly issue |
| daily 06:15 | `verify-main.yml`: the signature check |

The site also pokes the Worker through a service binding (`TIMER` in the site's wrangler.toml) when a new submission or feedback item is stored, and the Worker starts the gateway at once; the Worker has no public route, so nothing else can reach that. The gateway also starts maintainer-review when it opens a pull request or feedback issue, at most once in 15 minutes.

**What it can do.** The Worker makes four kinds of call and no others:
- `POST https://api.github.com/repos/nsdub/ourowncause/actions/workflows/<file>/dispatches`, for the five files above, on `main`, with `GITHUB_TOKEN`;
- `GET https://api.github.com/repos/nsdub/ourowncause/commits/main`, every 15 minutes, with `GITHUB_TOKEN`, to read the time of the newest commit;
- `GET https://ourowncause.com/active.json`, every 15 minutes, to read when the live site was built;
- `POST` to the project's Cloudflare Pages deploy hook (`PAGES_DEPLOY_HOOK`), only when the site is behind main (below).

`GITHUB_TOKEN` is a fine-grained token, stored as a Worker secret, that the host created with access to this repository only and one permission, Actions: read and write. It cannot push, merge, comment or read secrets. A run it starts appears as a manual dispatch by the host's account.

**Rebuilding when Cloudflare fails.** Cloudflare Pages sometimes fails a production build on its own side, and the site then stays on an older build. Every 15 minutes the Worker compares the newest commit on main with active.json's `built_at`; if main is newer and that commit is between 12 minutes and 6 hours old, it calls the project's deploy hook, which rebuilds main. The hook's address is a Worker secret, `PAGES_DEPLOY_HOOK`; anyone holding it could start a rebuild of main and nothing else. It was created in the Pages project's settings (Settings › Builds › Deploy hooks, name `timer-rebuild`, branch `main`) and set with `npx wrangler secret put PAGES_DEPLOY_HOOK --name ourowncause-timer`, its value read from standard input; to replace it, delete the hook there, add a new one and set the secret again.

**What it changes for us.** A review run the timer starts carries `trigger: timer`, so the work check judges it like a schedule. The other dispatched runs count as started by hand: the daily questions run and the weekly issue run each start a Claude session even when nothing changed.

**Deploying** (the host, from this directory):

```bash
CLOUDFLARE_ACCOUNT_ID=4b5b58d31911934e2458ce7fccb18a26 npx wrangler deploy
```

Setting the token (the host; copy it first, then):

```bash
pbpaste | tr -d '\n ' | CLOUDFLARE_ACCOUNT_ID=4b5b58d31911934e2458ce7fccb18a26 npx wrangler secret put GITHUB_TOKEN --name ourowncause-timer
```

If GitHub's own schedules start firing, the timer would double the runs. The gateway and the work check are idempotent, so nothing breaks, but the timer should then be removed: `npx wrangler delete ourowncause-timer`.
