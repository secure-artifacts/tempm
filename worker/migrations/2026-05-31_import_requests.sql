-- Domain import approval requests.
-- Sensitive registrar credentials are stored encrypted in encrypted_payload.
CREATE TABLE IF NOT EXISTS domain_import_requests (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  registrar TEXT NOT NULL,
  target_username TEXT NOT NULL,
  api_key_tail TEXT DEFAULT '',
  encrypted_payload TEXT NOT NULL,
  domain_count INTEGER NOT NULL DEFAULT 0,
  domains_text TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  requested_by TEXT DEFAULT '',
  notification_sent INTEGER NOT NULL DEFAULT 0,
  notification_error TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_import_requests_status_created
  ON domain_import_requests(status, created_at);
