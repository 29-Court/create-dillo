-- Daily UTC usage rollups. Counts only — no PII, no record contents, no credentials.
CREATE TABLE _armadillo_usage_rollups (
  app_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, day_utc, metric)
) STRICT;

CREATE INDEX _armadillo_usage_rollups_day
  ON _armadillo_usage_rollups (app_id, day_utc DESC);
