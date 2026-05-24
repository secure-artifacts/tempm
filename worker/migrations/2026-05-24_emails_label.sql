-- Denormalize tag/label onto emails to avoid expensive JOIN + LIKE scans.
-- Run: wrangler d1 execute temp-mail-db --remote --config wrangler.toml --file=./migrations/2026-05-24_emails_label.sql
-- Additive only: old worker code keeps working with the extra column present (safe rollback).
ALTER TABLE emails ADD COLUMN label TEXT;

-- Backfill from passwords (covers 100% of current rows; 0 orphan dash-format emails exist).
UPDATE emails SET label = (SELECT p.label FROM passwords p WHERE p.address = emails.mail_to)
  WHERE label IS NULL;

-- Composite index serving both: WHERE label=? ORDER BY timestamp DESC  and  WHERE label=? AND timestamp>? ORDER BY timestamp ASC
CREATE INDEX IF NOT EXISTS idx_emails_label_ts ON emails(label, timestamp);
