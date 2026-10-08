PRAGMA foreign_keys = ON;

-- Collectors intentionally write into a dedicated inbox instead of opening a
-- generic table mutation surface. Anonymous submissions have a NULL user_id;
-- team/project routing is fixed by the server-side collector definition.
CREATE TABLE IF NOT EXISTS _armadillo_collector_submissions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  user_id TEXT,
  group_id TEXT NOT NULL,
  project_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, group_id)
    REFERENCES _armadillo_groups (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_collector_submissions_inbox
  ON _armadillo_collector_submissions (app_id, collector_id, group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_collector_submissions_expiry
  ON _armadillo_collector_submissions (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_tickets (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  holder_id TEXT,
  label TEXT NOT NULL,
  event_id TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  expires_at TEXT,
  consumed_at TEXT,
  consumed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, team_id) REFERENCES _armadillo_groups (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_tickets_team
  ON _armadillo_tickets (app_id, team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_tickets_holder
  ON _armadillo_tickets (app_id, holder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_tickets_expiry
  ON _armadillo_tickets (expires_at);

CREATE TABLE IF NOT EXISTS _armadillo_ticket_consumptions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  consumed_by TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, ticket_id),
  UNIQUE (app_id, ticket_id, idempotency_key),
  FOREIGN KEY (app_id, ticket_id) REFERENCES _armadillo_tickets (app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, consumed_by) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS _armadillo_ticket_consume
BEFORE INSERT ON _armadillo_ticket_consumptions
FOR EACH ROW
BEGIN
  UPDATE _armadillo_tickets
     SET consumed_at = NEW.consumed_at,
         consumed_by = NEW.consumed_by,
         updated_at = NEW.consumed_at
   WHERE app_id = NEW.app_id
     AND id = NEW.ticket_id
     AND consumed_at IS NULL
     AND (expires_at IS NULL OR expires_at > NEW.consumed_at);
  SELECT CASE changes()
    WHEN 0 THEN RAISE(ABORT, 'ARMADILLO_TICKET_UNAVAILABLE')
  END;
END;

CREATE INDEX IF NOT EXISTS _armadillo_ticket_consumptions_actor
  ON _armadillo_ticket_consumptions (app_id, consumed_by, consumed_at DESC);
