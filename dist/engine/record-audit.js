import {} from "../backend.js";
import { INTERNAL_TABLES } from "../backend.js";
import {} from "./environment.js";
import { makeId } from "./helpers/id.js";
function recordAuditStatement(env, appId, entry) {
  return env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.recordAudit}
       (app_id, id, table_name, record_id, action, actor_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(appId, makeId("audit"), entry.table, entry.recordId, entry.action, entry.actorId, entry.createdAt);
}
function recordAuditJson(row) {
  return {
    id: row.id,
    table: row.table_name,
    recordId: row.record_id,
    action: row.action,
    actorId: row.actor_id,
    createdAt: row.created_at
  };
}
export {
  recordAuditJson,
  recordAuditStatement
};
