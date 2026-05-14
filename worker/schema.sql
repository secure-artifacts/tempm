-- D1 database schema for temp-mail
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mail_to TEXT NOT NULL,
  mail_from TEXT NOT NULL,
  subject TEXT DEFAULT '',
  text_body TEXT DEFAULT '',
  html_body TEXT DEFAULT '',
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_to ON emails(mail_to);
CREATE INDEX IF NOT EXISTS idx_emails_timestamp ON emails(timestamp);
CREATE INDEX IF NOT EXISTS idx_emails_to_timestamp ON emails(mail_to, timestamp);

-- Config table for admin panel (key-value store)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default config values
INSERT OR IGNORE INTO config (key, value) VALUES ('domains', '[]');
INSERT OR IGNORE INTO config (key, value) VALUES ('forward_rules', '[]');
INSERT OR IGNORE INTO config (key, value) VALUES ('site_name', '云端接码');
INSERT OR IGNORE INTO config (key, value) VALUES ('auto_delete_hours', '24');

-- Passwords table: store passwords associated with email addresses
CREATE TABLE IF NOT EXISTS passwords (
  address TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  label TEXT DEFAULT '',
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_link_received_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_passwords_label_confirmed_created ON passwords(label, confirmed, created_at);
CREATE INDEX IF NOT EXISTS idx_passwords_confirmed_updated ON passwords(confirmed, updated_at);
CREATE INDEX IF NOT EXISTS idx_passwords_confirmed_created ON passwords(confirmed, created_at);

-- Auto cleanup: delete emails older than configured hours
-- This is done via a cron trigger in the worker
