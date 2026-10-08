-- User-defined schedule runtime state and run history.
-- Counts and outcomes only — no record contents, secrets, or credentials.
CREATE TABLE _armadillo_schedule_state (
  app_id TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  next_due_at TEXT,
  running_at TEXT,
  running_run_id TEXT,
  pending_attempt INTEGER NOT NULL DEFAULT 1 CHECK (pending_attempt >= 1),
  last_run_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, schedule_name)
) STRICT;

CREATE TABLE _armadillo_schedule_runs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'success', 'failure', 'skipped', 'timeout', 'dead')),
  error_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX _armadillo_schedule_runs_schedule
  ON _armadillo_schedule_runs (app_id, schedule_name, created_at DESC);

CREATE INDEX _armadillo_schedule_runs_outcome
  ON _armadillo_schedule_runs (app_id, outcome, created_at DESC);
