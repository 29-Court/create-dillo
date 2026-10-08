-- Single-use inventory tokens for a tickets field. The raw token is never stored.
CREATE TABLE _armadillo_ticket_tokens (
  app_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  record_id TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  claim_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, token_hash)
) STRICT;

CREATE INDEX _armadillo_ticket_tokens_record
  ON _armadillo_ticket_tokens (app_id, collection, field, record_id);
