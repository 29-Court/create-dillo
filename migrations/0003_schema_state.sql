PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _armadillo_schema_state (
  app_id TEXT NOT NULL PRIMARY KEY,
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
