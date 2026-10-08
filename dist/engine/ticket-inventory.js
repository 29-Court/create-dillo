import { readStoredTickets, ticketRemaining } from "../schema.js";
import { physicalTableName } from "../schema-migrations.js";
import { INTERNAL_TABLES } from "../internal-schema.js";
import {} from "./environment.js";
import {} from "../backend.js";
import { validName } from "./apps.js";
import { requireAuth } from "./auth.js";
import { FIELD, HttpError, json } from "./http.js";
import { readJson } from "./validation.js";
import { sha256 } from "./helpers/crypto.js";
import { base64Url, makeId, randomBytes } from "./helpers/id.js";
import {
  findObject,
  now,
  physicalFields,
  physicalRowAsObject,
  sqlIdentifier
} from "./records.js";
function ticketsField(definition, collection) {
  const table = definition?.normalized.tables[collection];
  if (!table) return void 0;
  const entries = Object.entries(table.fields).filter(([, field]) => field.type === "tickets");
  const chosen = entries.find(([name]) => name === "tickets") ?? (entries.length === 1 ? entries[0] : void 0);
  if (!chosen || !FIELD.test(chosen[0])) return void 0;
  return { name: chosen[0], table };
}
function columnAvailable(column) {
  return `json_type(${column}, '$.supply') IN ('integer', 'real')
    AND CAST(json_extract(${column}, '$.sold') AS INTEGER) < CAST(json_extract(${column}, '$.supply') AS INTEGER)`;
}
function jsonAvailable(fieldName) {
  return `json_type(data, '$.${fieldName}.supply') IN ('integer', 'real')
    AND CAST(json_extract(data, '$.${fieldName}.sold') AS INTEGER)
      < CAST(json_extract(data, '$.${fieldName}.supply') AS INTEGER)`;
}
async function loadRecord(env, appId, collection, id, definition) {
  const table = definition?.normalized.tables[collection];
  if (table?.storage === "columns") {
    const fields = physicalFields(table).map(sqlIdentifier).join(", ");
    const row = await env.DB.prepare(
      `SELECT id, owner_id, ${fields}, created_at, updated_at
         FROM ${sqlIdentifier(physicalTableName(appId, collection))}
        WHERE app_id = ?1 AND id = ?2
        LIMIT 1`
    ).bind(appId, id).first();
    return row ? physicalRowAsObject(row, table) : null;
  }
  return env.DB.prepare(
    `SELECT id, owner_id, data, created_at, updated_at
       FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ?1 AND collection = ?2 AND id = ?3
      LIMIT 1`
  ).bind(appId, collection, id).first();
}
async function readToken(env, appId, tokenHash) {
  return env.DB.prepare(
    `SELECT collection, field, record_id, consumed_at
       FROM ${INTERNAL_TABLES.ticketTokens}
      WHERE app_id = ?1 AND token_hash = ?2
      LIMIT 1`
  ).bind(appId, tokenHash).first();
}
function remainingOf(row, fieldName) {
  const data = JSON.parse(row.data);
  return ticketRemaining(data[fieldName]);
}
function deny(code) {
  return json({ error: { code, message: code } }, 409);
}
function admit(remaining, idempotent) {
  return json({
    ok: true,
    remaining,
    soldOut: remaining === 0,
    ...idempotent ? { idempotent: true } : {}
  });
}
function changed(result) {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
async function ticketInventoryRoute(request, env, appId, collection, action, definition) {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(collection, "Table name");
  const field = ticketsField(definition, collection);
  if (!field) throw new HttpError(404, "NOT_FOUND", "This table has no tickets field.");
  if (action === "issue") return issue(request, env, appId, collection, field.name, field.table, definition);
  return consume(request, env, appId, collection, field.name, field.table, definition);
}
async function issue(request, env, appId, collection, fieldName, fieldTable, definition) {
  const auth = await requireAuth(request, env, appId, "tables:write");
  const body = await readJson(request, env);
  const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
  if (!recordId || recordId.length > 160) {
    throw new HttpError(422, "VALIDATION_ERROR", "Record id is invalid.", {
      recordId: "Use the record id"
    });
  }
  const row = await loadRecord(env, appId, collection, recordId, definition);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (row.owner_id !== auth.user.id) throw new HttpError(403, "FORBIDDEN", "Only the owner can issue a token.");
  if (fieldTable.writes === "none" || fieldTable.team?.writes === "none") {
    throw new HttpError(403, "FORBIDDEN", "This table does not accept record writes.");
  }
  const token = `tik_${base64Url(randomBytes(24))}`;
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.ticketTokens}
       (app_id, token_hash, collection, field, record_id, consumed_at, consumed_by, claim_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6)`
  ).bind(appId, await sha256(token), collection, fieldName, recordId, now()).run();
  return json({ token }, 201);
}
async function consume(request, env, appId, collection, fieldName, table, definition) {
  const auth = await requireAuth(request, env, appId, "tables:read");
  const body = await readJson(request, env);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 500) {
    throw new HttpError(422, "VALIDATION_ERROR", "Token is invalid.", { token: "Enter a token" });
  }
  const tokenHash = await sha256(token);
  const existingToken = await readToken(env, appId, tokenHash);
  if (!existingToken || existingToken.collection !== collection || existingToken.field !== fieldName) {
    throw new HttpError(404, "NOT_FOUND", "Token is invalid.");
  }
  const visible = await findObject(
    env,
    appId,
    collection,
    existingToken.record_id,
    definition,
    auth.user.id,
    false
  );
  if (!visible) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (existingToken.consumed_at) return admit(remainingOf(visible, fieldName), true);
  const visibleData = JSON.parse(visible.data);
  const state = readStoredTickets(visibleData[fieldName]);
  if (!state || state.supply === null) return deny("SUPPLY_UNSET");
  if (state.sold >= state.supply) return deny("SOLD_OUT");
  if (!env.DB.batch) throw new HttpError(500, "INTERNAL_ERROR", "Ticket consume requires a database batch.");
  const timestamp = now();
  const nonce = makeId("claim");
  const recordId = existingToken.record_id;
  const available = table.storage === "columns" ? `EXISTS (
        SELECT 1 FROM ${sqlIdentifier(physicalTableName(appId, collection))}
        WHERE app_id = ?4 AND id = ?8 AND ${columnAvailable(sqlIdentifier(fieldName))}
      )` : `EXISTS (
        SELECT 1 FROM ${INTERNAL_TABLES.objects}
        WHERE app_id = ?4 AND collection = ?6 AND id = ?8 AND ${jsonAvailable(fieldName)}
      )`;
  const claim = env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.ticketTokens}
        SET consumed_at = ?1, consumed_by = ?2, claim_id = ?3
      WHERE app_id = ?4 AND token_hash = ?5 AND consumed_at IS NULL
        AND collection = ?6 AND field = ?7 AND record_id = ?8
        AND ${available}`
  ).bind(timestamp, auth.user.id, nonce, appId, tokenHash, collection, fieldName, recordId);
  const increment = incrementStatement(env, appId, collection, fieldName, table, recordId, timestamp);
  const audit = env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.recordAudit}
       (app_id, id, table_name, record_id, action, actor_id, created_at)
     SELECT ?1, ?2, ?3, ?4, 'updated', ?5, ?6
     WHERE changes() = 1`
  ).bind(appId, makeId("audit"), collection, recordId, auth.user.id, timestamp);
  const guard = env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.ticketTokens}
       (app_id, token_hash, collection, field, record_id, created_at)
     SELECT app_id, token_hash, collection, field, record_id, created_at
       FROM ${INTERNAL_TABLES.ticketTokens}
      WHERE app_id = ?1 AND token_hash = ?2 AND claim_id = ?3 AND changes() = 0`
  ).bind(appId, tokenHash, nonce);
  let results;
  try {
    results = await env.DB.batch([claim, increment, audit, guard]);
  } catch (error) {
    const tokenRow2 = await readToken(env, appId, tokenHash);
    const row2 = tokenRow2 ? await loadRecord(env, appId, collection, tokenRow2.record_id, definition) : null;
    const afterData2 = row2 ? JSON.parse(row2.data) : void 0;
    const after2 = afterData2 ? readStoredTickets(afterData2[fieldName]) : void 0;
    if (!tokenRow2?.consumed_at && after2 && after2.supply !== null && after2.sold >= after2.supply) return deny("SOLD_OUT");
    if (!tokenRow2?.consumed_at && after2?.supply === null) return deny("SUPPLY_UNSET");
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "INTERNAL_ERROR", "Ticket consume did not commit.");
  }
  const row = await loadRecord(env, appId, collection, recordId, definition);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (changed(results[0]) >= 1) return admit(remainingOf(row, fieldName), false);
  const tokenRow = await readToken(env, appId, tokenHash);
  if (tokenRow?.consumed_at) return admit(remainingOf(row, fieldName), true);
  const afterData = JSON.parse(row.data);
  const after = readStoredTickets(afterData[fieldName]);
  if (!after || after.supply === null) return deny("SUPPLY_UNSET");
  if (after.sold >= after.supply) return deny("SOLD_OUT");
  throw new HttpError(500, "INTERNAL_ERROR", "Ticket consume did not commit.");
}
function incrementStatement(env, appId, collection, fieldName, table, recordId, timestamp) {
  if (table.storage === "columns") {
    const column = sqlIdentifier(fieldName);
    return env.DB.prepare(
      `UPDATE ${sqlIdentifier(physicalTableName(appId, collection))}
          SET ${column} = json_set(${column}, '$.sold', json_extract(${column}, '$.sold') + 1),
              updated_at = ?1
        WHERE app_id = ?2 AND id = ?3
          AND changes() = 1
          AND ${columnAvailable(column)}`
    ).bind(timestamp, appId, recordId);
  }
  return env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.objects}
        SET data = json_set(data, '$.${fieldName}.sold', json_extract(data, '$.${fieldName}.sold') + 1),
            updated_at = ?1
      WHERE app_id = ?2 AND collection = ?3 AND id = ?4
        AND changes() = 1
        AND ${jsonAvailable(fieldName)}`
  ).bind(timestamp, appId, collection, recordId);
}
export {
  ticketInventoryRoute
};
