PRAGMA foreign_keys = ON;

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
