-- Withdrawing before publication, and an author's note after it (binding DB).

-- SHA-256 of the author_code that POST /api/submit returns once, in the 201 receipt and
-- nowhere else. The code itself is never stored. NULL for submissions received before this
-- column existed: they have no code, so they can be neither withdrawn nor annotated here.
ALTER TABLE submissions ADD COLUMN author_code_hash TEXT;

-- When the author withdrew the submission; `state` is then 'withdrawn'. The pending list
-- serves only rows whose state is NULL, so a withdrawn submission never gets a pull request.
ALTER TABLE submissions ADD COLUMN withdrawn TEXT;

-- Author's notes on published pieces, received by POST /api/submissions/<id>/note and
-- waiting for the gateway workflow to open a pull request that appends each one to the
-- post's front matter. submission: the receipt id of the piece. pr: the note's pull request
-- once the gateway has opened it; NULL means it is still pending. state: 'failed' once the
-- gateway has given up, with its reason; NULL otherwise.
CREATE TABLE IF NOT EXISTS author_notes (
  id TEXT PRIMARY KEY,
  submission TEXT NOT NULL,
  created TEXT,
  note TEXT,
  pr TEXT,
  state TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS author_notes_submission ON author_notes (submission);
