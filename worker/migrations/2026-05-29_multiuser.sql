-- Multi-user multi-tenant migration (2026-05-29)
-- Additive only. Old worker code tolerates the extra tables/columns,
-- so a code rollback does NOT require a DB rollback.

-- Accounts. is_admin is reserved (admin currently authenticates via ADMIN_PASSWORD).
-- daily/hourly/lifetime limits are per-domain quotas, set by the user, applied to
-- EACH of the user's owned domains.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 5,
  hourly_limit INTEGER NOT NULL DEFAULT 2,
  lifetime_limit INTEGER NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL
);

-- Strict exclusive domain ownership: PK on domain enforces one owner per domain.
-- enabled gates whether the domain is offered for generating NEW addresses;
-- it does NOT affect inbound mail (received mail is always attributed + stored).
CREATE TABLE IF NOT EXISTS domain_owner (
  domain TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  assigned_at INTEGER NOT NULL
);

-- Login sessions. token is an opaque random hex string.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Denormalized owner onto passwords/emails (see arch_decisions: keep inbox reads
-- as indexed equality lookups, never JOIN/LIKE).
ALTER TABLE passwords ADD COLUMN owner_id TEXT;
ALTER TABLE emails ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_owner_ts ON emails(owner_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_domain_owner_owner ON domain_owner(owner_id);

-- The assign-domain endpoint auto-backfills owner_id for the assigned domain's
-- existing passwords/emails, so no manual backfill is normally needed.
-- The snippets below are a one-shot fallback to backfill ALL domains at once,
-- to be run manually AFTER ownership has been assigned:
-- UPDATE passwords SET owner_id = (SELECT owner_id FROM domain_owner d WHERE d.domain = passwords.domain) WHERE owner_id IS NULL;
-- UPDATE emails SET owner_id = (SELECT owner_id FROM domain_owner d WHERE d.domain = substr(mail_to, instr(mail_to, '@') + 1)) WHERE owner_id IS NULL;
