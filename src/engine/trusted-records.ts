import { INTERNAL_TABLES } from "../internal-schema.js";
import type { InternalObjectRow } from "../internal-schema.js";
import type { SchemaDefinition, NormalizedTable } from "../schema.js";
import type {
  ArmadilloRecord,
  ArmadilloTrustedCreateOptions,
  ArmadilloTrustedFile,
  ArmadilloTrustedGroup,
  ArmadilloTrustedGroups,
  ArmadilloTrustedQuery,
  ArmadilloTrustedRecords,
  JsonObject,
  JsonPrimitive,
} from "../backend.js";
import type { BindValue } from "./environment.js";
import type { ArmadilloEnv } from "./environment.js";
import { HttpError, maxFileBytes } from "./http.js";
import { boundedBody } from "./body.js";
import { validName } from "./apps.js";
import { makeId } from "./helpers/id.js";
import { grantMembership } from "./teams.js";
import { recordAccessClause } from "./permissions.js";
import { queryField, queryValue } from "./queries.js";
import { computedObjectJson, now, objectJson, recordGroupId } from "./records.js";
import { acceptsContentType, declaredFileLinkStatements, schemaData } from "./validation.js";
import type { ArmadilloBackendDefinition, ArmadilloStatement } from "../backend.js";
import { prepareWebhookEvent } from "./handlers/webhooks.js";
import { emitTableMutation } from "./events.js";
import { recordAuditStatement } from "./record-audit.js";
import { chargeUsage, withUsageCharge } from "./usage.js";

/**
 * Ceiling applied when a trusted file read does not ask for one. A whole-object
 * read is buffered, so the default has to be small enough to be safe in a
 * Worker isolate and large enough for documents and images.
 */
export const DEFAULT_TRUSTED_FILE_BYTES = 8 * 1024 * 1_024;

function requireTable(definition: SchemaDefinition | undefined, name: string): NormalizedTable {
  validName(name, "Table name");
  const table = definition?.normalized.tables[name];
  if (!table) throw new HttpError(404, "NOT_FOUND", `Table ${name} is not in this schema.`);
  if (table.storage !== "json") throw new HttpError(500, "INTERNAL_ERROR", "Trusted records support JSON tables.");
  return table;
}

function primitive(value: unknown, label: string): JsonPrimitive {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new HttpError(400, "BAD_REQUEST", `${label} accepts text, numbers, booleans, or null.`);
}

/**
 * Change count from one batch statement result, when the adapter reports it.
 * Both shipped adapters (local SQLite, D1) return per-statement `{ meta: { changes } }`;
 * the public `batch()` contract only promises `unknown[]`, so a missing count
 * is `undefined` rather than zero — never treat silence as a failed write.
 */
