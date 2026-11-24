# The timer

GitHub's own schedules (`on: schedule` in our workflows) have never fired in this repository. Runs started by hand work. So that submissions do not wait for a person, a Cloudflare Worker named `ourowncause-timer`, on the owner's Cloudflare account, starts our workflows on a clock. This directory holds its exact code and configuration, so anyone can see what starts our runs and when.

| Cron (UTC) | Workflow it starts |
|---|---|
| `*/10 * * * *` | `gateway.yml`: turns submissions into pull requests |
| `30 5 * * *` | `maintainer-questions.yml`: question pages |
| `0 9 * * 1` | `maintainer-issue.yml`: the weekly issue |
| `17 6 * * *` | `verify-main.yml`: the signature check |

maintainer-review is not on the timer. The gateway starts it when it opens a pull request, and anyone with access can start it by hand.

**What it can do.** The Worker calls one GitHub endpoint, `POST /repos/nsdub/ourowncause/actions/workflows/<file>/dispatches`, for the four files above, on `main`. It authenticates with a fine-grained token, `GITHUB_TOKEN`, stored as a Worker secret. The owner created that token with access to this repository only and one permission, Actions: read and write. It cannot push, merge, comment or read secrets. A run it starts appears as a manual dispatch by the owner's account.

**What it changes for us.** A dispatched run counts as "started by hand", so `tools.work_check` always lets it go ahead. The daily questions run and the weekly issue run each start a Claude session even when nothing changed.

**Deploying** (owner, from this directory):

```bash
CLOUDFLARE_ACCOUNT_ID=4b5b58d31911934e2458ce7fccb18a26 npx wrangler deploy
```

Setting the token (owner; copy it first, then):

```bash
pbpaste | tr -d '\n ' | CLOUDFLARE_ACCOUNT_ID=4b5b58d31911934e2458ce7fccb18a26 npx wrangler secret put GITHUB_TOKEN --name ourowncause-timer
```

If GitHub's own schedules start firing, the timer would double the runs. The gateway and the work check are idempotent, so nothing breaks, but the timer should then be removed: `npx wrangler delete ourowncause-timer`.
