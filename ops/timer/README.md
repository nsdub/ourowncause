# The timer

GitHub's own schedules (`on: schedule` in our workflows) have never fired in this repository. Runs started by hand work. So that submissions do not wait for a person, a Cloudflare Worker named `ourowncause-timer`, on the owner's Cloudflare account, starts our workflows on a clock. This directory holds its exact code and configuration, so anyone can see what starts our runs and when.

| Cron (UTC) | Workflow it starts |
|---|---|
| `*/10 * * * *` | `gateway.yml`: turns submissions into pull requests |
| `*/15 * * * *` | `maintainer-review.yml` with input `trigger: timer`: the work check starts Claude only when a pull request or issue changed |
| `30 5 * * *` | `maintainer-questions.yml`: question pages |
| `0 9 * * 1` | `maintainer-issue.yml`: the weekly issue |
| `17 6 * * *` | `verify-main.yml`: the signature check |

The site also pokes the Worker through a service binding (`TIMER` in the site's wrangler.toml) when a new submission or feedback item is stored, and the Worker starts the gateway at once; the Worker has no public route, so nothing else can reach that. The gateway also starts maintainer-review when it opens a pull request or feedback issue, at most once in 15 minutes.

**What it can do.** The Worker calls one GitHub endpoint, `POST /repos/nsdub/ourowncause/actions/workflows/<file>/dispatches`, for the five files above, on `main`. It authenticates with a fine-grained token, `GITHUB_TOKEN`, stored as a Worker secret. The owner created that token with access to this repository only and one permission, Actions: read and write. It cannot push, merge, comment or read secrets. A run it starts appears as a manual dispatch by the owner's account.

**What it changes for us.** A review run the timer starts carries `trigger: timer`, so the work check judges it like a schedule. The other dispatched runs count as started by hand: the daily questions run and the weekly issue run each start a Claude session even when nothing changed.

**Deploying** (owner, from this directory):

```bash
CLOUDFLARE_ACCOUNT_ID=4b5b58d31911934e2458ce7fccb18a26 npx wrangler deploy
```

Setting the token (owner; copy it first, then):

```bash
pbpaste | tr -d '\n ' | CLOUDFLARE_ACCOUNT_ID=4b5b58d31911934e2458ce7fccb18a26 npx wrangler secret put GITHUB_TOKEN --name ourowncause-timer
```

If GitHub's own schedules start firing, the timer would double the runs. The gateway and the work check are idempotent, so nothing breaks, but the timer should then be removed: `npx wrangler delete ourowncause-timer`.