function batchChanges(outcome: unknown): number | undefined {
  if (!outcome || typeof outcome !== "object") return undefined;
  const meta = (outcome as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return undefined;
  const changes = (meta as { changes?: unknown }).changes;
  return typeof changes === "number" ? changes : undefined;
}

function groupSet(table: NormalizedTable, data: JsonObject, parameters: BindValue[]): string {
  if (!table.team || !Object.hasOwn(data, table.team.field)) return "";
  parameters.push(recordGroupId(table, data));
  return ", group_id = ?";
}

function recordFrom(definition: SchemaDefinition | undefined, collection: string, row: InternalObjectRow): ArmadilloRecord {
  return computedObjectJson(definition, collection, objectJson(row)) as ArmadilloRecord;
}

/** Every target role grant must already exist on the source. No list means every member. */
function rolesNarrower(target: readonly string[] | undefined, source: readonly string[] | undefined): boolean {
  if (source === undefined) return true;
  if (target === undefined) return false;
  return target.every((role) => source.includes(role));
}

const OUTSIDE_SOURCE_AUDIENCE = "Promote into a table whose audience is within the source audience.";

/**
 * An owner-private target copies the source owner, so the owner must already
 * read the source row. Ask the same clause GET uses: a team table that never
 * granted the owner a read role would otherwise hand them a private copy.
 */
async function assertOwnerReadsSource(
  env: ArmadilloEnv,
  currentAppId: string,
  sourceName: string,
  source: NormalizedTable,
  target: NormalizedTable,
  row: InternalObjectRow,
): Promise<void> {
  if (!source.team || target.team) return;
  if (source.read === "public" || target.read === "public") return;
  const parameters: BindValue[] = [];
  const access = recordAccessClause(source, currentAppId, row.owner_id, parameters, false);
  if (!access) return;
  const visible = await env.DB.prepare(
    `SELECT 1 FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ? AND collection = ? AND id = ? AND ${access} LIMIT 1`,
  ).bind(currentAppId, sourceName, row.id, ...parameters).first();
  if (!visible) {
    throw new HttpError(
      409,
      "CONFLICT",
      `Promotion refused: the owner cannot read ${sourceName}. ${OUTSIDE_SOURCE_AUDIENCE}`,
    );
  }
}

/**
 * A promotion must not widen the audience through the target table policy:
 * no new readers, and no new writers beyond the source grants. Within the
 * same audience, the target table is the handler's explicit choice.
 */
function assertNarrowingPromotion(
  sourceName: string,
  source: NormalizedTable,
  targetName: string,
  target: NormalizedTable,
): void {
  const widen = (why: string): never => {
    throw new HttpError(
      409,
      "CONFLICT",
      `Promotion refused: ${why}. ${OUTSIDE_SOURCE_AUDIENCE}`,
    );
  };
  // Everyone could already read a public source, so every audience narrows it.
  if (source.read === "public") return;
  if (target.read === "public") widen(`${targetName} is publicly readable but ${sourceName} is not`);
  if (target.team && !source.team) widen(`${targetName} shares rows with a team but ${sourceName} is owner-private`);
  if (target.team && source.team) {
    if (!rolesNarrower(target.team.readRoles, source.team.readRoles)) {
      widen(`${targetName} is readable by team roles ${sourceName} does not grant`);
    }
    if (!rolesNarrower(target.team.writeRoles, source.team.writeRoles)
      || (target.team.ownerWrite === true && source.team.ownerWrite !== true
        && source.team.writeRoles !== undefined)) {
      widen(`${targetName} is writable by team roles ${sourceName} does not grant`);
    }
  }
}

async function validateTrustedLinks(
  env: ArmadilloEnv,
  appId: string,
  actorId: string,
  definition: SchemaDefinition | undefined,
  collection: string,
  data: JsonObject,
): Promise<void> {
  const fields = definition?.normalized.tables[collection]?.fields ?? {};
  const issues: Record<string, string> = {};
  await Promise.all(Object.entries(data).map(async ([fieldName, value]) => {
    const field = fields[fieldName];
    if (!field || value == null) return;
    if (typeof value !== "string") return;
    if (field.type === "file") {
      const stored = await env.DB.prepare(
        `SELECT content_type, size FROM ${INTERNAL_TABLES.files} WHERE app_id = ? AND id = ? AND owner_id = ? LIMIT 1`,
      ).bind(appId, value, actorId).first<{ content_type: string; size: number }>();
      if (!stored) issues[fieldName] = "Upload this file before attaching it";
      else if (field.contentTypes && !acceptsContentType(stored.content_type, field.contentTypes)) {
        issues[fieldName] = `Use ${field.contentTypes.join(" or ")}`;
      } else if (field.maxBytes !== undefined && stored.size > field.maxBytes) {
        issues[fieldName] = `File must be at most ${field.maxBytes} bytes`;
      }
      return;
    }
    if (field.type !== "pointer" || !field.target) return;
    let found: unknown;
    if (field.target === "_User") {
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.users} WHERE app_id = ? AND id = ? LIMIT 1`,
      ).bind(appId, value).first();
    } else if (field.target === "_Team") {
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.groups} WHERE app_id = ? AND id = ? LIMIT 1`,
      ).bind(appId, value).first();
    } else {
      const target = definition?.normalized.tables[field.target];
      if (target && target.storage !== "json") {
        throw new HttpError(500, "INTERNAL_ERROR", "Trusted records support JSON tables.");
      }
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.objects} WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`,
      ).bind(appId, field.target, value).first();
    }
    if (!found) issues[fieldName] = `Referenced ${field.target} does not exist`;
  }));
  if (Object.keys(issues).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Object references do not match its Armadillo schema.", issues);
  }
}

function fileStatements(
  env: ArmadilloEnv,
  appId: string,
  actorId: string,
  definition: SchemaDefinition | undefined,
  collection: string,
  objectId: string,
  data: JsonObject,
  table: NormalizedTable,
): ArmadilloStatement[] {
  const touches = Object.entries(table.fields).some(([name, field]) => field.type === "file" && typeof data[name] === "string");
  if (!touches) return [];
  return declaredFileLinkStatements(env, appId, actorId, definition, collection, objectId, data);
}

function whereSql(
  env: ArmadilloEnv,
  table: NormalizedTable,
  where: JsonObject,
  parameters: BindValue[],
): string {
  const clauses: string[] = [];
  for (const [field, raw] of Object.entries(where)) {
    const value = primitive(raw, `Filter ${field}`);
    const expression = queryField(field, parameters, env, table);
    if (value === null) {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    clauses.push(`${expression} = ?`);
    parameters.push(queryValue(value, table.fields[field], env) as BindValue);
  }
  return clauses.join(" AND ");
}

/** Integer option with the same fail-closed bounds the HTTP query parser uses. */
function boundedPage(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(422, "VALIDATION_ERROR", `patchWhere ${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

/** `json_set` path/value pairs. Booleans go through `json()` so SQLite stores true/false rather than 0/1. */
function patchExpression(data: JsonObject, parameters: BindValue[]): string {
  const parts: string[] = [];
  for (const [field, raw] of Object.entries(data)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(field)) {
      throw new HttpError(422, "VALIDATION_ERROR", `Field ${field} is invalid.`);
    }
    const value = primitive(raw, `Field ${field}`);
    parameters.push(`$.${field}`);
    if (value === null) parts.push("?, NULL");
    else if (typeof value === "boolean") {
      parameters.push(value ? "true" : "false");
      parts.push("?, json(?)");
    } else {
      parameters.push(value);
      parts.push("?, ?");
    }
  }
  if (parts.length === 0) throw new HttpError(422, "VALIDATION_ERROR", "Update data is empty.");
  return parts.join(", ");
}

export function trustedRecords(
  env: ArmadilloEnv,
  appId: string,
  backend: ArmadilloBackendDefinition,
  actorId: () => string,
): ArmadilloTrustedRecords {
  const definition = backend.schema;

  /**
   * Webhook event names match the REST record routes exactly, so subscribers
   * cannot tell (and do not need to tell) which path wrote the row.
   */
  function recordEventName(collection: string, action: "created" | "updated" | "deleted"): string {
    return `${collection.charAt(0).toLowerCase()}${collection.slice(1)}.${action}`;
  }

  /** Follow-on statements go through the adapter batch when it has one. */
  async function runStatements(statements: ArmadilloStatement[]): Promise<unknown[]> {
    if (statements.length === 0) return [];
    if (env.DB.batch) return env.DB.batch(statements);
    const outcomes: unknown[] = [];
    for (const statement of statements) outcomes.push(await statement.run());
    return outcomes;
  }
  function insert(
    collection: string,
    ownerId: string,
    encoded: string,
    objectId: string,
    timestamp: string,
  ): ArmadilloStatement {
    const groupId = recordGroupId(requireTable(definition, collection), JSON.parse(encoded) as JsonObject);
    return env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.objects}
         (app_id, collection, id, owner_id, group_id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(appId, collection, objectId, ownerId, groupId, encoded, timestamp, timestamp);
  }

  async function prepareCreate(collection: string, data: JsonObject, ownerId: string) {
    const table = requireTable(definition, collection);
    const validated = schemaData(definition, collection, data, false, env);
    await validateTrustedLinks(env, appId, actorId(), definition, collection, validated.data);
    const objectId = makeId(collection.toLowerCase());
    const timestamp = now();
    const row: InternalObjectRow = {
      id: objectId,
      owner_id: ownerId,
      data: validated.encoded,
      created_at: timestamp,
      updated_at: timestamp,
    };
    return { table, validated, objectId, timestamp, row, record: recordFrom(definition, collection, row) };
  }

  const api: ArmadilloTrustedRecords = {
    async get(collection, id) {
      requireTable(definition, collection);
      validName(id, "Record ID");
      const row = await env.DB.prepare(
        `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`,
      ).bind(appId, collection, id).first<InternalObjectRow>();
      if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
      return recordFrom(definition, collection, row);
    },
    async query(collection, query: ArmadilloTrustedQuery = {}) {
      const table = requireTable(definition, collection);
      const parameters: BindValue[] = [appId, collection];
      const clauses = ["app_id = ?", "collection = ?"];
      if (query.where) {
        const filters = whereSql(env, table, query.where, parameters);
        if (filters) clauses.push(filters);
      }
      for (const [field, value] of Object.entries(query.contains ?? {})) {
        if (typeof value !== "string") throw new HttpError(400, "BAD_REQUEST", "contains requires a string.");
        const expression = queryField(field, parameters, env, table);
        const escaped = value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
        clauses.push(`CAST(${expression} AS TEXT) LIKE ? ESCAPE '\\'`);
        parameters.push(`%${escaped}%`);
      }
      for (const compare of query.compare ?? []) {
        const expression = queryField(compare.field, parameters, env, table);
        const operators = { lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
        const operator = operators[compare.op];
        if (!operator) throw new HttpError(400, "BAD_REQUEST", "Query operator is invalid.");
        clauses.push(`${expression} ${operator} ?`);
        parameters.push(compare.value);
      }
      const order = (query.order ?? []).map((item) => {
        const direction = item.direction === "asc" ? "ASC" : "DESC";
        return `${queryField(item.field, parameters, env, table)} ${direction}`;
      }).join(", ");
      const limit = query.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new HttpError(400, "BAD_REQUEST", "limit must be an integer from 1 to 1000.");
      }
      parameters.push(limit);
      const result = await env.DB.prepare(
        `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE ${clauses.join(" AND ")}
          ORDER BY ${order || "created_at DESC"}
          LIMIT ?`,
      ).bind(...parameters).all<InternalObjectRow>();
      return (result.results ?? []).map((row) => recordFrom(definition, collection, row));
    },
    async create(collection, data, options: ArmadilloTrustedCreateOptions = {}) {
      // The REST create path meters before validating and releases the charge
      // when the write is rejected; the trusted path mirrors it so a rejected
      // trusted write is never billed either.
      return await withUsageCharge(env, appId, backend, "records_written", 1, async () => {
        const ownerId = options.ownerId ?? actorId();
        const prepared = await prepareCreate(collection, data, ownerId);
        const jobs = await prepareWebhookEvent(
          env, appId, backend, recordEventName(collection, "created"), prepared.record, actorId(),
        );
        const audit = recordAuditStatement(env, appId, {
          table: collection,
          recordId: prepared.objectId,
          action: "created",
          actorId: actorId(),
          createdAt: prepared.timestamp,
        });
        if (options.capacity) {
          const capacity = options.capacity;
          requireTable(definition, capacity.source.table);
          const source = requireTable(definition, capacity.source.table);
          const field = prepared.table.fields[capacity.field];
          const sourceField = source.fields[capacity.source.field];
          if (!field || field.type !== "integer" || !sourceField || sourceField.type !== "integer") {
            throw new HttpError(422, "VALIDATION_ERROR", "Capacity checks require integer fields.");
          }
          validName(capacity.source.id, "Record ID");
          const adding = prepared.validated.data[capacity.field];
          if (typeof adding !== "number") throw new HttpError(422, "VALIDATION_ERROR", "Capacity field is missing.");
          const parameters: BindValue[] = [
            appId, collection, prepared.objectId, ownerId, recordGroupId(prepared.table, prepared.validated.data), prepared.validated.encoded, prepared.timestamp, prepared.timestamp,
            `$.${capacity.field}`, appId, collection,
          ];
          const filters: string[] = [];
          for (const [key, raw] of Object.entries(capacity.where)) {
            const value = primitive(raw, `Capacity filter ${key}`);
            if (value === null || typeof value === "object") {
              throw new HttpError(400, "BAD_REQUEST", "Capacity filters accept text or numbers.");
            }
            if (!prepared.table.fields[key]) throw new HttpError(422, "VALIDATION_ERROR", `Field ${key} is not in this table.`);
            parameters.push(`$.${key}`, queryValue(value, prepared.table.fields[key], env) as BindValue);
            filters.push("json_extract(data, ?) = ?");
          }
          parameters.push(adding, `$.${capacity.source.field}`, appId, capacity.source.table, capacity.source.id);
          const inserted = await env.DB.prepare(
            `INSERT INTO ${INTERNAL_TABLES.objects}
               (app_id, collection, id, owner_id, group_id, data, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
              WHERE (
                SELECT COALESCE(SUM(CAST(json_extract(data, ?) AS INTEGER)), 0)
                  FROM ${INTERNAL_TABLES.objects}
                 WHERE app_id = ? AND collection = ?
                   ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
              ) + ? <= (
                SELECT CAST(json_extract(data, ?) AS INTEGER)
                  FROM ${INTERNAL_TABLES.objects}
                 WHERE app_id = ? AND collection = ? AND id = ?
              )`,
          ).bind(...parameters).run();
          if (!inserted.meta.changes) {
            throw new HttpError(409, "CONFLICT", capacity.conflict ?? "The record could not be created.");
          }
          // The capacity gate decided the insert above; the audit row and
          // webhook jobs commit right after, so a created record is never silent.
          await runStatements([...jobs, audit]);
          await emitTableMutation(env, appId, backend, collection, "created", prepared.record, actorId());
          return prepared.record;
        }
        const statement = insert(collection, ownerId, prepared.validated.encoded, prepared.objectId, prepared.timestamp);
        const links = fileStatements(env, appId, actorId(), definition, collection, prepared.objectId, prepared.validated.data, prepared.table);
        // The mutation, its file links, the webhook jobs, and the audit row
        // commit together: a committed write always has its audit row, and a
        // failed write never does.
        await runStatements([statement, ...links, ...jobs, audit]);
        await emitTableMutation(env, appId, backend, collection, "created", prepared.record, actorId());
        return prepared.record;
      });
    },
    async update(collection, id, data) {
      return await withUsageCharge(env, appId, backend, "records_written", 1, async () => {
        const table = requireTable(definition, collection);
        validName(id, "Record ID");
        const existing = await api.get(collection, id);
        const patch = schemaData(definition, collection, data, true, env).data;
        await validateTrustedLinks(env, appId, actorId(), definition, collection, patch);
        const current = { ...existing } as JsonObject;
        delete current.id;
        delete current.ownerId;
        delete current.createdAt;
        delete current.updatedAt;
        const merged = schemaData(definition, collection, { ...current, ...patch }, false, env);
        const timestamp = now();
        const statement = env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.objects} SET data = ?, group_id = ?, updated_at = ? WHERE app_id = ? AND collection = ? AND id = ?`,
        ).bind(merged.encoded, recordGroupId(table, merged.data), timestamp, appId, collection, id);
        const links = Object.keys(patch).some((key) => table.fields[key]?.type === "file")
          ? declaredFileLinkStatements(env, appId, actorId(), definition, collection, id, merged.data)
          : [];
        const updated = recordFrom(definition, collection, {
          id,
          owner_id: existing.ownerId,
          data: merged.encoded,
          created_at: existing.createdAt,
          updated_at: timestamp,
        });
        const jobs = await prepareWebhookEvent(
          env, appId, backend, recordEventName(collection, "updated"), updated, actorId(),
        );
        const audit = recordAuditStatement(env, appId, {
          table: collection,
          recordId: id,
          action: "updated",
          actorId: actorId(),
          createdAt: timestamp,
        });
        // The mutation, its file links, the webhook jobs, and the audit row
        // commit together, mirroring the REST PATCH path.
        await runStatements([statement, ...links, ...jobs, audit]);
        await emitTableMutation(env, appId, backend, collection, "updated", updated, actorId());
        return updated;
      });
    },
    async patchWhere(collection, where, data, options) {
      requireTable(definition, collection);
      const patch = schemaData(definition, collection, data, true, env).data;
      await validateTrustedLinks(env, appId, actorId(), definition, collection, patch);
      const table = requireTable(definition, collection);
      const assignParams: BindValue[] = [];
      const assignments = patchExpression(patch, assignParams);
      const groupSql = groupSet(table, patch, assignParams);
      const filterParams: BindValue[] = [];
      const filters = whereSql(env, table, where, filterParams);
      // An empty `where` matches every row in the collection. That is a valid
      // operation only when the caller says so, and it runs in bounded pages, so
      // a stray `patchWhere("Posts", {}, …)` cannot silently rewrite a whole
      // table. `patchExpression` binds every field as a literal, so an
      // all-rows pass always assigns one fixed value.
      const all = options?.all === true;
      if (!filters && !all) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "patchWhere needs a filter, or an explicit `{ all: true }` to update every matching row.",
          { where: "Add at least one condition, or pass { all: true }" },
        );
      }
      const pageLimit = boundedPage(options?.limit, 100, 1, 1_000, "limit");
      const pageOffset = boundedPage(options?.offset, 0, 0, 1_000_000, "offset");
      const limitClause = all && !filters
        ? ` AND rowid IN (
        SELECT rowid FROM ${INTERNAL_TABLES.objects}
         WHERE app_id = ? AND collection = ? ORDER BY id LIMIT ? OFFSET ?)`
        : "";
      const limitParams: BindValue[] = limitClause ? [appId, collection, pageLimit, pageOffset] : [];
      const timestamp = now();
      // The affected rows are read before the update so every committed write
      // gets its audit row and webhook event. The update's own change count
      // still decides the billed total: a row deleted inside the window is not
      // charged.
      const affected = await env.DB.prepare(
        `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`,
      ).bind(appId, collection, ...filterParams, ...limitParams).all<InternalObjectRow>();
      const rows = affected.results ?? [];
      const statements: ArmadilloStatement[] = [
        env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.objects}
              SET data = json_set(data, ${assignments})${groupSql}, updated_at = ?
            WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`,
        ).bind(...assignParams, timestamp, appId, collection, ...filterParams, ...limitParams),
      ];
      const updatedRecords: ArmadilloRecord[] = [];
      for (const row of rows) {
        // patchExpression binds every field as a literal, so the post-update
        // document is the stored document with the patch spread over it.
        const merged = { ...(JSON.parse(row.data) as JsonObject), ...patch };
        const record = recordFrom(definition, collection, {
          ...row,
          data: JSON.stringify(merged),
          updated_at: timestamp,
        });
        updatedRecords.push(record);
        statements.push(...await prepareWebhookEvent(
          env, appId, backend, recordEventName(collection, "updated"), record, actorId(),
        ));
        statements.push(recordAuditStatement(env, appId, {
          table: collection,
          recordId: row.id,
          action: "updated",
          actorId: actorId(),
          createdAt: timestamp,
        }));
      }
      const outcomes = await runStatements(statements);
      const changed = batchChanges(outcomes[0]) ?? rows.length;
      for (const record of updatedRecords) {
        await emitTableMutation(env, appId, backend, collection, "updated", record, actorId());
      }
      // The affected count is only known after the update, so the quota charge
      // lands after the commit with the exact count; future writes stay gated.
      await chargeUsage(env, appId, backend, "records_written", changed);
      return { changed };
    },
    async delete(collection, id) {
      return await withUsageCharge(env, appId, backend, "records_written", 1, async () => {
        requireTable(definition, collection);
        validName(id, "Record ID");
        const row = await env.DB.prepare(
          `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
            WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`,
        ).bind(appId, collection, id).first<InternalObjectRow>();
        if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
        const deleted = recordFrom(definition, collection, row);
        const jobs = await prepareWebhookEvent(
          env, appId, backend, recordEventName(collection, "deleted"), deleted, actorId(),
        );
        const audit = recordAuditStatement(env, appId, {
          table: collection,
          recordId: id,
          action: "deleted",
          actorId: actorId(),
          createdAt: now(),
        });
        const removed = await env.DB.prepare(
          `DELETE FROM ${INTERNAL_TABLES.objects} WHERE app_id = ? AND collection = ? AND id = ?`,
        ).bind(appId, collection, id).run();
        if (!removed.meta.changes) throw new HttpError(404, "NOT_FOUND", "Object not found.");
        // The guarded delete already committed; the audit row and webhook jobs
        // follow in the same window so a deleted record is never silent.
        await runStatements([...jobs, audit]);
        await emitTableMutation(env, appId, backend, collection, "deleted", deleted, actorId());
      });
    },
    async promote(sourceTable, sourceId, targetTable, transform) {
      // A move is two record writes: the created target row and the deleted
      // source row. The charge releases if the move fails before committing.
      return await withUsageCharge(env, appId, backend, "records_written", 2, async () => {
        const source = requireTable(definition, sourceTable);
        const target = requireTable(definition, targetTable);
        validName(sourceId, "Record ID");
        if (typeof transform !== "function") {
          throw new HttpError(400, "BAD_REQUEST", "promote() needs a transformation function.");
        }
        const row = await env.DB.prepare(
          `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
            WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`,
        ).bind(appId, sourceTable, sourceId).first<InternalObjectRow>();
        if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
        assertNarrowingPromotion(sourceTable, source, targetTable, target);
        await assertOwnerReadsSource(env, appId, sourceTable, source, target, row);
        const produced = await transform(recordFrom(definition, sourceTable, row));
        if (!produced || typeof produced !== "object" || Array.isArray(produced)) {
          throw new HttpError(422, "VALIDATION_ERROR", "The promotion transform must return an object.");
        }
        const data = { ...(produced as JsonObject) };
        delete data.id;
        delete data.ownerId;
        delete data.createdAt;
        delete data.updatedAt;
        if (target.team && source.team) {
          // The team stays server-owned: a move never switches teams silently.
          // (A public source has no team; its transform names the target team.)
          const sourceData = JSON.parse(row.data) as JsonObject;
          const teamId = sourceData[source.team.field];
          if (typeof teamId === "string") data[target.team.field] = teamId;
          else delete data[target.team.field];
        }
        const validated = schemaData(definition, targetTable, data, false, env);
        await validateTrustedLinks(env, appId, row.owner_id, definition, targetTable, validated.data);
        const current = await env.DB.prepare(
          `SELECT data, updated_at FROM ${INTERNAL_TABLES.objects}
            WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`,
        ).bind(appId, sourceTable, sourceId).first<{ data: string; updated_at: string }>();
        if (!current || current.updated_at !== row.updated_at || current.data !== row.data) {
          throw new HttpError(409, "CONFLICT", "The source record changed during promotion. Reload it and try again.");
        }
        if (!env.DB.batch) {
          throw new HttpError(500, "INTERNAL_ERROR", "This adapter cannot move the record atomically.");
        }
        const objectId = makeId(targetTable.toLowerCase());
        const timestamp = now();
        const outcomes = await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO ${INTERNAL_TABLES.objects}
               (app_id, collection, id, owner_id, group_id, data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(appId, targetTable, objectId, row.owner_id,
            recordGroupId(target, JSON.parse(validated.encoded) as JsonObject),
            validated.encoded, timestamp, timestamp),
          ...declaredFileLinkStatements(env, appId, row.owner_id, definition, targetTable, objectId, validated.data),
          env.DB.prepare(
            `DELETE FROM ${INTERNAL_TABLES.objects}
              WHERE app_id = ? AND collection = ? AND id = ? AND updated_at = ? AND data = ?`,
          ).bind(appId, sourceTable, sourceId, row.updated_at, row.data),
        ]);
        // The guarded delete is the move: its change count says whether this
        // batch claimed the source. A concurrent edit, move, or delete inside
        // the window leaves zero changes, and the copy must not survive.
        // Adapters that do not report change counts keep the legacy probe,
        // which only sees the concurrent-edit case.
        const claimed = batchChanges(outcomes.at(-1));
        const lost = claimed === undefined
          ? (await env.DB.prepare(
              `SELECT 1 FROM ${INTERNAL_TABLES.objects}
                WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`,
            ).bind(appId, sourceTable, sourceId).first()) !== null
          : claimed < 1;
        if (lost) {
          // A concurrent writer landed inside the move window: remove the copy
          // and its file links, then report the move as stale.
          await env.DB.prepare(
            `DELETE FROM ${INTERNAL_TABLES.objects} WHERE app_id = ? AND collection = ? AND id = ?`,
          ).bind(appId, targetTable, objectId).run().catch(() => undefined);
          await env.DB.prepare(
            `DELETE FROM ${INTERNAL_TABLES.fileLinks} WHERE app_id = ? AND collection = ? AND object_id = ?`,
          ).bind(appId, targetTable, objectId).run().catch(() => undefined);
          throw new HttpError(409, "CONFLICT", "The source record changed during promotion. Reload it and try again.");
        }
        const created = recordFrom(definition, targetTable, {
          id: objectId,
          owner_id: row.owner_id,
          data: validated.encoded,
          created_at: timestamp,
          updated_at: timestamp,
        });
        const sourceRecord = recordFrom(definition, sourceTable, row);
        const jobs = [
          ...await prepareWebhookEvent(env, appId, backend, recordEventName(targetTable, "created"), created, actorId()),
          ...await prepareWebhookEvent(env, appId, backend, recordEventName(sourceTable, "deleted"), sourceRecord, actorId()),
        ];
        // The move batch already committed; its audit rows and webhook jobs
        // follow in the same window. The lost-copy path above stays silent on
        // purpose: the copy was removed and the move is reported as conflicted,
        // while the usage charge stands because two writes did commit.
        await runStatements([
          ...jobs,
          recordAuditStatement(env, appId, {
            table: targetTable, recordId: objectId, action: "created", actorId: actorId(), createdAt: timestamp,
          }),
          recordAuditStatement(env, appId, {
            table: sourceTable, recordId: sourceId, action: "deleted", actorId: actorId(), createdAt: timestamp,
          }),
        ]);
        await emitTableMutation(env, appId, backend, targetTable, "created", created, actorId());
        await emitTableMutation(env, appId, backend, sourceTable, "deleted", sourceRecord, actorId());
        return created;
      });
    },
    async batch(steps) {
      if (!env.DB.batch) throw new HttpError(500, "INTERNAL_ERROR", "This adapter cannot commit these writes together.");
      // Creates are countable up front, so they meter like the REST
      // create-many path; patchWhere steps charge their exact count after.
      const createCount = steps.filter((step) => "create" in step).length;
      return await withUsageCharge(env, appId, backend, "records_written", createCount, async () => {
        const statements: ArmadilloStatement[] = [];
        const broadcasts: Array<{ collection: string; type: "created" | "updated"; record: ArmadilloRecord }> = [];
        const updateIndexes: number[] = [];
        const updateFallbacks: number[] = [];
        const timestamp = now();
        for (const step of steps) {
          if ("create" in step) {
            const prepared = await prepareCreate(step.create.table, step.create.data, step.create.ownerId ?? actorId());
            statements.push(insert(step.create.table, step.create.ownerId ?? actorId(), prepared.validated.encoded, prepared.objectId, prepared.timestamp));
            statements.push(...fileStatements(env, appId, actorId(), definition, step.create.table, prepared.objectId, prepared.validated.data, prepared.table));
            statements.push(...await prepareWebhookEvent(
              env, appId, backend, recordEventName(step.create.table, "created"), prepared.record, actorId(),
            ));
            statements.push(recordAuditStatement(env, appId, {
              table: step.create.table,
              recordId: prepared.objectId,
              action: "created",
              actorId: actorId(),
              createdAt: prepared.timestamp,
            }));
            broadcasts.push({ collection: step.create.table, type: "created", record: prepared.record });
            continue;
          }
          const table = requireTable(definition, step.patchWhere.table);
          const patch = schemaData(definition, step.patchWhere.table, step.patchWhere.data, true, env).data;
          await validateTrustedLinks(env, appId, actorId(), definition, step.patchWhere.table, patch);
          const assignParams: BindValue[] = [];
          const assignments = patchExpression(patch, assignParams);
          const groupSql = groupSet(table, patch, assignParams);
          const filterParams: BindValue[] = [];
          const filters = whereSql(env, table, step.patchWhere.where, filterParams);
          // The standalone patchWhere refuses an empty filter without
          // `{ all: true }`; a batch step must not be the way around it.
          const all = step.patchWhere.options?.all === true;
          if (!filters && !all) {
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "patchWhere needs a filter, or an explicit `{ all: true }` to update every matching row.",
              { where: "Add at least one condition, or pass { all: true }" },
            );
          }
          const pageLimit = boundedPage(step.patchWhere.options?.limit, 100, 1, 1_000, "limit");
          const pageOffset = boundedPage(step.patchWhere.options?.offset, 0, 0, 1_000_000, "offset");
          const limitClause = all && !filters
            ? ` AND rowid IN (
            SELECT rowid FROM ${INTERNAL_TABLES.objects}
             WHERE app_id = ? AND collection = ? ORDER BY id LIMIT ? OFFSET ?)`
            : "";
          const limitParams: BindValue[] = limitClause ? [appId, step.patchWhere.table, pageLimit, pageOffset] : [];
          const affected = await env.DB.prepare(
            `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
              WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`,
          ).bind(appId, step.patchWhere.table, ...filterParams, ...limitParams).all<InternalObjectRow>();
          const rows = affected.results ?? [];
          updateIndexes.push(statements.length);
          updateFallbacks.push(rows.length);
          statements.push(env.DB.prepare(
            `UPDATE ${INTERNAL_TABLES.objects}
                SET data = json_set(data, ${assignments})${groupSql}, updated_at = ?
              WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`,
          ).bind(...assignParams, timestamp, appId, step.patchWhere.table, ...filterParams, ...limitParams));
          for (const row of rows) {
            const merged = { ...(JSON.parse(row.data) as JsonObject), ...patch };
            const record = recordFrom(definition, step.patchWhere.table, {
              ...row,
              data: JSON.stringify(merged),
              updated_at: timestamp,
            });
            statements.push(...await prepareWebhookEvent(
              env, appId, backend, recordEventName(step.patchWhere.table, "updated"), record, actorId(),
            ));
            statements.push(recordAuditStatement(env, appId, {
              table: step.patchWhere.table,
              recordId: row.id,
              action: "updated",
              actorId: actorId(),
              createdAt: timestamp,
            }));
            broadcasts.push({ collection: step.patchWhere.table, type: "updated", record });
          }
        }
        const outcomes = statements.length ? await env.DB.batch(statements) : [];
        // The batch reports one outcome per statement, in order; adapters that
        // stay silent fall back to the pre-read row count.
        let patched = 0;
        updateIndexes.forEach((index, position) => {
          patched += batchChanges(outcomes[index]) ?? updateFallbacks[position] ?? 0;
        });
        if (patched > 0) await chargeUsage(env, appId, backend, "records_written", patched);
        for (const broadcast of broadcasts) {
          await emitTableMutation(env, appId, backend, broadcast.collection, broadcast.type, broadcast.record, actorId());
        }
      });
    },

  };
  return api;
}

