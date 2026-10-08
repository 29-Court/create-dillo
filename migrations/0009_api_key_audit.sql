CREATE TABLE IF NOT EXISTS _armadillo_api_key_audit (
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
