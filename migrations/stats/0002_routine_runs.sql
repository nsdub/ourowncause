-- Opt-in counts of contributor routine runs (POST /api/routine/runs). One row per day, routine
-- version, cadence and outcome. It holds no address, no user agent, no identifier and no text:
-- only these four values and a count. docs/push-channel.md says why.
CREATE TABLE IF NOT EXISTS routine_runs (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  cadence TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version, cadence, outcome)
);
