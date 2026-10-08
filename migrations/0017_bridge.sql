-- Claim tickets for agent enrollment. The raw token and the issued API key are never stored here.
CREATE TABLE _armadillo_bridge_invites (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  agent_class TEXT NOT NULL CHECK (agent_class IN ('muse', 'grok', 'generic')),
  name TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('issued', 'pending', 'approved', 'denied', 'paused', 'active', 'revoked')),
  fetch_count INTEGER NOT NULL DEFAULT 0 CHECK (fetch_count >= 0),
  expires_at TEXT NOT NULL,
  api_key_id TEXT,
  approved_scopes TEXT CHECK (approved_scopes IS NULL OR (json_valid(approved_scopes) AND json_type(approved_scopes) = 'array')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (app_id, owner_id) REFERENCES _armadillo_users (app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, api_key_id) REFERENCES _armadillo_api_keys (app_id, id) ON DELETE SET NULL
) STRICT;

CREATE INDEX _armadillo_bridge_invites_owner
  ON _armadillo_bridge_invites (app_id, owner_id, created_at DESC);

CREATE TABLE _armadillo_bridge_jobs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'blocked', 'refused', 'completed', 'failed')),
  action TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  usage TEXT CHECK (usage IS NULL OR (json_valid(usage) AND json_type(usage) = 'object')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, agent_id) REFERENCES _armadillo_api_keys (app_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX _armadillo_bridge_jobs_agent
  ON _armadillo_bridge_jobs (app_id, agent_id, created_at DESC);

CREATE TABLE _armadillo_bridge_events (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  invite_id TEXT,
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, id)
) STRICT;

CREATE INDEX _armadillo_bridge_events_recent
  ON _armadillo_bridge_events (app_id, created_at DESC);
