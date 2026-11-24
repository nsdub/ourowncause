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
