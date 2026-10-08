PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _armadillo_realtime_connections (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channels TEXT NOT NULL CHECK (json_valid(channels) AND json_type(channels) = 'array'),
  connected_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, user_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_realtime_connections_user
  ON _armadillo_realtime_connections (app_id, user_id, connected_at DESC);

CREATE INDEX IF NOT EXISTS _armadillo_realtime_connections_heartbeat
  ON _armadillo_realtime_connections (last_heartbeat);

CREATE TABLE IF NOT EXISTS _armadillo_webhook_jobs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  webhook_name TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  signature TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  backoff TEXT NOT NULL CHECK (backoff IN ('fixed', 'exponential')),
  initial_delay_ms INTEGER NOT NULL CHECK (initial_delay_ms >= 0),
  next_retry_at TEXT,
  last_status INTEGER,
  last_response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_webhook_jobs_ready
  ON _armadillo_webhook_jobs (next_retry_at, attempts);

CREATE TABLE IF NOT EXISTS _armadillo_webhook_deliveries (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'dead')),
  response_status INTEGER,
  response_body TEXT,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, job_id)
    REFERENCES _armadillo_webhook_jobs (app_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS _armadillo_webhook_deliveries_job
  ON _armadillo_webhook_deliveries (app_id, job_id, delivered_at DESC);
