/** Immutable, ordered core SQL migrations. Checksums are SHA-256 of exact UTF-8 SQL bytes. */
export interface SqlMigration {
  readonly id: string;
  readonly checksum: string;
  readonly sql: string;
}

export const migrations = [
  { id: "0001_base.sql", checksum: "2f0b3ee96403fb522c8bbee9c5db4b9c712e43fdd126e37f23ec323d43b2b87b", sql: `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _armadillo_users (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, email)
) STRICT;

CREATE TABLE IF NOT EXISTS _armadillo_sessions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_sessions_user
  ON _armadillo_sessions (app_id, user_id);

CREATE INDEX IF NOT EXISTS _armadillo_sessions_expiry
  ON _armadillo_sessions (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_objects (
  app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, collection, id),
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_objects_owner
  ON _armadillo_objects (app_id, collection, owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS _armadillo_files (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_files_owner
  ON _armadillo_files (app_id, owner_id, created_at DESC);
` },
  { id: "0002_groups_events.sql", checksum: "0b455f157904c9f6a21e68be676d177fe6367d256ba111dfe30243a62b264c60", sql: `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _armadillo_groups (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, slug),
  FOREIGN KEY (app_id, created_by)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS _armadillo_group_members (
  app_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, group_id, user_id),
  FOREIGN KEY (app_id, group_id)
    REFERENCES _armadillo_groups (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, user_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_group_members_user
  ON _armadillo_group_members (app_id, user_id, group_id);

CREATE TABLE IF NOT EXISTS _armadillo_events (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, group_id)
    REFERENCES _armadillo_groups (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, actor_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_events_group_time
  ON _armadillo_events (app_id, group_id, created_at DESC);
` },
  { id: "0003_schema_state.sql", checksum: "7d3117d2170a1fbfbde500f1cf626ff18c7143eccf78e41edb1c29702502b143", sql: `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _armadillo_schema_state (
  app_id TEXT NOT NULL PRIMARY KEY,
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
` },
  { id: "0004_pre_publish_primitives.sql", checksum: "8ea9869b63041c831f396be27a9da38392b8664c156745bb1717117ef6d1cf7d", sql: `PRAGMA foreign_keys = ON;

ALTER TABLE _armadillo_users
  ADD COLUMN password_enabled INTEGER NOT NULL DEFAULT 1 CHECK (password_enabled IN (0, 1));

ALTER TABLE _armadillo_sessions
  ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'
  CHECK (auth_method IN ('password', 'magic_link'));

CREATE TABLE IF NOT EXISTS _armadillo_magic_links (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  requested_email TEXT NOT NULL COLLATE NOCASE,
  redirect_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_session TEXT,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_magic_links_expiry
  ON _armadillo_magic_links (expires_at);

CREATE INDEX IF NOT EXISTS _armadillo_magic_links_user
  ON _armadillo_magic_links (app_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS _armadillo_vouchers (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_vouchers_owner
  ON _armadillo_vouchers (app_id, owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_vouchers_expiry
  ON _armadillo_vouchers (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_voucher_redemptions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  consumed_by TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, voucher_id, idempotency_key),
  FOREIGN KEY (app_id, voucher_id)
    REFERENCES _armadillo_vouchers (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, consumed_by)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_voucher_redemptions_voucher
  ON _armadillo_voucher_redemptions (app_id, voucher_id, consumed_at DESC);

CREATE TRIGGER IF NOT EXISTS _armadillo_voucher_consume
BEFORE INSERT ON _armadillo_voucher_redemptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM _armadillo_voucher_redemptions
   WHERE app_id = NEW.app_id
     AND voucher_id = NEW.voucher_id
     AND idempotency_key = NEW.idempotency_key
)
BEGIN
  UPDATE _armadillo_vouchers
     SET remaining = remaining - 1,
         updated_at = NEW.consumed_at
   WHERE app_id = NEW.app_id
     AND id = NEW.voucher_id
     AND remaining > 0
     AND (expires_at IS NULL OR expires_at > NEW.consumed_at);
  SELECT CASE changes()
    WHEN 0 THEN RAISE(ABORT, 'ARMADILLO_VOUCHER_UNAVAILABLE')
  END;
END;

CREATE TABLE IF NOT EXISTS _armadillo_api_keys (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_api_keys_owner
  ON _armadillo_api_keys (app_id, owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_api_keys_expiry
  ON _armadillo_api_keys (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_bootstrap (
  app_id TEXT NOT NULL PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  used_at TEXT NOT NULL,
  FOREIGN KEY (app_id, user_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, group_id)
    REFERENCES _armadillo_groups (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS _armadillo_rate_limits (
  key_hash TEXT NOT NULL PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  reset_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_rate_limits_expiry
  ON _armadillo_rate_limits (reset_at);

CREATE TABLE IF NOT EXISTS _armadillo_mail_jobs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_mail_jobs_status
  ON _armadillo_mail_jobs (status, updated_at);

CREATE TABLE IF NOT EXISTS _armadillo_file_uploads (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('presigned', 'multipart')),
  r2_upload_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'aborted')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_file_uploads_owner
  ON _armadillo_file_uploads (app_id, owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_file_uploads_expiry
  ON _armadillo_file_uploads (expires_at);

-- This deliberately hidden indirection keeps application records independent
-- from physical R2 metadata and supports both declared file fields and an
-- arbitrary attachment collection on every record.
CREATE TABLE IF NOT EXISTS __armadillo_file (
  app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  object_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('field', 'attachment')),
  field_name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, collection, object_id, file_id, relation, field_name),
  FOREIGN KEY (app_id, collection, object_id)
    REFERENCES _armadillo_objects (app_id, collection, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, file_id)
    REFERENCES _armadillo_files (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS __armadillo_file_record
  ON __armadillo_file (app_id, collection, object_id, relation, position, created_at);

CREATE INDEX IF NOT EXISTS __armadillo_file_file
  ON __armadillo_file (app_id, file_id);
` },
  { id: "0005_physical_schema_files.sql", checksum: "a96dd61057ec13c49c0ea5b6814e2bf47f10df9c10636a322e890e986ff46be0", sql: `PRAGMA foreign_keys = ON;

-- Column-backed application tables do not live in _armadillo_objects. Keep
-- file links provider-neutral by enforcing file/user integrity here while the
-- runtime validates the logical application record before every mutation.
CREATE TABLE IF NOT EXISTS __armadillo_file_link (
  app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  object_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('field', 'attachment')),
  field_name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, collection, object_id, file_id, relation, field_name),
  FOREIGN KEY (app_id, file_id)
    REFERENCES _armadillo_files (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, owner_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

INSERT OR IGNORE INTO __armadillo_file_link
  (app_id, collection, object_id, file_id, owner_id, relation, field_name, position, created_at)
SELECT app_id, collection, object_id, file_id, owner_id, relation, field_name, position, created_at
  FROM __armadillo_file;

DROP TABLE __armadillo_file;

CREATE INDEX IF NOT EXISTS __armadillo_file_link_record
  ON __armadillo_file_link (app_id, collection, object_id, relation, position, created_at);

CREATE INDEX IF NOT EXISTS __armadillo_file_link_file
  ON __armadillo_file_link (app_id, file_id);
` },
  { id: "0006_collectors.sql", checksum: "dbf1fb2c1d1cd34f1bf3ac48f777a72ab201ceae3e78d2d15ce3c28fa098ad16", sql: `PRAGMA foreign_keys = ON;

-- Collectors intentionally write into a dedicated inbox instead of opening a
-- generic table mutation surface. Anonymous submissions have a NULL user_id;
-- team/project routing is fixed by the server-side collector definition.
CREATE TABLE IF NOT EXISTS _armadillo_collector_submissions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  user_id TEXT,
  group_id TEXT NOT NULL,
  project_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, group_id)
    REFERENCES _armadillo_groups (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_collector_submissions_inbox
  ON _armadillo_collector_submissions (app_id, collector_id, group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_collector_submissions_expiry
  ON _armadillo_collector_submissions (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_tickets (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  holder_id TEXT,
  label TEXT NOT NULL,
  event_id TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  expires_at TEXT,
  consumed_at TEXT,
  consumed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, team_id) REFERENCES _armadillo_groups (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_tickets_team
  ON _armadillo_tickets (app_id, team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_tickets_holder
  ON _armadillo_tickets (app_id, holder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_tickets_expiry
  ON _armadillo_tickets (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_ticket_consumptions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  consumed_by TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, ticket_id),
  UNIQUE (app_id, ticket_id, idempotency_key),
  FOREIGN KEY (app_id, ticket_id) REFERENCES _armadillo_tickets (app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, consumed_by) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS _armadillo_ticket_consume
BEFORE INSERT ON _armadillo_ticket_consumptions
FOR EACH ROW
BEGIN
  UPDATE _armadillo_tickets
     SET consumed_at = NEW.consumed_at,
         consumed_by = NEW.consumed_by,
         updated_at = NEW.consumed_at
   WHERE app_id = NEW.app_id
     AND id = NEW.ticket_id
     AND consumed_at IS NULL
     AND (expires_at IS NULL OR expires_at > NEW.consumed_at);
  SELECT CASE changes()
    WHEN 0 THEN RAISE(ABORT, 'ARMADILLO_TICKET_UNAVAILABLE')
  END;
END;

CREATE INDEX IF NOT EXISTS _armadillo_ticket_consumptions_actor
  ON _armadillo_ticket_consumptions (app_id, consumed_by, consumed_at DESC);
` },
  { id: "0007_realtime_webhooks.sql", checksum: "68d113421de9f9f1787575fb39b25892c934619cca8618aa61c38e8c8a720423", sql: `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _armadillo_realtime_connections (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channels TEXT NOT NULL CHECK (json_valid(channels) AND json_type(channels) = 'array'),
  connected_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_realtime_connections_user
  ON _armadillo_realtime_connections (app_id, user_id, connected_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_realtime_connections_heartbeat
  ON _armadillo_realtime_connections (last_heartbeat);

CREATE TABLE IF NOT EXISTS _armadillo_webhook_jobs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  webhook_name TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  signature TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  backoff TEXT NOT NULL CHECK (backoff IN ('fixed', 'exponential')),
  initial_delay_ms INTEGER NOT NULL CHECK (initial_delay_ms >= 0),
  next_retry_at TEXT,
  last_status INTEGER,
  last_response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_webhook_jobs_ready
  ON _armadillo_webhook_jobs (next_retry_at, attempts);

CREATE TABLE IF NOT EXISTS _armadillo_webhook_deliveries (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'dead')),
  response_status INTEGER,
  response_body TEXT,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, job_id)
    REFERENCES _armadillo_webhook_jobs (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_webhook_deliveries_job
  ON _armadillo_webhook_deliveries (app_id, job_id, delivered_at DESC);
` },
  { id: "0008_api_key_lifecycle.sql", checksum: "aeb27fdeb193c8791ba3f6c1ec190097cdac27b21b04a84983f4379190af37a1", sql: `-- API keys are one-way credentials. This migration adds operational metadata
-- without ever retaining a recoverable plaintext secret.
ALTER TABLE _armadillo_api_keys ADD COLUMN description TEXT;
ALTER TABLE _armadillo_api_keys ADD COLUMN rotated_from TEXT;
ALTER TABLE _armadillo_api_keys ADD COLUMN grace_expires_at TEXT;

CREATE INDEX IF NOT EXISTS _armadillo_api_keys_grace_expiry
  ON _armadillo_api_keys (grace_expires_at);
` },
  { id: "0009_api_key_audit.sql", checksum: "1fd043b11858572fe63cdb931b37607d4984ce414bd7d9b8317ba0de51e12701", sql: `CREATE TABLE IF NOT EXISTS _armadillo_api_key_audit (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'rotated', 'revoked')),
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, key_id)
    REFERENCES _armadillo_api_keys (app_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (app_id, actor_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_api_key_audit_key
  ON _armadillo_api_key_audit (app_id, key_id, created_at DESC);
` },
  { id: "0010_gdpr.sql", checksum: "b13fbc20a445b652b7f5ffb3c9a43027b808eabb36d2848a13ef2e00d5659072", sql: `-- GDPR ledger: consent, export/erasure audit, restriction flag.

CREATE TABLE IF NOT EXISTS _armadillo_gdpr_consents (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK (granted IN (0,1)),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE,
  UNIQUE (app_id, user_id, purpose)
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_gdpr_consents_user
  ON _armadillo_gdpr_consents (app_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS _armadillo_gdpr_consents_purpose
  ON _armadillo_gdpr_consents (app_id, purpose);

CREATE TABLE IF NOT EXISTS _armadillo_gdpr_erasure_log (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('delete','anonymize')),
  reason TEXT,
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_gdpr_erasure_log_target
  ON _armadillo_gdpr_erasure_log (app_id, target_user_id, created_at DESC);

-- Optional restrict flag per user (Article 18). Small table, no FK to users so tombstones survive.
CREATE TABLE IF NOT EXISTS _armadillo_gdpr_restrictions (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  restricted INTEGER NOT NULL CHECK (restricted IN (0,1)),
  reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (app_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS _armadillo_gdpr_export_log (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_gdpr_export_log_user
  ON _armadillo_gdpr_export_log (app_id, user_id, created_at DESC);
` },
  { id: "0011_group_projection.sql", checksum: "3989d4de9f1dd14b79664eb30b30977624bb64ba5305e7c4f00471ab44a86335", sql: `-- The team pointer lives in the JSON document. group_id copies it into a column
-- so a member's records can be found from the membership index.
ALTER TABLE _armadillo_objects ADD COLUMN group_id TEXT;

CREATE INDEX IF NOT EXISTS _armadillo_objects_group
  ON _armadillo_objects (app_id, collection, group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS _armadillo_group_projection (
  app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  PRIMARY KEY (app_id, collection)
) STRICT;
` },
  { id: "0012_burrow.sql", checksum: "bc0044905ecdfbd4e6517357f425960f5943ccf709f3443bd55c70a842795a6e", sql: `-- SQLite cannot widen a CHECK constraint. Rebuild sessions so OAuth can be recorded,
-- and keep the one-time setup session, provider identity, and audit rows Burrow needs.
ALTER TABLE _armadillo_bootstrap ADD COLUMN schema_version TEXT;

CREATE TABLE _armadillo_sessions_oauth (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'password'
    CHECK (auth_method IN ('password', 'magic_link', 'oauth')),
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

INSERT INTO _armadillo_sessions_oauth
  (app_id, id, token_hash, user_id, created_at, expires_at, auth_method)
SELECT app_id, id, token_hash, user_id, created_at, expires_at, auth_method
FROM _armadillo_sessions;

DROP TABLE _armadillo_sessions;

ALTER TABLE _armadillo_sessions_oauth RENAME TO _armadillo_sessions;

CREATE INDEX _armadillo_sessions_user
  ON _armadillo_sessions (app_id, user_id);

CREATE INDEX _armadillo_sessions_expiry
  ON _armadillo_sessions (expires_at);

CREATE TABLE _armadillo_bootstrap_sessions (
  app_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, token_hash)
) STRICT;

CREATE INDEX _armadillo_bootstrap_sessions_expiry
  ON _armadillo_bootstrap_sessions (expires_at);

CREATE TABLE _armadillo_identities (
  app_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, provider, subject),
  FOREIGN KEY (app_id, user_id)
    REFERENCES _armadillo_users (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX _armadillo_identities_user
  ON _armadillo_identities (app_id, user_id);

CREATE TABLE _armadillo_oauth_states (
  app_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  redirect_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, state_hash)
) STRICT;

CREATE INDEX _armadillo_oauth_states_expiry
  ON _armadillo_oauth_states (expires_at);

CREATE TABLE _armadillo_audit (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX _armadillo_audit_recent
  ON _armadillo_audit (app_id, created_at DESC);
` },
  { id: "0013_profile_photo.sql", checksum: "24f092de65e3d3cdc4d70bad634994c6bac4ce87b2ce61aff25e608a2b409187", sql: `-- A user may link one owned image from the normal Files API to their profile.
ALTER TABLE _armadillo_users ADD COLUMN profile_photo_id TEXT;
` },
  { id: "0014_record_audit.sql", checksum: "e797db59d001e49d68330aa4871e4e206d80bae1973a922050ce2cb149ee74ad", sql: `-- Every record write appends one metadata-only row: who changed which record, when.
-- Record contents are never stored here. Deletes keep their history; nothing cascades.
CREATE TABLE _armadillo_record_audit (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX _armadillo_record_audit_recent
  ON _armadillo_record_audit (app_id, created_at DESC);

CREATE INDEX _armadillo_record_audit_record
  ON _armadillo_record_audit (app_id, table_name, record_id, created_at DESC);
` },
  { id: "0015_user_profile.sql", checksum: "ce6cc04254adfd539e314319c98bb0080b3cd3a5b7b61edd8605d42167b657da", sql: `ALTER TABLE _armadillo_users ADD COLUMN profile TEXT NOT NULL DEFAULT '{}';
` },
  { id: "0016_ticket_tokens.sql", checksum: "47122dea762bfa62dafeeb5e71fb6be9f87b00705930aad6b1e04b582ef998a9", sql: `-- Single-use inventory tokens for a tickets field. The raw token is never stored.
CREATE TABLE _armadillo_ticket_tokens (
  app_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  record_id TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  claim_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, token_hash)
) STRICT;

CREATE INDEX _armadillo_ticket_tokens_record
  ON _armadillo_ticket_tokens (app_id, collection, field, record_id);
` },
  { id: "0017_bridge.sql", checksum: "5589ee5d06bbf30deacc8713237dfa5c89cb2ae4bf5570483a25f3b550baaf1c", sql: `-- Claim tickets for agent enrollment. The raw token and the issued API key are never stored here.
CREATE TABLE _armadillo_bridge_invites (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  agent_class TEXT NOT NULL CHECK (agent_class IN ('muse', 'grok', 'generic')),
  name TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('issued', 'pending', 'approved', 'denied', 'paused', 'active', 'revoked')),
  fetch_count INTEGER NOT NULL DEFAULT 0 CHECK (fetch_count >= 0),
  expires_at TEXT NOT NULL,
  api_key_id TEXT,
  approved_scopes TEXT CHECK (approved_scopes IS NULL OR (json_valid(approved_scopes) AND json_type(approved_scopes) = 'array')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (app_id, owner_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, api_key_id) REFERENCES _armadillo_api_keys (app_id, id) ON DELETE SET NULL
) STRICT;

CREATE INDEX _armadillo_bridge_invites_owner
  ON _armadillo_bridge_invites (app_id, owner_id, created_at DESC);

CREATE TABLE _armadillo_bridge_jobs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'blocked', 'refused', 'completed', 'failed')),
  action TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  usage TEXT CHECK (usage IS NULL OR (json_valid(usage) AND json_type(usage) = 'object')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, agent_id) REFERENCES _armadillo_api_keys (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX _armadillo_bridge_jobs_agent
  ON _armadillo_bridge_jobs (app_id, agent_id, created_at DESC);

CREATE TABLE _armadillo_bridge_events (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  invite_id TEXT,
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX _armadillo_bridge_events_recent
  ON _armadillo_bridge_events (app_id, created_at DESC);
` },
  { id: "0018_usage_metering.sql", checksum: "994de3492fa510eacd91bebdc85112b4ff574f04c0dea0e977d94d5970c29b86", sql: `-- Daily UTC usage rollups. Counts only — no PII, no record contents, no credentials.
CREATE TABLE _armadillo_usage_rollups (
  app_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, day_utc, metric)
) STRICT;

CREATE INDEX _armadillo_usage_rollups_day
  ON _armadillo_usage_rollups (app_id, day_utc DESC);
` },
  { id: "0019_scheduled_functions.sql", checksum: "8a26003a367847297e05064fdb3e30eab581cfcd059fa4437ca4c1e902cac5c9", sql: `-- User-defined schedule runtime state and run history.
-- Counts and outcomes only — no record contents, secrets, or credentials.
CREATE TABLE _armadillo_schedule_state (
  app_id TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  next_due_at TEXT,
  running_at TEXT,
  running_run_id TEXT,
  pending_attempt INTEGER NOT NULL DEFAULT 1 CHECK (pending_attempt >= 1),
  last_run_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, schedule_name)
) STRICT;

CREATE TABLE _armadillo_schedule_runs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'success', 'failure', 'skipped', 'timeout', 'dead')),
  error_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX _armadillo_schedule_runs_schedule
  ON _armadillo_schedule_runs (app_id, schedule_name, created_at DESC);

CREATE INDEX _armadillo_schedule_runs_outcome
  ON _armadillo_schedule_runs (app_id, outcome, created_at DESC);
` },
 ] as const satisfies readonly SqlMigration[];

/** Database history version, independent of package and HTTP API versions. */
export const DATABASE_MIGRATION_VERSION = migrations[migrations.length - 1]!.id;
