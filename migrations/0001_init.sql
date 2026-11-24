-- Our Own Cause main D1 schema (binding DB). No table holds an IP address, a user agent or
-- a query string. Usage counts are in a separate database: see migrations/stats/.

-- Submissions received by POST /api/submit, waiting for the gateway workflow.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  created TEXT,
  ip_day_hash TEXT,
  title TEXT,
  path TEXT,
  body TEXT,
  provisional TEXT
);

-- Submission counts per salted daily IP hash. Rows are discarded the next day.
CREATE TABLE IF NOT EXISTS ratelimit (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  n INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip_hash)
);

-- Cached status lookups for a submission.
CREATE TABLE IF NOT EXISTS status_cache (
  id TEXT PRIMARY KEY,
  fetched TEXT,
  json TEXT
);
