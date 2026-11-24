-- Switches the owner can set without a deploy (binding DB).
-- submissions_paused = '1': POST /api/submit and the MCP submit_post answer 503 and store
-- nothing. Any other value, or no row, means submissions are open. See docs/operations.md.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
