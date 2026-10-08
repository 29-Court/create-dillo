-- GDPR ledger: consent, export/erasure audit, restriction flag.

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
