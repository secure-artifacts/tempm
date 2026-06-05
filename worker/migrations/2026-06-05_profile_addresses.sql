-- Add profile-address mapping used by Hermes and admin automation.
--
-- Several Worker endpoints read/write profile_addresses when generating
-- addresses for a profile and when pushing activation links back to that
-- profile. Keeping this table in migrations makes existing D1 databases match
-- the Worker code path.
CREATE TABLE IF NOT EXISTS profile_addresses (
  address TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_addresses_profile
  ON profile_addresses(profile_id, assigned_at);
