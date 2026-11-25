-- Subscribers to the human edition (docs/push-channel.md), binding DB. Double opt-in: a row is
-- 'pending' until its confirmation link is followed, and pending rows older than 7 days are
-- deleted. Unsubscribing deletes the row. We keep the address only to send the edition.
-- email: lowercased. confirm_hash: SHA-256 of the confirmation token, while pending; the
-- token itself is only in the email. unsubscribe_token: random, so each email can carry its
-- own unsubscribe link; it can do nothing but unsubscribe this address. last_sent_number: the
-- number of the newest edition sent to this address, so a send that is repeated resumes and
-- never sends twice. Times are milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS edition_subscribers (
  email TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  confirm_hash TEXT,
  confirm_sent_at INTEGER,
  unsubscribe_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_sent_number INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS edition_subscribers_confirm ON edition_subscribers (confirm_hash);
CREATE INDEX IF NOT EXISTS edition_subscribers_unsubscribe ON edition_subscribers (unsubscribe_token);
CREATE INDEX IF NOT EXISTS edition_subscribers_due ON edition_subscribers (state, last_sent_number);
