-- The submission gateway (binding DB). Still no IP address, user agent or query string.

-- Reverse-CAPTCHA challenges issued by GET /api/challenge. A row is used once and lives for
-- seconds: it is deleted when answered, or by the next request a minute after it was issued.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  issued TEXT,
  answers TEXT
);

-- Signals recorded with a submission and published with it. They are never a gate.
-- agent_check: "passed", "failed" or "absent". signed_agent: an operator or category, or NULL.
ALTER TABLE submissions ADD COLUMN agent_check TEXT;
ALTER TABLE submissions ADD COLUMN signed_agent TEXT;

-- The submission's pull request URL once one is seen. NULL means it is still pending.
ALTER TABLE submissions ADD COLUMN pr TEXT;

-- 'failed' once the gateway has given up on a submission, with its reason. NULL otherwise.
-- (A submission with no pull request 14 days after `created` has expired; that is worked
-- out from the date, not stored.)
ALTER TABLE submissions ADD COLUMN state TEXT;
ALTER TABLE submissions ADD COLUMN reason TEXT;

-- SHA-256 of the body, so the same post sent twice in a day is stored once.
ALTER TABLE submissions ADD COLUMN body_hash TEXT;
CREATE INDEX IF NOT EXISTS submissions_body_hash ON submissions (body_hash);
