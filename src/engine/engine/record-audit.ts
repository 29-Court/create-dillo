import type { ArmadilloStatement } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { INTERNAL_TABLES } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
import { makeId } from "./helpers/id.js";

export type RecordAuditAction = "created" | "updated" | "deleted";

export interface RecordAuditEntry {
  table: string;
  recordId: string;
  action: RecordAuditAction;
  actorId: string;
  createdAt: string;
}

export interface InternalRecordAuditRow {
  id: string;
  table_name: string;
  record_id: string;
  action: string;
  actor_id: string;
  created_at: string;
}

/**
 * One metadata-only audit row for a record mutation. Callers add the returned
 * statement to the same batch as the mutation so a committed write always has
 * its audit row and a failed write never does. Record contents are never stored.
 */
export function recordAuditStatement(
  env: ArmadilloEnv,
  appId: string,
  entry: RecordAuditEntry,
): ArmadilloStatement {
  return env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.recordAudit}
       (app_id, id, table_name, record_id, action, actor_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(appId, makeId("audit"), entry.table, entry.recordId, entry.action, entry.actorId, entry.createdAt);
}

export function recordAuditJson(row: InternalRecordAuditRow): JsonObject {
  return {
    id: row.id,
    table: row.table_name,
    recordId: row.record_id,
    action: row.action,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}
