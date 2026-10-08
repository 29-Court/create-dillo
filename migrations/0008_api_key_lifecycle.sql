-- API keys are one-way credentials. This migration adds operational metadata
-- without ever retaining a recoverable plaintext secret.
ALTER TABLE _armadillo_api_keys ADD COLUMN description TEXT;
ALTER TABLE _armadillo_api_keys ADD COLUMN rotated_from TEXT;
ALTER TABLE _armadillo_api_keys ADD COLUMN grace_expires_at TEXT;

CREATE INDEX IF NOT EXISTS _armadillo_api_keys_grace_expiry
  ON _armadillo_api_keys (grace_expires_at);
