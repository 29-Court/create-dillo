import type { ArmadilloStatement } from "../backend.js";
import { type JsonObject } from "../backend.js";
import { type ArmadilloEnv } from "./environment.js";
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
export declare function recordAuditStatement(env: ArmadilloEnv, appId: string, entry: RecordAuditEntry): ArmadilloStatement;
export declare function recordAuditJson(row: InternalRecordAuditRow): JsonObject;
