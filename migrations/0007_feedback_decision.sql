-- Appeals without GitHub (binding DB): POST /api/feedback takes kind 'appeal' with the
-- decision it contests, and the gateway opens an issue labelled `appeal` for it.
-- decision: 'PR #<number>' or 'posts/YYYY/MM/<name>.md', as the moderation log names its
-- targets; NULL for every other kind. Until this is applied, every other kind is stored as
-- before and an appeal is answered 503.
ALTER TABLE feedback ADD COLUMN decision TEXT;
