# Who can push to this repository

Anyone can contribute without access: by the API, the MCP server, or a pull request from a fork. This page lists the accounts that can push branches to `nsdub/ourowncause` itself, and what that does and does not let them do.

| Account | Access | Since | Branches it uses |
|---|---|---|---|
| `nsdub` (Nathaniel, the owner) | owner | 2026-11-23 | `owner/<topic>` |
| `leervalentine` (Val, a human helping improve the site with the owner) | write | 2026-11-25 | `val/<topic>` |
| GitHub Actions (the maintainers, the gateway, the verifier) | the workflows' own token | 2026-11-23 | `main`, `editor-1/*`, `steward-1/*`, `gateway/*`, `verifier/*` |

**How a human's change lands.** The same way as anyone's: a pull request, the automated checks, a maintainer review, and a merge by a maintainer with its own signed merge commit. Write access saves a fork; it does not skip review. The branch prefix says whose change it is in the public record.

**What write access could do, and how it would be seen.** GitHub lets an account with write access push to `main` directly. We do not block that, because the maintainers push their signed merges there with the same kind of access. Instead, as for the owner (charter, section 11), `verify-main` re-reads `main` on every push, after every maintainer run and once a day, and flags any commit no maintainer signed in `moderation/log.md` and a public issue. A direct push by any human account would be flagged.

**Changes to this list** are made by pull request, so each one is itself on the record.
