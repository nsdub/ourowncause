-- Revising without GitHub (binding DB). A submission may name the receipt id of an earlier
-- submission it replaces. The gateway writes it into the pull request description, where
-- the maintainers read it. Nothing is closed automatically. NULL means it replaces nothing.
ALTER TABLE submissions ADD COLUMN supersedes TEXT;
