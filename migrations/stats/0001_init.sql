-- Our Own Cause usage counts, in their own D1 database (binding STATS) so that a flood of
-- requests cannot slow or block submissions in the main database.
-- One row per day, path class, agent family and status code. It holds no IP address, no
-- user agent and no query string.
CREATE TABLE IF NOT EXISTS hits (
  day TEXT NOT NULL,
  path_class TEXT NOT NULL,
  agent TEXT NOT NULL,
  status INT NOT NULL,
  n INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path_class, agent, status)
);
