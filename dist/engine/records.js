import { prepareWebhookEvent } from "./handlers/webhooks.js";
import {} from "../backend.js";
import {} from "../backend.js";
import {} from "../backend.js";
import {} from "../index.js";
import { evaluateComputedFields } from "../index.js";
import {} from "../index.js";
import { physicalGeoColumns } from "../index.js";
import {} from "../backend.js";
import {} from "../index.js";
import { mergeTicketSupply, projectStoredTickets, SchemaValidationError, stableJson } from "../schema.js";
import {} from "./environment.js";
import {} from "./environment.js";
import { recordAccessClause } from "./permissions.js";
import { physicalTableName } from "../index.js";
import { INTERNAL_TABLES } from "../backend.js";
import {} from "../backend.js";
import { validName } from "./apps.js";
import { optionalAuth, requireAuth } from "./auth.js";
import { readJson } from "./validation.js";
import { validateData } from "./validation.js";
import { schemaData } from "./validation.js";
import { validateSchemaLinks } from "./validation.js";
import { requireTeamAccess } from "./permissions.js";
import { makeId } from "./helpers/id.js";
import { declaredFileLinkStatements } from "./validation.js";
import { emitTableMutation } from "./events.js";
import { recordAuditStatement } from "./record-audit.js";
import { recordUsage, withUsageCharge } from "./usage.js";
import { json } from "./http.js";
import { HttpError } from "./http.js";
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
const HIDDEN_PROFILE_KEYS = /* @__PURE__ */ new Set([
  "password",
  "password_hash",
  "password_salt",
  "password_iterations",
  "password_enabled",
  "token",
  "sessionToken"
]);
function profilePayload(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === void 0 || HIDDEN_PROFILE_KEYS.has(key)) continue;
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}
function userJson(row) {
  return {
    ...profilePayload(row.profile),
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function publicProfileFields(raw, fields) {
  if (!fields) return {};
  const payload = profilePayload(raw);
  const result = {};
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(payload, key)) result[key] = payload[key];
  }
  return result;
}
function objectJson(row) {
  const data = JSON.parse(row.data);
  return {
    ...data,
    id: row.id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function computedObjectJson(definition, collection, record) {
  const fields = definition?.tables[collection]?.fields;
  const withComputed = fields && Object.values(fields).some((field) => field.config.type === "computed") ? evaluateComputedFields(fields, record) : record;
  return projectStoredTickets(definition, collection, withComputed);
}
function sqlIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
function recordGroupId(table, data) {
  if (!table?.team || table.storage === "columns") return null;
  const value = data[table.team.field];
  return typeof value === "string" ? value : null;
}
function physicalFields(table) {
  return Object.entries(table.fields).flatMap(([name, field]) => field.type === "geo" ? physicalGeoColumns(name) : [name]);
}
function physicalValue(value, field, env) {
  if (value === void 0) return null;
  if (field.type === "json" || field.type === "tickets") {
    return value === null ? null : JSON.stringify(stableJson(value));
  }
  if (field.type === "boolean" && env.ARMADILLO_SQL_DIALECT !== "postgres") {
    return value ? 1 : 0;
  }
  return value;
}
function physicalValues(data, table, env) {
  return Object.entries(table.fields).flatMap(([fieldName, field]) => {
    const value = data[fieldName];
    if (field.type !== "geo") return [physicalValue(value, field, env)];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [null, null, null];
    const point = value;
    return [
      typeof point.latitude === "number" ? point.latitude : null,
      typeof point.longitude === "number" ? point.longitude : null,
      typeof point.altitude === "number" ? point.altitude : null
    ];
  });
}
function physicalData(row, table) {
  const data = {};
  for (const [fieldName, field] of Object.entries(table.fields)) {
    if (field.type === "geo") {
      const [latitude, longitude, altitude] = physicalGeoColumns(fieldName);
      const lat = row[latitude];
      const lng = row[longitude];
      if (typeof lat === "number" && typeof lng === "number") {
        data[fieldName] = {
          latitude: lat,
          longitude: lng,
          ...typeof row[altitude] === "number" ? { altitude: row[altitude] } : {}
        };
      }
      continue;
    }
    const value = row[fieldName];
    if (value === null || value === void 0) continue;
    if (field.type === "json" || field.type === "tickets") {
      data[fieldName] = typeof value === "string" ? JSON.parse(value) : value;
      continue;
    }
    data[fieldName] = field.type === "boolean" ? Boolean(value) : value;
  }
  return data;
}
function physicalObjectJson(row, table) {
  return {
    ...physicalData(row, table),
    id: row.id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function physicalRowAsObject(row, table) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    data: JSON.stringify(physicalData(row, table)),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
async function findObject(env, currentAppId, collection, id, definition, requesterId, write = false) {
  const table = definition?.normalized.tables[collection];
  if (table?.storage === "columns") {
    const fields = physicalFields(table).map(sqlIdentifier).join(", ");
    const parameters2 = [currentAppId, id];
    const access2 = recordAccessClause(table, currentAppId, requesterId, parameters2, write);
    const row = await env.DB.prepare(
      `SELECT id, owner_id, ${fields}, created_at, updated_at
         FROM ${sqlIdentifier(physicalTableName(currentAppId, collection))}
        WHERE app_id = ?1 AND id = ?2 ${access2 ? `AND ${access2}` : ""}
        LIMIT 1`
    ).bind(...parameters2).first();
    return row ? physicalRowAsObject(row, table) : null;
  }
  const parameters = [currentAppId, collection, id];
  const access = recordAccessClause(table, currentAppId, requesterId, parameters, write);
  return env.DB.prepare(
    `SELECT id, owner_id, data, created_at, updated_at
       FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ?1 AND collection = ?2 AND id = ?3 ${access ? `AND ${access}` : ""}
      LIMIT 1`
  ).bind(...parameters).first();
}
const CREATE_MANY_MAX = 50;
function rejectCreateManyRow(index, error) {
  if (!(error instanceof HttpError)) throw error;
  throw new HttpError(
    error.status,
    error.code,
    `Row ${index}: ${error.message}`,
    error.fields ? Object.fromEntries(Object.entries(error.fields).map(([key, message]) => [`${index}.${key}`, message])) : void 0,
    error.hint
  );
}
async function prepareRecordCreate(env, currentAppId, collection, definition, table, backend, actorId, input) {
  const validatedInput = validateData(input, env);
  const validated = schemaData(definition, collection, validatedInput.data, false, env);
  await validateSchemaLinks(env, currentAppId, actorId, definition, collection, validated.data);
  await requireTeamAccess(env, currentAppId, actorId, table, validated.data, true, actorId);
  const { encoded } = validated;
  const objectId = makeId(collection.toLowerCase());
  const timestamp = now();
  let mutation;
  if (table?.storage === "columns") {
    const fields = physicalFields(table);
    const columns = ["app_id", "id", "owner_id", ...fields, "created_at", "updated_at"];
    const values = [
      currentAppId,
      objectId,
      actorId,
      ...physicalValues(validated.data, table, env),
      timestamp,
      timestamp
    ];
    mutation = env.DB.prepare(
      `INSERT INTO ${sqlIdentifier(physicalTableName(currentAppId, collection))}
         (${columns.map(sqlIdentifier).join(", ")})
       VALUES (${values.map((_, index) => `?${index + 1}`).join(", ")})`
    ).bind(...values);
  } else {
    mutation = env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.objects}
         (app_id, collection, id, owner_id, group_id, data, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(currentAppId, collection, objectId, actorId, recordGroupId(table, validated.data), encoded, timestamp, timestamp);
  }
  const created = computedObjectJson(definition, collection, objectJson({
    id: objectId,
    owner_id: actorId,
    data: encoded,
    created_at: timestamp,
    updated_at: timestamp
  }));
  const jobs = await prepareWebhookEvent(
    env,
    currentAppId,
    backend,
    `${collection.charAt(0).toLowerCase()}${collection.slice(1)}.created`,
    created,
    actorId
  );
  return {
    created,
    statements: [mutation, ...declaredFileLinkStatements(
      env,
      currentAppId,
      actorId,
      definition,
      collection,
      objectId,
      validated.data
    ), ...jobs, recordAuditStatement(env, currentAppId, {
      table: collection,
      recordId: objectId,
      action: "created",
      actorId,
      createdAt: timestamp
    })]
  };
}
async function tableRoute(request, env, currentAppId, collection, definition, id, backend = {}) {
  validName(collection, "Table name");
  const publicRead = definition?.normalized.tables[collection]?.read === "public";
  const table = definition?.normalized.tables[collection];
  const reads = request.method === "GET" || request.method === "HEAD";
  const auth = publicRead && reads ? await optionalAuth(request, env, currentAppId, "tables:read") : await requireAuth(request, env, currentAppId, reads ? "tables:read" : "tables:write");
  if (!id && request.method === "POST") {
    const body = await readJson(request, env);
    const actorId = auth.user.id;
    if (Array.isArray(body.data)) {
      const rows = body.data;
      if (rows.length < 1 || rows.length > CREATE_MANY_MAX) {
        throw new HttpError(422, "VALIDATION_ERROR", rows.length < 1 ? "data must include at least one record." : `data accepts at most ${CREATE_MANY_MAX} records.`, {
          data: `Expected 1 to ${CREATE_MANY_MAX} records`
        });
      }
      return await withUsageCharge(
        env,
        currentAppId,
        backend,
        "records_written",
        rows.length,
        async () => {
          const prepared = [];
          for (let index = 0; index < rows.length; index += 1) {
            try {
              prepared.push(await prepareRecordCreate(
                env,
                currentAppId,
                collection,
                definition,
                table,
                backend,
                actorId,
                rows[index]
              ));
            } catch (error) {
              rejectCreateManyRow(index, error);
            }
          }
          await env.DB.batch(prepared.flatMap((row) => row.statements));
          for (const row of prepared) {
            await emitTableMutation(env, currentAppId, backend, collection, "created", row.created, actorId);
          }
          return json({ objects: prepared.map((row) => row.created) }, 201);
        }
      );
    }
    return await withUsageCharge(
      env,
      currentAppId,
      backend,
      "records_written",
      1,
      async () => {
        const single = await prepareRecordCreate(
          env,
          currentAppId,
          collection,
          definition,
          table,
          backend,
          actorId,
          body.data
        );
        await env.DB.batch(single.statements);
        await emitTableMutation(env, currentAppId, backend, collection, "created", single.created, actorId);
        return json({ object: single.created }, 201);
      }
    );
  }
  if (!id) throw new HttpError(404, "NOT_FOUND", "Route not found.");
  const existing = await findObject(
    env,
    currentAppId,
    collection,
    id,
    definition,
    auth?.user.id,
    request.method !== "GET" && request.method !== "HEAD"
  );
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (request.method === "GET" || request.method === "HEAD") {
    await recordUsage(env, currentAppId, "records_read");
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    return json({ object: computedObjectJson(definition, collection, objectJson(existing)) });
  }
  if (request.method === "PATCH") {
    const body = await readJson(request, env);
    const input = validateData(body.data, env);
    const changes = schemaData(definition, collection, input.data, true, env).data;
    await validateSchemaLinks(env, currentAppId, auth.user.id, definition, collection, changes);
    let mergedInput;
    try {
      mergedInput = mergeTicketSupply(
        definition,
        collection,
        JSON.parse(existing.data),
        changes
      );
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        throw new HttpError(422, "VALIDATION_ERROR", error.message, error.fields);
      }
      throw error;
    }
    const merged = validateData(mergedInput, env);
    await requireTeamAccess(env, currentAppId, auth.user.id, table, merged.data, true, existing.owner_id);
    const updatedAt = now();
    let mutation;
    if (table?.storage === "columns") {
      const fields = physicalFields(table);
      const values = physicalValues(merged.data, table, env);
      values.push(updatedAt, currentAppId, id);
      mutation = env.DB.prepare(
        `UPDATE ${sqlIdentifier(physicalTableName(currentAppId, collection))}
            SET ${fields.map((fieldName, index) => `${sqlIdentifier(fieldName)} = ?${index + 1}`).join(", ")},
                updated_at = ?${fields.length + 1}
          WHERE app_id = ?${fields.length + 2} AND id = ?${fields.length + 3}`
      ).bind(...values);
    } else {
      mutation = env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.objects}
            SET data = ?1, group_id = ?2, updated_at = ?3
          WHERE app_id = ?4 AND collection = ?5 AND id = ?6`
      ).bind(merged.encoded, recordGroupId(table, merged.data), updatedAt, currentAppId, collection, id);
    }
    const updated = computedObjectJson(
      definition,
      collection,
      objectJson({ ...existing, data: merged.encoded, updated_at: updatedAt })
    );
    const jobs = await prepareWebhookEvent(
      env,
      currentAppId,
      backend,
      `${collection.charAt(0).toLowerCase()}${collection.slice(1)}.updated`,
      updated,
      auth.user.id
    );
    await env.DB.batch([mutation, ...declaredFileLinkStatements(
      env,
      currentAppId,
      auth.user.id,
      definition,
      collection,
      id,
      merged.data
    ), ...jobs, recordAuditStatement(env, currentAppId, {
      table: collection,
      recordId: id,
      action: "updated",
      actorId: auth.user.id,
      createdAt: updatedAt
    })]);
    await emitTableMutation(env, currentAppId, backend, collection, "updated", updated, auth.user.id);
    return json({ object: updated });
  }
  if (request.method === "DELETE") {
    await requireTeamAccess(
      env,
      currentAppId,
      auth.user.id,
      table,
      JSON.parse(existing.data),
      true,
      existing.owner_id
    );
    let mutation;
    if (table?.storage === "columns") {
      const parameters = [currentAppId, id];
      const access = recordAccessClause(table, currentAppId, auth.user.id, parameters, true);
      mutation = env.DB.prepare(
        `DELETE FROM ${sqlIdentifier(physicalTableName(currentAppId, collection))}
          WHERE app_id = ?1 AND id = ?2${access ? ` AND ${access}` : ""}`
      ).bind(...parameters);
    } else {
      const parameters = [currentAppId, collection, id];
      const access = recordAccessClause(table, currentAppId, auth.user.id, parameters, true);
      mutation = env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.objects}
          WHERE app_id = ?1 AND collection = ?2 AND id = ?3${access ? ` AND ${access}` : ""}`
      ).bind(...parameters);
    }
    const removed = await mutation.run();
    const changes = removed.meta?.changes;
    if (changes !== void 0 && changes < 1) {
      throw new HttpError(404, "NOT_FOUND", "Object not found.");
    }
    const deleted = computedObjectJson(definition, collection, objectJson(existing));
    const jobs = await prepareWebhookEvent(
      env,
      currentAppId,
      backend,
      `${collection.charAt(0).toLowerCase()}${collection.slice(1)}.deleted`,
      deleted,
      auth.user.id
    );
    await env.DB.batch([...jobs, recordAuditStatement(env, currentAppId, {
      table: collection,
      recordId: id,
      action: "deleted",
      actorId: auth.user.id,
      createdAt: now()
    })]);
    await emitTableMutation(
      env,
      currentAppId,
      backend,
      collection,
      "deleted",
      computedObjectJson(definition, collection, objectJson(existing)),
      auth.user.id
    );
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  computedObjectJson,
  findObject,
  now,
  objectJson,
  physicalData,
  physicalFields,
  physicalObjectJson,
  physicalRowAsObject,
  physicalValue,
  physicalValues,
  publicProfileFields,
  recordGroupId,
  sqlIdentifier,
  tableRoute,
  userJson
};
