-- Local (wrangler dev / miniflare D1) mirror of db/migrations/0004-vault.json.
-- Applies the Vault's six dillo_* tables to the local D1. Source of truth is
-- dillo/src/vault/schema.sql (identical DDL). No runtime DDL in the worker.
CREATE TABLE IF NOT EXISTS dillo_secrets (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  provider      TEXT,
  host          TEXT NOT NULL,
  sealed        TEXT,
  key_version   INTEGER NOT NULL,
  fingerprint   TEXT,
  last4         TEXT,
  scopes        TEXT,
  state         TEXT NOT NULL DEFAULT 'ok',
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  UNIQUE(tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_dillo_secrets_tenant_owner ON dillo_secrets(tenant_id, owner_id, state);
CREATE INDEX IF NOT EXISTS idx_dillo_secrets_tenant_name ON dillo_secrets(tenant_id, name);

CREATE TABLE IF NOT EXISTS dillo_secret_keys (
  version       INTEGER PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  wrapped_dek   TEXT NOT NULL,
  kek_version   INTEGER NOT NULL,
  algorithm     TEXT NOT NULL DEFAULT 'AES-GCM-256',
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  retired_at    INTEGER,
  UNIQUE(tenant_id, version)
);

CREATE TABLE IF NOT EXISTS dillo_secret_access_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  tenant_id     TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  session_hash  TEXT,
  secret_id     TEXT NOT NULL,
  operation     TEXT NOT NULL,
  purpose       TEXT,
  key_version   INTEGER,
  decision      TEXT NOT NULL,
  reason        TEXT,
  fingerprint   TEXT
);
CREATE INDEX IF NOT EXISTS idx_dillo_secret_access_log_secret ON dillo_secret_access_log(secret_id, at);
CREATE INDEX IF NOT EXISTS idx_dillo_secret_access_log_actor ON dillo_secret_access_log(actor_id, at);

CREATE TABLE IF NOT EXISTS dillo_oauth_states (
  state_hash      TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  name            TEXT NOT NULL,
  scopes          TEXT,
  nonce_hash      TEXT,
  verifier_sealed TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dillo_oauth_states_expiry ON dillo_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS dillo_oauth_refresh_locks (
  secret_id   TEXT PRIMARY KEY,
  lease_id    TEXT NOT NULL,
  holder      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dillo_secret_rotations (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  from_version  INTEGER NOT NULL,
  to_version    INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'minted',
  rows_total    INTEGER NOT NULL DEFAULT 0,
  rows_done     INTEGER NOT NULL DEFAULT 0,
  rows_failed   INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  actor         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dillo_secret_rotations_tenant ON dillo_secret_rotations(tenant_id, started_at);
