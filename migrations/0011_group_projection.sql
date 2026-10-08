-- The team pointer lives in the JSON document. group_id copies it into a column
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
