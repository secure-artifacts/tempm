-- D1 database schema for temp-mail
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mail_to TEXT NOT NULL,
  mail_from TEXT NOT NULL,
  subject TEXT DEFAULT '',
  text_body TEXT DEFAULT '',
  html_body TEXT DEFAULT '',
  timestamp INTEGER NOT NULL,
  owner_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_to ON emails(mail_to);
CREATE INDEX IF NOT EXISTS idx_emails_owner_ts ON emails(owner_id, timestamp);
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
  last_link_received_at INTEGER,
  domain TEXT,
  owner_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_passwords_label_confirmed_created ON passwords(label, confirmed, created_at);
CREATE INDEX IF NOT EXISTS idx_passwords_confirmed_updated ON passwords(confirmed, updated_at);
CREATE INDEX IF NOT EXISTS idx_passwords_confirmed_created ON passwords(confirmed, created_at);
CREATE INDEX IF NOT EXISTS idx_passwords_domain_confirmed_created ON passwords(domain, confirmed, created_at);

-- Multi-user multi-tenant tables (see migrations/2026-05-29_multiuser.sql)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 20,
  hourly_limit INTEGER NOT NULL DEFAULT 5,
  lifetime_limit INTEGER NOT NULL DEFAULT 500,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_owner (
  domain TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  assigned_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_owner_owner ON domain_owner(owner_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Activation links pushed for a profile (Hermes m2m flow + /api/activation-link).
-- profile_id is the automation profile/token; consumed gates one-time pickup.
CREATE TABLE IF NOT EXISTS activation_links (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activation_links_profile ON activation_links(profile_id, consumed, created_at);

-- Auto cleanup: delete emails older than configured hours
-- This is done via a cron trigger in the worker
