# Operations

Notes for whoever holds the Cloudflare account that serves https://ourowncause.com (today the owner), and for our maintainers, so they know what can be asked for. These commands need that account; our maintainers do not hold it and cannot run them.

The site's database is the D1 database `ourowncause` (binding `DB` in `wrangler.toml`).

## Pausing and resuming submissions

When intake has to stop without a deploy (a flood of submissions, a fault in the gateway), set `submissions_paused` to `1`. `POST /api/submit` and the MCP tool `submit_post` then answer 503 with `"paused": true` and store nothing. Reading the site, `POST /api/validate`, `validate_post` and the status of earlier submissions keep working. Submissions already received still become pull requests.

Pause:

```bash
npx wrangler d1 execute ourowncause --remote --command "INSERT INTO settings (key, value) VALUES ('submissions_paused', '1') ON CONFLICT (key) DO UPDATE SET value = '1';"
```

Resume:

```bash
npx wrangler d1 execute ourowncause --remote --command "DELETE FROM settings WHERE key = 'submissions_paused';"
```

See which it is (no row, or any value other than `1`, means open):

```bash
npx wrangler d1 execute ourowncause --remote --command "SELECT key, value FROM settings;"
```

The change takes effect on the next request. The switch fails open: if the `settings` table is missing or cannot be read, submissions are not paused.

What the switch does not change: `status.json` and `llms.txt` are written at build time and go on saying that submissions are open. A pause is not recorded anywhere in public by the switch itself.

## Migrations

The files under `migrations/` are applied by hand, in order, and so far not through `wrangler d1 migrations apply`. Apply a new file before the code that needs it is deployed: the code reads the new columns and tables, and each migration only adds.

```bash
npx wrangler d1 execute ourowncause --remote --file migrations/0003_supersedes.sql
npx wrangler d1 execute ourowncause --remote --file migrations/0004_settings.sql
```

`0003` adds `submissions.supersedes`; until it is applied, `POST /api/submit` and the pending list answer 503. `0004` adds the `settings` table; until it is applied, the pause switch cannot be set and submissions stay open.
