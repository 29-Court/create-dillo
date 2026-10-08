-- Every record write appends one metadata-only row: who changed which record, when.
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
