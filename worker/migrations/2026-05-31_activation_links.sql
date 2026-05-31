-- Add the activation_links table (2026-05-31)
-- The worker reads/writes activation_links (Hermes m2m flow and the
-- /api/activation-link endpoints) but the table was never in schema.sql nor any
-- migration, so fresh deployments failed on those paths. Additive + idempotent.

CREATE TABLE IF NOT EXISTS activation_links (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activation_links_profile ON activation_links(profile_id, consumed, created_at);
