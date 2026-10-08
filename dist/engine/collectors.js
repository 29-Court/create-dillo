import {} from "../backend.js";
import {} from "../index.js";
import {} from "../backend.js";
import {} from "../backend.js";
import { isObject } from "./helpers/json.js";
import {} from "./environment.js";
import {} from "../backend.js";
import { HttpError } from "./http.js";
import { schemaData } from "./validation.js";
import { validateSchemaLinks } from "./validation.js";
import { makeId } from "./helpers/id.js";
import { physicalFields } from "./records.js";
import { physicalValues } from "./records.js";
import { sqlIdentifier } from "./records.js";
import { physicalTableName } from "../index.js";
import { INTERNAL_TABLES } from "../backend.js";
import { syncDeclaredFileLinks } from "./validation.js";
import { now, recordGroupId } from "./records.js";
import { optionalAuth, requireAuth } from "./auth.js";
import { enforceRateLimit } from "./auth.js";
import { readJson } from "./validation.js";
import { configuredTeam } from "./teams.js";
import { json } from "./http.js";
import { requireTeamPolicy } from "./teams.js";
function collectorSchema(definition) {
  const fields = Object.fromEntries(
    Object.entries(definition.fields).map(([name, field]) => [name, { ...field.config }])
  );
  return {
    tables: {},
    normalized: {
      tables: {
        Submission: { fields, computeds: {}, read: "owner", storage: "json", indexes: {} }
      }
    }
  };
}
function collectorSubmissionJson(row) {
  let data = {};
  try {
    const parsed = JSON.parse(row.data);
    if (isObject(parsed)) data = parsed;
  } catch {
  }
  return {
    id: row.id,
    collectorId: row.collector_id,
    userId: row.user_id,
    teamId: row.group_id,
    project: row.project_id,
    data,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
function boundedRetentionDays(value) {
  if (value === void 0) return 365;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(422, "VALIDATION_ERROR", "retentionDays must be a whole number of days.", {
      retentionDays: "Use at least 1"
    });
  }
  return Math.min(value, 3650);
}
async function writeCollectorModel(env, currentAppId, backend, definition, team, ownerId, captured, timestamp) {
  const collection = definition.model;
  if (!collection) return void 0;
  const table = backend.schema?.normalized.tables[collection];
  if (backend.schema && !table) {
    throw new HttpError(500, "INTERNAL_ERROR", `Collector model \`${collection}\` is not in the application schema.`);
  }
  const data = { ...captured };
  if (table?.team) data[table.team.field] = team.id;
  const validated = schemaData(backend.schema, collection, data, false, env);
  await validateSchemaLinks(env, currentAppId, ownerId, backend.schema, collection, validated.data);
  const id = makeId(collection.toLowerCase());
  if (table?.storage === "columns") {
    const fields = physicalFields(table);
    const columns = ["app_id", "id", "owner_id", ...fields, "created_at", "updated_at"];
    const values = [
      currentAppId,
      id,
      ownerId,
      ...physicalValues(validated.data, table, env),
      timestamp,
      timestamp
    ];
    await env.DB.prepare(
      `INSERT INTO ${sqlIdentifier(physicalTableName(currentAppId, collection))}
         (${columns.map(sqlIdentifier).join(", ")})
       VALUES (${values.map((_, index) => `?${index + 1}`).join(", ")})`
    ).bind(...values).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.objects}
         (app_id, collection, id, owner_id, group_id, data, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(currentAppId, collection, id, ownerId, recordGroupId(table, validated.data), validated.encoded, timestamp, timestamp).run();
  }
  await syncDeclaredFileLinks(env, currentAppId, ownerId, backend.schema, collection, id, validated.data);
  return { id, collection };
}
async function collectorsRoute(request, env, currentAppId, id, definition, backend, action) {
  if (!definition) throw new HttpError(404, "NOT_FOUND", "Collector not found.");
  const authMode = definition.auth ?? "optional";
  if (!action && request.method === "POST") {
    if (definition.expiresAt && definition.expiresAt <= now()) {
      throw new HttpError(410, "CONFLICT", "This collector is closed.");
    }
    const authorization = request.headers.get("authorization");
    const auth = authMode === "required" ? await requireAuth(request, env, currentAppId, "collectors:submit") : authMode === "optional" && authorization ? await optionalAuth(request, env, currentAppId, "collectors:submit") : null;
    await enforceRateLimit(
      request,
      env,
      currentAppId,
      `collector-${id}`,
      auth ? 120 : 20,
      10 * 60,
      auth?.user.id ?? "anonymous"
    );
    const body = await readJson(request, env);
    if (!isObject(body.data)) {
      throw new HttpError(422, "VALIDATION_ERROR", "Collector data must be an object.", {
        data: "Expected an object"
      });
    }
    const captured = schemaData(collectorSchema(definition), "Submission", body.data, false, env);
    const team = await configuredTeam(env, currentAppId, definition.access.team);
    const createdAt = now();
    const expiresAt = new Date(
      Date.now() + boundedRetentionDays(definition.retentionDays) * 24 * 60 * 60 * 1e3
    ).toISOString();
    const submission = {
      id: makeId("submission"),
      collector_id: id,
      user_id: auth?.user.id ?? null,
      group_id: team.id,
      project_id: definition.project ?? null,
      data: captured.encoded,
      created_at: createdAt,
      expires_at: expiresAt
    };
    const record = await writeCollectorModel(
      env,
      currentAppId,
      backend,
      definition,
      team,
      auth?.user.id ?? team.created_by,
      captured.data,
      createdAt
    );
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.collectorSubmissions}
         (app_id, id, collector_id, user_id, group_id, project_id, data, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      currentAppId,
      submission.id,
      submission.collector_id,
      submission.user_id,
      submission.group_id,
      submission.project_id,
      submission.data,
      submission.created_at,
      submission.expires_at
    ).run();
    return json({
      submission: { ...collectorSubmissionJson(submission), ...record ? { record } : {} }
    }, 201);
  }
  if (action === "submissions" && request.method === "GET") {
    const auth = await requireAuth(request, env, currentAppId, "collectors:read");
    const membership = await requireTeamPolicy(
      env,
      currentAppId,
      definition.access.team,
      auth.user.id,
      definition.access.roles
    );
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    let cursorCreatedAt = null;
    let cursorId = null;
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      cursorCreatedAt = separator > 0 ? cursor.slice(0, separator) : null;
      cursorId = separator > 0 ? cursor.slice(separator + 1) : null;
      if (!cursorCreatedAt || !cursorId || !Number.isFinite(Date.parse(cursorCreatedAt))) {
        throw new HttpError(400, "BAD_REQUEST", "Collector cursor is invalid.");
      }
    }
    const parameters = [currentAppId, id, membership.id, now()];
    let older = "";
    if (cursorCreatedAt && cursorId) {
      older = "AND (created_at < ?5 OR (created_at = ?5 AND id < ?6))";
      parameters.push(cursorCreatedAt, cursorId);
    }
    parameters.push(101);
    const result = await env.DB.prepare(
      `SELECT id, collector_id, user_id, group_id, project_id, data, created_at, expires_at
         FROM ${INTERNAL_TABLES.collectorSubmissions}
        WHERE app_id = ?1 AND collector_id = ?2 AND group_id = ?3 AND expires_at > ?4
          ${older}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...parameters).all();
    const rows = result.results ?? [];
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return json({
      submissions: page.map(collectorSubmissionJson),
      nextCursor: rows.length > 100 && last ? `${last.created_at}|${last.id}` : null
    });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  boundedRetentionDays,
  collectorSchema,
  collectorSubmissionJson,
  collectorsRoute
};
