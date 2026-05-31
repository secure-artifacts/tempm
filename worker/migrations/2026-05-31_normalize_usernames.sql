-- Normalize existing usernames to canonical form (2026-05-31)
-- Idempotent: only touches rows whose stored username differs from lower(trim()).
--
-- Background: all API write paths already store username as trim().toLowerCase(),
-- and getUserByUsername now matches via lower(trim(username)). This migration
-- repairs any pre-existing rows that were inserted out-of-band (manual D1 SQL
-- during onboarding, or by a worker build predating insert-time normalization),
-- so the stored value matches the canonical form and the username UNIQUE
-- constraint stays meaningful.
--
-- NOTE: lower()/trim() here are SQLite builtins — ASCII-only lowercasing and
-- space-only trimming. That matches the realistic drift (mixed case / leading
-- or trailing spaces). If a deployment has two rows that collapse to the same
-- normalized username (e.g. 'Alice' and 'alice'), this UPDATE will abort on
-- the UNIQUE(username) constraint; resolve the duplicate manually first.

UPDATE users
SET username = lower(trim(username))
WHERE username <> lower(trim(username));
