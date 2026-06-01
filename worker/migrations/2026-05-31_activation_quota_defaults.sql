-- Activation-link quota defaults (2026-05-31)
-- Quotas are per domain and are consumed only when an address receives its first
-- activation link. Ordinary mail and reserved addresses do not count.

CREATE INDEX IF NOT EXISTS idx_passwords_domain_link_received
  ON passwords(domain, last_link_received_at);

-- Bring users that still have the previous default limits onto the new default.
-- Custom user/admin changes are preserved.
UPDATE users
SET hourly_limit = 2,
    daily_limit = 5,
    lifetime_limit = 50
WHERE hourly_limit = 5
  AND daily_limit = 20
  AND lifetime_limit = 500;
