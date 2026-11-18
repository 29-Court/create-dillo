-- 29Court Dillo Vault — D1 schema (VAULT-SPEC build, 2026-11-09).
--
-- Home: the ONE physical D1 `29court` (apparatus stack; NOT yet created at
-- build time — the local proof runs against wrangler dev's real miniflare
-- D1 engine). All Vault tables carry the `dillo_` prefix so they can never
-- collide with Drive (`drive_*`) or Photos (`photos_*`) in the same DB.
--
-- Migration: db/migrations/0004-vault.json carries the six tables below
-- verbatim (global numbering); the seventh (dillo_vault_grants, D-1 grant
-- boundary) lands as db/migrations/0008-dillo-vault-grants.json. Gate:
-- db/gate_train.py check-sql BEFORE any upload.
-- No runtime DDL: the Worker never runs CREATE TABLE.
--
-- Conventions: timestamps are INTEGER unix milliseconds. Ids are TEXT
-- (`sec_` + random for secrets), generated server-side.
-- Secret rule (absolute): the `sealed` column holds ONLY the AES-GCM
-- envelope JSON {v, iv, ct}; no value, envelope, DEK, KEK, token, code,
-- verifier, or client secret ever appears in any other column, log, or
-- return shape.

-- One row per stored secret. The value column holds ONLY the sealed envelope.
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

-- Key versions. Holds WRAPPED keys only — never a bare DEK, never the master key.
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

-- Append-only access log. No value, no envelope, no key material — ever.
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

-- OAuth state rows. The `state` VALUE is never stored — only its SHA-256
-- hash. Single-use; 10-minute TTL.
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

-- Refresh leases. One row per secret under refresh; single-flight.
CREATE TABLE IF NOT EXISTS dillo_oauth_refresh_locks (
  secret_id   TEXT PRIMARY KEY,
  lease_id    TEXT NOT NULL,
  holder      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Rotation records. A rotation is a state machine, not a string.
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

-- Per-caller grants (D-1, migration 0008-dillo-vault-grants). A bound Worker
-- that presents x-vault-caller (a caller OTHER than the owner) may read or
-- oauth-fetch a secret ONLY when a matching row exists. The caller is
-- authenticated by a SHA-256 hash of its per-consumer secret; no secret
-- value, caller secret, or key material ever lands in this table.
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
