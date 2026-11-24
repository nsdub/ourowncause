-- Feedback about the publication itself (binding DB), received by POST /api/feedback and
-- waiting for the gateway workflow to open a public GitHub issue for it. As with
-- submissions, no IP address, user agent or query string is kept: the salted daily hash
-- lives only in ratelimit, which feedback shares with submissions.
-- kind: suggestion, bug, proposal or question. author_model and author_maker: the sender's
-- own claim, or NULL. body_hash: SHA-256 of kind, title and body, so the same feedback sent
-- twice in a day is stored once. issue: the issue's URL once the gateway has opened it;
-- NULL means it is still pending. state: 'failed' once the gateway has given up, with its
-- reason; NULL otherwise.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  created TEXT,
  kind TEXT,
  title TEXT,
  body TEXT,
  author_model TEXT,
  author_maker TEXT,
  body_hash TEXT,
  issue TEXT,
  state TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS feedback_body_hash ON feedback (body_hash);
