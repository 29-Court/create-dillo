import { type NormalizedTable, type SchemaDefinition, readStoredTickets, ticketRemaining } from "../schema.js";
import { physicalTableName } from "../schema-migrations.js";
import { INTERNAL_TABLES, type InternalObjectRow } from "../internal-schema.js";
import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloStatement } from "../backend.js";
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
  sqlIdentifier,
  type PhysicalObjectRow,
} from "./records.js";

/**
 * Record inventory tokens. One scan, one use. This is not the team ticket engine
 * in tickets.ts, and it does not call requireTeamPolicy.
 */
interface TokenRow {
  collection: string;
  field: string;
  record_id: string;
  consumed_at: string | null;
}

function ticketsField(
  definition: SchemaDefinition | undefined,
  collection: string,
): { name: string; table: NormalizedTable } | undefined {
  const table = definition?.normalized.tables[collection];
  if (!table) return undefined;
  const entries = Object.entries(table.fields).filter(([, field]) => field.type === "tickets");
  const chosen = entries.find(([name]) => name === "tickets") ?? (entries.length === 1 ? entries[0] : undefined);
  if (!chosen || !FIELD.test(chosen[0])) return undefined;
  return { name: chosen[0], table };
}

function columnAvailable(column: string): string {
  return `json_type(${column}, '$.supply') IN ('integer', 'real')
    AND CAST(json_extract(${column}, '$.sold') AS INTEGER) < CAST(json_extract(${column}, '$.supply') AS INTEGER)`;
}

function jsonAvailable(fieldName: string): string {
  return `json_type(data, '$.${fieldName}.supply') IN ('integer', 'real')
    AND CAST(json_extract(data, '$.${fieldName}.sold') AS INTEGER)
      < CAST(json_extract(data, '$.${fieldName}.supply') AS INTEGER)`;
}

async function loadRecord(
  env: ArmadilloEnv,
  appId: string,
  collection: string,
  id: string,
  definition: SchemaDefinition | undefined,
): Promise<InternalObjectRow | null> {
  const table = definition?.normalized.tables[collection];
  if (table?.storage === "columns") {
    const fields = physicalFields(table).map(sqlIdentifier).join(", ");
    const row = await env.DB.prepare(
      `SELECT id, owner_id, ${fields}, created_at, updated_at
         FROM ${sqlIdentifier(physicalTableName(appId, collection))}
        WHERE app_id = ?1 AND id = ?2
        LIMIT 1`,
    ).bind(appId, id).first<PhysicalObjectRow>();
    return row ? physicalRowAsObject(row, table) : null;
  }
  return env.DB.prepare(
    `SELECT id, owner_id, data, created_at, updated_at
       FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ?1 AND collection = ?2 AND id = ?3
      LIMIT 1`,
  ).bind(appId, collection, id).first<InternalObjectRow>();
}

async function readToken(env: ArmadilloEnv, appId: string, tokenHash: string): Promise<TokenRow | null> {
  return env.DB.prepare(
    `SELECT collection, field, record_id, consumed_at
       FROM ${INTERNAL_TABLES.ticketTokens}
      WHERE app_id = ?1 AND token_hash = ?2
      LIMIT 1`,
  ).bind(appId, tokenHash).first<TokenRow>();
}

function remainingOf(row: InternalObjectRow, fieldName: string): number | null {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return ticketRemaining(data[fieldName]);
}

function deny(code: "SUPPLY_UNSET" | "SOLD_OUT"): Response {
  return json({ error: { code, message: code } }, 409);
}

function admit(remaining: number | null, idempotent: boolean): Response {
  return json({
    ok: true,
    remaining,
    soldOut: remaining === 0,
    ...(idempotent ? { idempotent: true } : {}),
  });
}

function changed(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return typeof changes === "number" ? changes : 0;
}

export async function ticketInventoryRoute(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  collection: string,
  action: "issue" | "consume",
  definition: SchemaDefinition | undefined,
): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(collection, "Table name");
  const field = ticketsField(definition, collection);
  if (!field) throw new HttpError(404, "NOT_FOUND", "This table has no tickets field.");
  if (action === "issue") return issue(request, env, appId, collection, field.name, field.table, definition);
  return consume(request, env, appId, collection, field.name, field.table, definition);
}

