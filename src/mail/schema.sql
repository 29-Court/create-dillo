-- 29Court Dillo Mail — D1 schema (P2 build, 2026-11-10).
--
-- Home: the ONE physical D1 `29court` (apparatus stack). The mail primitive
-- owns exactly one table, `dillo_mail_outbox` (the promoted accounts outbox),
-- carrying the `dillo_` prefix so it can never collide with Drive (`drive_*`),
-- Photos (`photos_*`), Vault (`dillo_*`) or Desk (`desk_*`) in the same DB.
--
-- Migration: db/migrations/0012-dillo-mail.json carries this DDL verbatim.
-- Gate: db/gate_train.py check-sql BEFORE any upload (run_gate_proof.py P15).
-- No runtime DDL: the Worker never runs CREATE TABLE; the outbox is written
-- to, never migrated at request time.
--
-- Conventions: timestamps are INTEGER unix milliseconds. The outbox row id IS
-- the message trace id (Scope Addendum 2 §3) — every log line the primitive
-- emits carries it. One row per message: queued -> sent / failed / no_mailer,
-- with provider message id and bounded attempts (no retry storm).
-- Secret rule (absolute): no secret, token, or key value ever lands in any
-- column here. The `detail` column carries a failure reason only, truncated.

CREATE TABLE IF NOT EXISTS dillo_mail_outbox (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT,
  kind                 TEXT NOT NULL,
  to_email             TEXT NOT NULL,
  from_email           TEXT,
  subject              TEXT,
  status               TEXT NOT NULL,       -- 'queued' | 'sent' | 'failed' | 'no_mailer'
  provider_message_id  TEXT,
  detail               TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  idempotency_key      TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dillo_mail_outbox_kind ON dillo_mail_outbox(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_dillo_mail_outbox_status ON dillo_mail_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dillo_mail_outbox_idem ON dillo_mail_outbox(idempotency_key);