import { INTERNAL_TABLES } from "../internal-schema.js";
import { HttpError, maxFileBytes } from "./http.js";
import { boundedBody } from "./body.js";
import { validName } from "./apps.js";
import { makeId } from "./helpers/id.js";
import { grantMembership } from "./teams.js";
import { recordAccessClause } from "./permissions.js";
import { queryField, queryValue } from "./queries.js";
import { computedObjectJson, now, objectJson, recordGroupId } from "./records.js";
import { acceptsContentType, declaredFileLinkStatements, schemaData } from "./validation.js";
import { prepareWebhookEvent } from "./handlers/webhooks.js";
import { emitTableMutation } from "./events.js";
import { recordAuditStatement } from "./record-audit.js";
import { chargeUsage, withUsageCharge } from "./usage.js";
const DEFAULT_TRUSTED_FILE_BYTES = 8 * 1024 * 1024;
function requireTable(definition, name) {
  validName(name, "Table name");
  const table = definition?.normalized.tables[name];
  if (!table) throw new HttpError(404, "NOT_FOUND", `Table ${name} is not in this schema.`);
  if (table.storage !== "json") throw new HttpError(500, "INTERNAL_ERROR", "Trusted records support JSON tables.");
  return table;
}
function primitive(value, label) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new HttpError(400, "BAD_REQUEST", `${label} accepts text, numbers, booleans, or null.`);
}
function batchChanges(outcome) {
  if (!outcome || typeof outcome !== "object") return void 0;
  const meta = outcome.meta;
  if (!meta || typeof meta !== "object") return void 0;
  const changes = meta.changes;
  return typeof changes === "number" ? changes : void 0;
}
function groupSet(table, data, parameters) {
  if (!table.team || !Object.hasOwn(data, table.team.field)) return "";
  parameters.push(recordGroupId(table, data));
  return ", group_id = ?";
}
function recordFrom(definition, collection, row) {
  return computedObjectJson(definition, collection, objectJson(row));
}
function rolesNarrower(target, source) {
  if (source === void 0) return true;
  if (target === void 0) return false;
  return target.every((role) => source.includes(role));
}
const OUTSIDE_SOURCE_AUDIENCE = "Promote into a table whose audience is within the source audience.";
async function assertOwnerReadsSource(env, currentAppId, sourceName, source, target, row) {
  if (!source.team || target.team) return;
  if (source.read === "public" || target.read === "public") return;
  const parameters = [];
  const access = recordAccessClause(source, currentAppId, row.owner_id, parameters, false);
  if (!access) return;
  const visible = await env.DB.prepare(
    `SELECT 1 FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ? AND collection = ? AND id = ? AND ${access} LIMIT 1`
  ).bind(currentAppId, sourceName, row.id, ...parameters).first();
  if (!visible) {
    throw new HttpError(
      409,
      "CONFLICT",
      `Promotion refused: the owner cannot read ${sourceName}. ${OUTSIDE_SOURCE_AUDIENCE}`
    );
  }
}
function assertNarrowingPromotion(sourceName, source, targetName, target) {
  const widen = (why) => {
    throw new HttpError(
      409,
      "CONFLICT",
      `Promotion refused: ${why}. ${OUTSIDE_SOURCE_AUDIENCE}`
    );
  };
  if (source.read === "public") return;
  if (target.read === "public") widen(`${targetName} is publicly readable but ${sourceName} is not`);
  if (target.team && !source.team) widen(`${targetName} shares rows with a team but ${sourceName} is owner-private`);
  if (target.team && source.team) {
    if (!rolesNarrower(target.team.readRoles, source.team.readRoles)) {
      widen(`${targetName} is readable by team roles ${sourceName} does not grant`);
    }
    if (!rolesNarrower(target.team.writeRoles, source.team.writeRoles) || target.team.ownerWrite === true && source.team.ownerWrite !== true && source.team.writeRoles !== void 0) {
      widen(`${targetName} is writable by team roles ${sourceName} does not grant`);
    }
  }
}
async function validateTrustedLinks(env, appId, actorId, definition, collection, data) {
  const fields = definition?.normalized.tables[collection]?.fields ?? {};
  const issues = {};
  await Promise.all(Object.entries(data).map(async ([fieldName, value]) => {
    const field = fields[fieldName];
    if (!field || value == null) return;
    if (typeof value !== "string") return;
    if (field.type === "file") {
      const stored = await env.DB.prepare(
        `SELECT content_type, size FROM ${INTERNAL_TABLES.files} WHERE app_id = ? AND id = ? AND owner_id = ? LIMIT 1`
      ).bind(appId, value, actorId).first();
      if (!stored) issues[fieldName] = "Upload this file before attaching it";
      else if (field.contentTypes && !acceptsContentType(stored.content_type, field.contentTypes)) {
        issues[fieldName] = `Use ${field.contentTypes.join(" or ")}`;
      } else if (field.maxBytes !== void 0 && stored.size > field.maxBytes) {
        issues[fieldName] = `File must be at most ${field.maxBytes} bytes`;
      }
      return;
    }
    if (field.type !== "pointer" || !field.target) return;
    let found;
    if (field.target === "_User") {
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.users} WHERE app_id = ? AND id = ? LIMIT 1`
      ).bind(appId, value).first();
    } else if (field.target === "_Team") {
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.groups} WHERE app_id = ? AND id = ? LIMIT 1`
      ).bind(appId, value).first();
    } else {
      const target = definition?.normalized.tables[field.target];
      if (target && target.storage !== "json") {
        throw new HttpError(500, "INTERNAL_ERROR", "Trusted records support JSON tables.");
      }
      found = await env.DB.prepare(
        `SELECT 1 FROM ${INTERNAL_TABLES.objects} WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`
      ).bind(appId, field.target, value).first();
    }
    if (!found) issues[fieldName] = `Referenced ${field.target} does not exist`;
  }));
  if (Object.keys(issues).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Object references do not match its Armadillo schema.", issues);
  }
}
function fileStatements(env, appId, actorId, definition, collection, objectId, data, table) {
  const touches = Object.entries(table.fields).some(([name, field]) => field.type === "file" && typeof data[name] === "string");
  if (!touches) return [];
  return declaredFileLinkStatements(env, appId, actorId, definition, collection, objectId, data);
}
function whereSql(env, table, where, parameters) {
  const clauses = [];
  for (const [field, raw] of Object.entries(where)) {
    const value = primitive(raw, `Filter ${field}`);
    const expression = queryField(field, parameters, env, table);
    if (value === null) {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    clauses.push(`${expression} = ?`);
    parameters.push(queryValue(value, table.fields[field], env));
  }
  return clauses.join(" AND ");
}
function boundedPage(value, fallback, minimum, maximum, label) {
  if (value === void 0) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(422, "VALIDATION_ERROR", `patchWhere ${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
function patchExpression(data, parameters) {
  const parts = [];
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
function trustedRecords(env, appId, backend, actorId) {
  const definition = backend.schema;
  function recordEventName(collection, action) {
    return `${collection.charAt(0).toLowerCase()}${collection.slice(1)}.${action}`;
  }
  async function runStatements(statements) {
    if (statements.length === 0) return [];
    if (env.DB.batch) return env.DB.batch(statements);
    const outcomes = [];
    for (const statement of statements) outcomes.push(await statement.run());
    return outcomes;
  }
  function insert(collection, ownerId, encoded, objectId, timestamp) {
    const groupId = recordGroupId(requireTable(definition, collection), JSON.parse(encoded));
    return env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.objects}
         (app_id, collection, id, owner_id, group_id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(appId, collection, objectId, ownerId, groupId, encoded, timestamp, timestamp);
  }
  async function prepareCreate(collection, data, ownerId) {
    const table = requireTable(definition, collection);
    const validated = schemaData(definition, collection, data, false, env);
    await validateTrustedLinks(env, appId, actorId(), definition, collection, validated.data);
    const objectId = makeId(collection.toLowerCase());
    const timestamp = now();
    const row = {
      id: objectId,
      owner_id: ownerId,
      data: validated.encoded,
      created_at: timestamp,
      updated_at: timestamp
    };
    return { table, validated, objectId, timestamp, row, record: recordFrom(definition, collection, row) };
  }
  const api = {
    async get(collection, id) {
      requireTable(definition, collection);
      validName(id, "Record ID");
      const row = await env.DB.prepare(
        `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`
      ).bind(appId, collection, id).first();
      if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
      return recordFrom(definition, collection, row);
    },
    async query(collection, query = {}) {
      const table = requireTable(definition, collection);
      const parameters = [appId, collection];
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
        const operators = { lt: "<", lte: "<=", gt: ">", gte: ">=" };
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
      if (!Number.isInteger(limit) || limit < 1 || limit > 1e3) {
        throw new HttpError(400, "BAD_REQUEST", "limit must be an integer from 1 to 1000.");
      }
      parameters.push(limit);
      const result = await env.DB.prepare(
        `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE ${clauses.join(" AND ")}
          ORDER BY ${order || "created_at DESC"}
          LIMIT ?`
      ).bind(...parameters).all();
      return (result.results ?? []).map((row) => recordFrom(definition, collection, row));
    },
    async create(collection, data, options = {}) {
      return await withUsageCharge(env, appId, backend, "records_written", 1, async () => {
        const ownerId = options.ownerId ?? actorId();
        const prepared = await prepareCreate(collection, data, ownerId);
        const jobs = await prepareWebhookEvent(
          env,
          appId,
          backend,
          recordEventName(collection, "created"),
          prepared.record,
          actorId()
        );
        const audit = recordAuditStatement(env, appId, {
          table: collection,
          recordId: prepared.objectId,
          action: "created",
          actorId: actorId(),
          createdAt: prepared.timestamp
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
          const parameters = [
            appId,
            collection,
            prepared.objectId,
            ownerId,
            recordGroupId(prepared.table, prepared.validated.data),
            prepared.validated.encoded,
            prepared.timestamp,
            prepared.timestamp,
            `$.${capacity.field}`,
            appId,
            collection
          ];
          const filters = [];
          for (const [key, raw] of Object.entries(capacity.where)) {
            const value = primitive(raw, `Capacity filter ${key}`);
            if (value === null || typeof value === "object") {
              throw new HttpError(400, "BAD_REQUEST", "Capacity filters accept text or numbers.");
            }
            if (!prepared.table.fields[key]) throw new HttpError(422, "VALIDATION_ERROR", `Field ${key} is not in this table.`);
            parameters.push(`$.${key}`, queryValue(value, prepared.table.fields[key], env));
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
              )`
          ).bind(...parameters).run();
          if (!inserted.meta.changes) {
            throw new HttpError(409, "CONFLICT", capacity.conflict ?? "The record could not be created.");
          }
          await runStatements([...jobs, audit]);
          await emitTableMutation(env, appId, backend, collection, "created", prepared.record, actorId());
          return prepared.record;
        }
        const statement = insert(collection, ownerId, prepared.validated.encoded, prepared.objectId, prepared.timestamp);
        const links = fileStatements(env, appId, actorId(), definition, collection, prepared.objectId, prepared.validated.data, prepared.table);
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
        const current = { ...existing };
        delete current.id;
        delete current.ownerId;
        delete current.createdAt;
        delete current.updatedAt;
        const merged = schemaData(definition, collection, { ...current, ...patch }, false, env);
        const timestamp = now();
        const statement = env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.objects} SET data = ?, group_id = ?, updated_at = ? WHERE app_id = ? AND collection = ? AND id = ?`
        ).bind(merged.encoded, recordGroupId(table, merged.data), timestamp, appId, collection, id);
        const links = Object.keys(patch).some((key) => table.fields[key]?.type === "file") ? declaredFileLinkStatements(env, appId, actorId(), definition, collection, id, merged.data) : [];
        const updated = recordFrom(definition, collection, {
          id,
          owner_id: existing.ownerId,
          data: merged.encoded,
          created_at: existing.createdAt,
          updated_at: timestamp
        });
        const jobs = await prepareWebhookEvent(
          env,
          appId,
          backend,
          recordEventName(collection, "updated"),
          updated,
          actorId()
        );
        const audit = recordAuditStatement(env, appId, {
          table: collection,
          recordId: id,
          action: "updated",
          actorId: actorId(),
          createdAt: timestamp
        });
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
      const assignParams = [];
      const assignments = patchExpression(patch, assignParams);
      const groupSql = groupSet(table, patch, assignParams);
      const filterParams = [];
      const filters = whereSql(env, table, where, filterParams);
      const all = options?.all === true;
      if (!filters && !all) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "patchWhere needs a filter, or an explicit `{ all: true }` to update every matching row.",
          { where: "Add at least one condition, or pass { all: true }" }
        );
      }
      const pageLimit = boundedPage(options?.limit, 100, 1, 1e3, "limit");
      const pageOffset = boundedPage(options?.offset, 0, 0, 1e6, "offset");
      const limitClause = all && !filters ? ` AND rowid IN (
        SELECT rowid FROM ${INTERNAL_TABLES.objects}
         WHERE app_id = ? AND collection = ? ORDER BY id LIMIT ? OFFSET ?)` : "";
      const limitParams = limitClause ? [appId, collection, pageLimit, pageOffset] : [];
      const timestamp = now();
      const affected = await env.DB.prepare(
        `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`
      ).bind(appId, collection, ...filterParams, ...limitParams).all();
      const rows = affected.results ?? [];
      const statements = [
        env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.objects}
              SET data = json_set(data, ${assignments})${groupSql}, updated_at = ?
            WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`
        ).bind(...assignParams, timestamp, appId, collection, ...filterParams, ...limitParams)
      ];
      const updatedRecords = [];
      for (const row of rows) {
        const merged = { ...JSON.parse(row.data), ...patch };
        const record = recordFrom(definition, collection, {
          ...row,
          data: JSON.stringify(merged),
          updated_at: timestamp
        });
        updatedRecords.push(record);
        statements.push(...await prepareWebhookEvent(
          env,
          appId,
          backend,
          recordEventName(collection, "updated"),
          record,
          actorId()
        ));
        statements.push(recordAuditStatement(env, appId, {
          table: collection,
          recordId: row.id,
          action: "updated",
          actorId: actorId(),
          createdAt: timestamp
        }));
      }
      const outcomes = await runStatements(statements);
      const changed = batchChanges(outcomes[0]) ?? rows.length;
      for (const record of updatedRecords) {
        await emitTableMutation(env, appId, backend, collection, "updated", record, actorId());
      }
      await chargeUsage(env, appId, backend, "records_written", changed);
      return { changed };
    },
    async delete(collection, id) {
      return await withUsageCharge(env, appId, backend, "records_written", 1, async () => {
        requireTable(definition, collection);
        validName(id, "Record ID");
        const row = await env.DB.prepare(
          `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
            WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`
        ).bind(appId, collection, id).first();
        if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
        const deleted = recordFrom(definition, collection, row);
        const jobs = await prepareWebhookEvent(
          env,
          appId,
          backend,
          recordEventName(collection, "deleted"),
          deleted,
          actorId()
        );
        const audit = recordAuditStatement(env, appId, {
          table: collection,
          recordId: id,
          action: "deleted",
          actorId: actorId(),
          createdAt: now()
        });
        const removed = await env.DB.prepare(
          `DELETE FROM ${INTERNAL_TABLES.objects} WHERE app_id = ? AND collection = ? AND id = ?`
        ).bind(appId, collection, id).run();
        if (!removed.meta.changes) throw new HttpError(404, "NOT_FOUND", "Object not found.");
        await runStatements([...jobs, audit]);
        await emitTableMutation(env, appId, backend, collection, "deleted", deleted, actorId());
      });
    },
    async promote(sourceTable, sourceId, targetTable, transform) {
      return await withUsageCharge(env, appId, backend, "records_written", 2, async () => {
        const source = requireTable(definition, sourceTable);
        const target = requireTable(definition, targetTable);
        validName(sourceId, "Record ID");
        if (typeof transform !== "function") {
          throw new HttpError(400, "BAD_REQUEST", "promote() needs a transformation function.");
        }
        const row = await env.DB.prepare(
          `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
            WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`
        ).bind(appId, sourceTable, sourceId).first();
        if (!row) throw new HttpError(404, "NOT_FOUND", "Object not found.");
        assertNarrowingPromotion(sourceTable, source, targetTable, target);
        await assertOwnerReadsSource(env, appId, sourceTable, source, target, row);
        const produced = await transform(recordFrom(definition, sourceTable, row));
        if (!produced || typeof produced !== "object" || Array.isArray(produced)) {
          throw new HttpError(422, "VALIDATION_ERROR", "The promotion transform must return an object.");
        }
        const data = { ...produced };
        delete data.id;
        delete data.ownerId;
        delete data.createdAt;
        delete data.updatedAt;
        if (target.team && source.team) {
          const sourceData = JSON.parse(row.data);
          const teamId = sourceData[source.team.field];
          if (typeof teamId === "string") data[target.team.field] = teamId;
          else delete data[target.team.field];
        }
        const validated = schemaData(definition, targetTable, data, false, env);
        await validateTrustedLinks(env, appId, row.owner_id, definition, targetTable, validated.data);
        const current = await env.DB.prepare(
          `SELECT data, updated_at FROM ${INTERNAL_TABLES.objects}
            WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`
        ).bind(appId, sourceTable, sourceId).first();
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            appId,
            targetTable,
            objectId,
            row.owner_id,
            recordGroupId(target, JSON.parse(validated.encoded)),
            validated.encoded,
            timestamp,
            timestamp
          ),
          ...declaredFileLinkStatements(env, appId, row.owner_id, definition, targetTable, objectId, validated.data),
          env.DB.prepare(
            `DELETE FROM ${INTERNAL_TABLES.objects}
              WHERE app_id = ? AND collection = ? AND id = ? AND updated_at = ? AND data = ?`
          ).bind(appId, sourceTable, sourceId, row.updated_at, row.data)
        ]);
        const claimed = batchChanges(outcomes.at(-1));
        const lost = claimed === void 0 ? await env.DB.prepare(
          `SELECT 1 FROM ${INTERNAL_TABLES.objects}
                WHERE app_id = ? AND collection = ? AND id = ? LIMIT 1`
        ).bind(appId, sourceTable, sourceId).first() !== null : claimed < 1;
        if (lost) {
          await env.DB.prepare(
            `DELETE FROM ${INTERNAL_TABLES.objects} WHERE app_id = ? AND collection = ? AND id = ?`
          ).bind(appId, targetTable, objectId).run().catch(() => void 0);
          await env.DB.prepare(
            `DELETE FROM ${INTERNAL_TABLES.fileLinks} WHERE app_id = ? AND collection = ? AND object_id = ?`
          ).bind(appId, targetTable, objectId).run().catch(() => void 0);
          throw new HttpError(409, "CONFLICT", "The source record changed during promotion. Reload it and try again.");
        }
        const created = recordFrom(definition, targetTable, {
          id: objectId,
          owner_id: row.owner_id,
          data: validated.encoded,
          created_at: timestamp,
          updated_at: timestamp
        });
        const sourceRecord = recordFrom(definition, sourceTable, row);
        const jobs = [
          ...await prepareWebhookEvent(env, appId, backend, recordEventName(targetTable, "created"), created, actorId()),
          ...await prepareWebhookEvent(env, appId, backend, recordEventName(sourceTable, "deleted"), sourceRecord, actorId())
        ];
        await runStatements([
          ...jobs,
          recordAuditStatement(env, appId, {
            table: targetTable,
            recordId: objectId,
            action: "created",
            actorId: actorId(),
            createdAt: timestamp
          }),
          recordAuditStatement(env, appId, {
            table: sourceTable,
            recordId: sourceId,
            action: "deleted",
            actorId: actorId(),
            createdAt: timestamp
          })
        ]);
        await emitTableMutation(env, appId, backend, targetTable, "created", created, actorId());
        await emitTableMutation(env, appId, backend, sourceTable, "deleted", sourceRecord, actorId());
        return created;
      });
    },
    async batch(steps) {
      if (!env.DB.batch) throw new HttpError(500, "INTERNAL_ERROR", "This adapter cannot commit these writes together.");
      const createCount = steps.filter((step) => "create" in step).length;
      return await withUsageCharge(env, appId, backend, "records_written", createCount, async () => {
        const statements = [];
        const broadcasts = [];
        const updateIndexes = [];
        const updateFallbacks = [];
        const timestamp = now();
        for (const step of steps) {
          if ("create" in step) {
            const prepared = await prepareCreate(step.create.table, step.create.data, step.create.ownerId ?? actorId());
            statements.push(insert(step.create.table, step.create.ownerId ?? actorId(), prepared.validated.encoded, prepared.objectId, prepared.timestamp));
            statements.push(...fileStatements(env, appId, actorId(), definition, step.create.table, prepared.objectId, prepared.validated.data, prepared.table));
            statements.push(...await prepareWebhookEvent(
              env,
              appId,
              backend,
              recordEventName(step.create.table, "created"),
              prepared.record,
              actorId()
            ));
            statements.push(recordAuditStatement(env, appId, {
              table: step.create.table,
              recordId: prepared.objectId,
              action: "created",
              actorId: actorId(),
              createdAt: prepared.timestamp
            }));
            broadcasts.push({ collection: step.create.table, type: "created", record: prepared.record });
            continue;
          }
          const table = requireTable(definition, step.patchWhere.table);
          const patch = schemaData(definition, step.patchWhere.table, step.patchWhere.data, true, env).data;
          await validateTrustedLinks(env, appId, actorId(), definition, step.patchWhere.table, patch);
          const assignParams = [];
          const assignments = patchExpression(patch, assignParams);
          const groupSql = groupSet(table, patch, assignParams);
          const filterParams = [];
          const filters = whereSql(env, table, step.patchWhere.where, filterParams);
          const all = step.patchWhere.options?.all === true;
          if (!filters && !all) {
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "patchWhere needs a filter, or an explicit `{ all: true }` to update every matching row.",
              { where: "Add at least one condition, or pass { all: true }" }
            );
          }
          const pageLimit = boundedPage(step.patchWhere.options?.limit, 100, 1, 1e3, "limit");
          const pageOffset = boundedPage(step.patchWhere.options?.offset, 0, 0, 1e6, "offset");
          const limitClause = all && !filters ? ` AND rowid IN (
            SELECT rowid FROM ${INTERNAL_TABLES.objects}
             WHERE app_id = ? AND collection = ? ORDER BY id LIMIT ? OFFSET ?)` : "";
          const limitParams = limitClause ? [appId, step.patchWhere.table, pageLimit, pageOffset] : [];
          const affected = await env.DB.prepare(
            `SELECT id, owner_id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
              WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`
          ).bind(appId, step.patchWhere.table, ...filterParams, ...limitParams).all();
          const rows = affected.results ?? [];
          updateIndexes.push(statements.length);
          updateFallbacks.push(rows.length);
          statements.push(env.DB.prepare(
            `UPDATE ${INTERNAL_TABLES.objects}
                SET data = json_set(data, ${assignments})${groupSql}, updated_at = ?
              WHERE app_id = ? AND collection = ?${filters ? ` AND ${filters}` : ""}${limitClause}`
          ).bind(...assignParams, timestamp, appId, step.patchWhere.table, ...filterParams, ...limitParams));
          for (const row of rows) {
            const merged = { ...JSON.parse(row.data), ...patch };
            const record = recordFrom(definition, step.patchWhere.table, {
              ...row,
              data: JSON.stringify(merged),
              updated_at: timestamp
            });
            statements.push(...await prepareWebhookEvent(
              env,
              appId,
              backend,
              recordEventName(step.patchWhere.table, "updated"),
              record,
              actorId()
            ));
            statements.push(recordAuditStatement(env, appId, {
              table: step.patchWhere.table,
              recordId: row.id,
              action: "updated",
              actorId: actorId(),
              createdAt: timestamp
            }));
            broadcasts.push({ collection: step.patchWhere.table, type: "updated", record });
          }
        }
        const outcomes = statements.length ? await env.DB.batch(statements) : [];
        let patched = 0;
        updateIndexes.forEach((index, position) => {
          patched += batchChanges(outcomes[index]) ?? updateFallbacks[position] ?? 0;
        });
        if (patched > 0) await chargeUsage(env, appId, backend, "records_written", patched);
        for (const broadcast of broadcasts) {
          await emitTableMutation(env, appId, backend, broadcast.collection, broadcast.type, broadcast.record, actorId());
        }
      });
    }
  };
  return api;
}
function trustedGroups(env, appId) {
  return {
    async get(groupId) {
      validName(groupId, "Group ID");
      const row = await env.DB.prepare(
        `SELECT id, slug, trusted, created_by FROM ${INTERNAL_TABLES.groups} WHERE app_id = ? AND id = ? LIMIT 1`
      ).bind(appId, groupId).first();
      return row ? { id: row.id, slug: row.slug, trusted: row.trusted === 1, createdBy: row.created_by } : null;
    },
    async membership(groupId, userId) {
      validName(groupId, "Group ID");
      validName(userId, "User ID");
      const row = await env.DB.prepare(
        `SELECT role FROM ${INTERNAL_TABLES.groupMembers} WHERE app_id = ? AND group_id = ? AND user_id = ? LIMIT 1`
      ).bind(appId, groupId, userId).first();
      return row ? { role: row.role } : null;
    },
    addMember(groupId, userId, role) {
      return grantMembership(env, appId, groupId, userId, role);
    }
  };
}
async function readTrustedFile(env, appId, id, options = {}) {
  validName(id, "File ID");
  const maximum = options.maxBytes ?? DEFAULT_TRUSTED_FILE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maxFileBytes(env)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Read this file with an explicit maxBytes within the configured limit.");
  }
  const row = await env.DB.prepare(
    `SELECT owner_id, storage_key, name, content_type, size FROM ${INTERNAL_TABLES.files}
      WHERE app_id = ? AND id = ? LIMIT 1`
  ).bind(appId, id).first();
  if (!row) throw new HttpError(404, "NOT_FOUND", "File not found.");
  if (row.size > maximum) {
    throw new HttpError(422, "VALIDATION_ERROR", "File is too large.", {
      maxBytes: `This file is ${row.size} bytes; read it with maxBytes of at least that.`
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
export {
  DEFAULT_TRUSTED_FILE_BYTES,
  readTrustedFile,
  trustedGroups,
  trustedRecords
};
