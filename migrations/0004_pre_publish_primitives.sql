PRAGMA foreign_keys = ON;

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
