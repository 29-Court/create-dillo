PRAGMA foreign_keys = ON;

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
