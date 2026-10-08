PRAGMA foreign_keys = ON;

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
