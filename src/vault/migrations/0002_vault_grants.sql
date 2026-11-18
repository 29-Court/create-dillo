-- Local (wrangler dev / miniflare D1) mirror of db/migrations/0008-dillo-vault-grants.json.
-- The per-caller grant boundary (D-1): a bound Worker that presents
-- x-vault-caller (a caller OTHER than the owner) may read/fetch a secret ONLY
-- when a matching grant row exists. The caller is authenticated by a SHA-256
-- hash of its per-consumer secret; no secret value lives in this table.
CREATE TABLE IF NOT EXISTS dillo_vault_grants (
  id                 TEXT PRIMARY KEY,
  caller_id          TEXT NOT NULL,
  caller_secret_hash TEXT NOT NULL,
  tenant_id          TEXT NOT NULL,
  owner_id           TEXT NOT NULL,
  secret_name        TEXT NOT NULL,
  operation          TEXT NOT NULL,
  granted_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dillo_vault_grants_lookup
  ON dillo_vault_grants(caller_id, tenant_id, owner_id, secret_name, operation);
CREATE INDEX IF NOT EXISTS idx_dillo_vault_grants_callersecret
  ON dillo_vault_grants(caller_id, caller_secret_hash);