async function issue(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  collection: string,
  fieldName: string,
  fieldTable: NormalizedTable,
  definition: SchemaDefinition | undefined,
): Promise<Response> {
  const auth = await requireAuth(request, env, appId, "tables:write");
  const body = await readJson(request, env);
  const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
  if (!recordId || recordId.length > 160) {
    throw new HttpError(422, "VALIDATION_ERROR", "Record id is invalid.", {
      recordId: "Use the record id",
    });
  }
  const row = await loadRecord(env, appId, collection, recordId, definition);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (row.owner_id !== auth.user.id) throw new HttpError(403, "FORBIDDEN", "Only the owner can issue a token.");
  // `loadRecord` deliberately reads without an access clause so an owner can
  // issue a token for a row on a table whose read roles exclude them. That is
  // only sound while the table actually has a working inventory path: on a
  // `writes: "none"` table the record API is closed to everyone, so minting a
  // consume token here would be a write through a side door.
  if (fieldTable.writes === "none" || fieldTable.team?.writes === "none") {
    throw new HttpError(403, "FORBIDDEN", "This table does not accept record writes.");
  }
  const token = `tik_${base64Url(randomBytes(24))}`;
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.ticketTokens}
       (app_id, token_hash, collection, field, record_id, consumed_at, consumed_by, claim_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6)`,
  ).bind(appId, await sha256(token), collection, fieldName, recordId, now()).run();
  return json({ token }, 201);
}

async function consume(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  collection: string,
  fieldName: string,
  table: NormalizedTable,
  definition: SchemaDefinition | undefined,
): Promise<Response> {
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
    false,
  );
  if (!visible) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (existingToken.consumed_at) return admit(remainingOf(visible, fieldName), true);

  const visibleData = JSON.parse(visible.data) as Record<string, unknown>;
  const state = readStoredTickets(visibleData[fieldName]);
  if (!state || state.supply === null) return deny("SUPPLY_UNSET");
  if (state.sold >= state.supply) return deny("SOLD_OUT");
  if (!env.DB.batch) throw new HttpError(500, "INTERNAL_ERROR", "Ticket consume requires a database batch.");

  const timestamp = now();
  const nonce = makeId("claim");
  const recordId = existingToken.record_id;
  const available = table.storage === "columns"
    ? `EXISTS (
        SELECT 1 FROM ${sqlIdentifier(physicalTableName(appId, collection))}
        WHERE app_id = ?4 AND id = ?8 AND ${columnAvailable(sqlIdentifier(fieldName))}
      )`
    : `EXISTS (
        SELECT 1 FROM ${INTERNAL_TABLES.objects}
        WHERE app_id = ?4 AND collection = ?6 AND id = ?8 AND ${jsonAvailable(fieldName)}
      )`;
  const claim = env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.ticketTokens}
        SET consumed_at = ?1, consumed_by = ?2, claim_id = ?3
      WHERE app_id = ?4 AND token_hash = ?5 AND consumed_at IS NULL
        AND collection = ?6 AND field = ?7 AND record_id = ?8
        AND ${available}`,
  ).bind(timestamp, auth.user.id, nonce, appId, tokenHash, collection, fieldName, recordId);
  const increment = incrementStatement(env, appId, collection, fieldName, table, recordId, timestamp);
  // changes() is 1 only after the sold increment. A miss, a replay, and a
  // rolled-back claim insert no audit row. This sits before the guard, which
  // keys off changes() = 0.
  const audit = env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.recordAudit}
       (app_id, id, table_name, record_id, action, actor_id, created_at)
     SELECT ?1, ?2, ?3, ?4, 'updated', ?5, ?6
     WHERE changes() = 1`,
  ).bind(appId, makeId("audit"), collection, recordId, auth.user.id, timestamp);
  const guard = env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.ticketTokens}
       (app_id, token_hash, collection, field, record_id, created_at)
     SELECT app_id, token_hash, collection, field, record_id, created_at
       FROM ${INTERNAL_TABLES.ticketTokens}
      WHERE app_id = ?1 AND token_hash = ?2 AND claim_id = ?3 AND changes() = 0`,
  ).bind(appId, tokenHash, nonce);

  let results: unknown[];
  try {
    results = await env.DB.batch([claim, increment, audit, guard]);
  } catch (error) {
    const tokenRow = await readToken(env, appId, tokenHash);
    const row = tokenRow ? await loadRecord(env, appId, collection, tokenRow.record_id, definition) : null;
    const afterData = row ? JSON.parse(row.data) as Record<string, unknown> : undefined;
    const after = afterData ? readStoredTickets(afterData[fieldName]) : undefined;
    if (!tokenRow?.consumed_at && after && after.supply !== null && after.sold >= after.supply) return deny("SOLD_OUT");
    if (!tokenRow?.consumed_at && after?.supply === null) return deny("SUPPLY_UNSET");
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "INTERNAL_ERROR", "Ticket consume did not commit.");
  }

  const row = await loadRecord(env, appId, collection, recordId, definition);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (changed(results[0]) >= 1) return admit(remainingOf(row, fieldName), false);
  const tokenRow = await readToken(env, appId, tokenHash);
  if (tokenRow?.consumed_at) return admit(remainingOf(row, fieldName), true);
  const afterData = JSON.parse(row.data) as Record<string, unknown>;
  const after = readStoredTickets(afterData[fieldName]);
  if (!after || after.supply === null) return deny("SUPPLY_UNSET");
  if (after.sold >= after.supply) return deny("SOLD_OUT");
  throw new HttpError(500, "INTERNAL_ERROR", "Ticket consume did not commit.");
}

function incrementStatement(
  env: ArmadilloEnv,
  appId: string,
  collection: string,
  fieldName: string,
  table: NormalizedTable,
  recordId: string,
  timestamp: string,
): ArmadilloStatement {
  if (table.storage === "columns") {
    const column = sqlIdentifier(fieldName);
    return env.DB.prepare(
      `UPDATE ${sqlIdentifier(physicalTableName(appId, collection))}
          SET ${column} = json_set(${column}, '$.sold', json_extract(${column}, '$.sold') + 1),
              updated_at = ?1
        WHERE app_id = ?2 AND id = ?3
          AND changes() = 1
          AND ${columnAvailable(column)}`,
    ).bind(timestamp, appId, recordId);
  }
  return env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.objects}
        SET data = json_set(data, '$.${fieldName}.sold', json_extract(data, '$.${fieldName}.sold') + 1),
            updated_at = ?1
      WHERE app_id = ?2 AND collection = ?3 AND id = ?4
        AND changes() = 1
        AND ${jsonAvailable(fieldName)}`,
  ).bind(timestamp, appId, collection, recordId);
}
