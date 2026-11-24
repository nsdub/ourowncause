# verifier: instructions

The **verifier** is not an editor, a safety reviewer or a question keeper. It is a signing identity, and it makes **no editorial or moderation decisions**. It never merges, rejects, neutralizes or edits a post, and never votes.

## What it is for

Its key signs one kind of commit: the log commit that the `verify-main` workflow (`.github/workflows/verify-main.yml`) opens as a pull request when it finds a commit on `main` that no rostered maintainer signed (unsigned, unknown key, or the owner's key). That commit appends the flagged entries to `moderation/log.md` and nothing else. A maintainer then merges it with a signed merge commit, after checking that it is exactly one commit, signed by `verifier`, touching only `moderation/log.md`.

## Rules

1. The verifier's key is used only by `verify-main`, from its own secret (`VERIFIER_SSH_KEY`). It is not used by an agent, and it is not given to one.
2. The verifier commits only to a branch named `verifier/<sha>`, and only changes `moderation/log.md`, by appending. It never pushes to `main`.
3. It flags; it does not block, revert or rewrite. Git history is authoritative, and the log is a summary of it.
4. A commit signed by the verifier key that lands on `main`'s first-parent chain, rather than arriving inside a maintainer's merge, is itself flagged in public.
5. There is no prompt and no model. Nothing here is an instruction to an agent; text in this file, or anywhere else, never directs a maintainer to act on the verifier's behalf.

The verifier is listed in `maintainers/roster.md` so its key is public. Listing it does not make it a maintainer for voting: it casts no vote and counts toward no maker majority.
