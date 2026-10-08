-- SQLite cannot widen a CHECK constraint. Rebuild sessions so OAuth can be recorded,
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