export function trustedGroups(env: ArmadilloEnv, appId: string): ArmadilloTrustedGroups {
  return {
    async get(groupId): Promise<ArmadilloTrustedGroup | null> {
      validName(groupId, "Group ID");
      const row = await env.DB.prepare(
        `SELECT id, slug, trusted, created_by FROM ${INTERNAL_TABLES.groups} WHERE app_id = ? AND id = ? LIMIT 1`,
      ).bind(appId, groupId).first<{ id: string; slug: string; trusted: number; created_by: string }>();
      return row ? { id: row.id, slug: row.slug, trusted: row.trusted === 1, createdBy: row.created_by } : null;
    },
    async membership(groupId, userId) {
      validName(groupId, "Group ID");
      validName(userId, "User ID");
      const row = await env.DB.prepare(
        `SELECT role FROM ${INTERNAL_TABLES.groupMembers} WHERE app_id = ? AND group_id = ? AND user_id = ? LIMIT 1`,
      ).bind(appId, groupId, userId).first<{ role: string }>();
      return row ? { role: row.role } : null;
    },
    addMember(groupId, userId, role) {
      return grantMembership(env, appId, groupId, userId, role);
    },
  };
}

export async function readTrustedFile(
  env: ArmadilloEnv,
  appId: string,
  id: string,
  options: { maxBytes?: number } = {},
): Promise<ArmadilloTrustedFile> {
  validName(id, "File ID");
  // A trusted read buffers the whole object, and `maxFileBytes` defaults to
  // gigabytes. Without a default ceiling here, `context.trusted.readFile(id)`
  // with no options turns one request into a multi-gigabyte allocation. Callers
  // that genuinely want a large object must say how large.
  const maximum = options.maxBytes ?? DEFAULT_TRUSTED_FILE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maxFileBytes(env)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Read this file with an explicit maxBytes within the configured limit.");
  }
  const row = await env.DB.prepare(
    `SELECT owner_id, storage_key, name, content_type, size FROM ${INTERNAL_TABLES.files}
      WHERE app_id = ? AND id = ? LIMIT 1`,
  ).bind(appId, id).first<{ owner_id: string; storage_key: string; name: string; content_type: string; size: number }>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "File not found.");
  if (row.size > maximum) {
    throw new HttpError(422, "VALIDATION_ERROR", "File is too large.", {
      maxBytes: `This file is ${row.size} bytes; read it with maxBytes of at least that.`,
    });
  }
  const stored = await env.FILES.get(row.storage_key);
  if (!stored) throw new HttpError(404, "NOT_FOUND", "File no longer exists.");
  const bytes = new Uint8Array(await new Response(boundedBody(stored.body, maximum)).arrayBuffer());
  if (bytes.byteLength > maximum) {
    throw new HttpError(422, "VALIDATION_ERROR", "File is too large.");
  }
  return { name: row.name, contentType: row.content_type, size: row.size, ownerId: row.owner_id, bytes };
}
