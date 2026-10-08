import {} from "../backend.js";
import {} from "../backend.js";
import {} from "../backend.js";
import {} from "../backend.js";
import { HttpError } from "./http.js";
import {} from "./environment.js";
import { now } from "./records.js";
import { INTERNAL_TABLES } from "../backend.js";
import { makeId } from "./helpers/id.js";
import { base64Url } from "./helpers/id.js";
import { randomBytes } from "./helpers/id.js";
import { sha256 } from "./helpers/crypto.js";
import { requireUserSession } from "./auth.js";
import { enforceRateLimit } from "./auth.js";
import { configuredInteger, json } from "./http.js";
import { readJson } from "./validation.js";
const API_KEY_ISSUE_LIMIT_DEFAULT = 30;
function apiKeyIssueLimit(env) {
  return configuredInteger(env.ARMADILLO_API_KEY_ISSUE_LIMIT, API_KEY_ISSUE_LIMIT_DEFAULT, 1, 1e5);
}
function apiKeyJson(row) {
  let scopes = [];
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
  }
  const revokedAt = row.revoked_at ?? (row.grace_expires_at && row.grace_expires_at <= now() ? row.grace_expires_at : null);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prefix: row.key_prefix,
    scopes,
    rotatedFrom: row.rotated_from,
    graceExpiresAt: row.grace_expires_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt
  };
}
function apiKeyAuditJson(row) {
  let details = {};
  try {
    details = JSON.parse(row.details);
  } catch {
  }
  return {
    id: row.id,
    keyId: row.key_id,
    actorId: row.actor_id,
    type: row.event_type,
    details,
    createdAt: row.created_at
  };
}
function apiKeyDescription(value) {
  if (value === void 0 || value === null) return null;
  const description = typeof value === "string" ? value.trim() : "";
  if (!description || description.length > 500) {
    throw new HttpError(422, "VALIDATION_ERROR", "API key description is invalid.", {
      description: "Use 1 to 500 characters"
    });
  }
  return description;
}
function apiKeyScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new HttpError(422, "VALIDATION_ERROR", "API key scopes are invalid.", {
      scopes: "Choose 1 to 20 scopes"
    });
  }
  const scopes = [...new Set(value)];
  const allowed = /^(?:\*|tables:(?:read|write)|files:(?:read|write)|groups:(?:read|write)|events:read|vouchers:(?:read|write|consume)|tickets:(?:read|issue|consume)|collectors:(?:read|submit)|functions:(?:invoke|[A-Za-z][A-Za-z0-9_-]{0,63}))$/;
  if (scopes.some((scope) => typeof scope !== "string" || !allowed.test(scope))) {
    throw new HttpError(422, "VALIDATION_ERROR", "API key scopes are invalid.", {
      scopes: "Use an Armadillo scope such as tables:read or functions:my_function"
    });
  }
  return scopes.sort();
}
async function recordApiKeyAudit(env, currentAppId, keyId, actorId, eventType, details, timestamp = now()) {
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.apiKeyAudit}
       (app_id, id, key_id, actor_id, event_type, details, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(
    currentAppId,
    makeId("key_audit"),
    keyId,
    actorId,
    eventType,
    JSON.stringify(details),
    timestamp
  ).run();
}
async function issueApiKey(env, currentAppId, ownerId, input) {
  const secret = `arm_${env.ARMADILLO_DEV_MODE === "1" ? "test" : "live"}_${base64Url(randomBytes(32))}`;
  const id = makeId("key");
  const timestamp = now();
  const prefix = secret.slice(0, 18);
  const apiKey = {
    id,
    owner_id: ownerId,
    name: input.name,
    description: input.description,
    key_prefix: prefix,
    scopes: JSON.stringify(input.scopes),
    rotated_from: input.rotatedFrom ?? null,
    grace_expires_at: null,
    created_at: timestamp,
    expires_at: input.expiresAt,
    last_used_at: null,
    revoked_at: null
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.apiKeys}
         (app_id, id, owner_id, name, description, key_hash, key_prefix, scopes, rotated_from, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(
      currentAppId,
      apiKey.id,
      ownerId,
      apiKey.name,
      apiKey.description,
      await sha256(secret),
      apiKey.key_prefix,
      apiKey.scopes,
      apiKey.rotated_from,
      apiKey.created_at,
      apiKey.expires_at
    ),
    env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.apiKeyAudit}
         (app_id, id, key_id, actor_id, event_type, details, created_at)
       VALUES (?1, ?2, ?3, ?4, 'created', ?5, ?6)`
    ).bind(
      currentAppId,
      makeId("key_audit"),
      apiKey.id,
      ownerId,
      JSON.stringify({ prefix, ...input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {} }),
      timestamp
    )
  ]);
  return { apiKey, secret };
}
async function apiKeyForOwner(env, currentAppId, ownerId, id) {
  const row = await env.DB.prepare(
    `SELECT id, owner_id, name, description, key_prefix, scopes, rotated_from, grace_expires_at,
            created_at, expires_at, last_used_at, revoked_at
       FROM ${INTERNAL_TABLES.apiKeys}
      WHERE app_id = ?1 AND owner_id = ?2 AND id = ?3 LIMIT 1`
  ).bind(currentAppId, ownerId, id).first();
  if (!row) throw new HttpError(404, "NOT_FOUND", "API key not found.");
  return row;
}
async function apiKeysRoute(request, env, currentAppId, id, action) {
  const auth = await requireUserSession(request, env, currentAppId);
  if (action && (!id || !["audit", "rotate"].includes(action))) {
    throw new HttpError(404, "NOT_FOUND", "Route not found.");
  }
  if (!id && request.method === "GET") {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    let cursorCreatedAt = null;
    let cursorId = null;
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      cursorCreatedAt = separator > 0 ? cursor.slice(0, separator) : null;
      cursorId = separator > 0 ? cursor.slice(separator + 1) : null;
      if (!cursorCreatedAt || !cursorId || !Number.isFinite(Date.parse(cursorCreatedAt))) {
        throw new HttpError(400, "BAD_REQUEST", "API key cursor is invalid.");
      }
    }
    const parameters = [currentAppId, auth.user.id];
    let older = "";
    if (cursorCreatedAt && cursorId) {
      older = "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))";
      parameters.push(cursorCreatedAt, cursorId);
    }
    parameters.push(101);
    const result = await env.DB.prepare(
      `SELECT id, owner_id, name, description, key_prefix, scopes, rotated_from, grace_expires_at,
              created_at, expires_at, last_used_at, revoked_at
         FROM ${INTERNAL_TABLES.apiKeys}
        WHERE app_id = ?1 AND owner_id = ?2
          ${older}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...parameters).all();
    const rows = result.results ?? [];
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return json({
      apiKeys: page.map(apiKeyJson),
      nextCursor: rows.length > 100 && last ? `${last.created_at}|${last.id}` : null
    });
  }
  if (!id && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "api-key-issue", apiKeyIssueLimit(env), 60 * 60, await sha256(auth.user.id));
    const body = await readJson(request, env);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      throw new HttpError(422, "VALIDATION_ERROR", "API key name is invalid.", { name: "Use 1 to 120 characters" });
    }
    const description = apiKeyDescription(body.description);
    const scopes = apiKeyScopes(body.scopes);
    let expiresAt = null;
    if (body.expiresAt !== void 0 && body.expiresAt !== null) {
      const parsed = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + 366 * 24 * 60 * 60 * 1e3) {
        throw new HttpError(422, "VALIDATION_ERROR", "API key expiry is invalid.", {
          expiresAt: "Choose a future date no more than one year away"
        });
      }
      expiresAt = new Date(parsed).toISOString();
    }
    const issued = await issueApiKey(env, currentAppId, auth.user.id, {
      name,
      description,
      scopes,
      expiresAt
    });
    return json({ apiKey: apiKeyJson(issued.apiKey), secret: issued.secret }, 201);
  }
  if (id && !action && request.method === "GET") {
    return json({ apiKey: apiKeyJson(await apiKeyForOwner(env, currentAppId, auth.user.id, id)) });
  }
  if (id && action === "audit" && request.method === "GET") {
    await apiKeyForOwner(env, currentAppId, auth.user.id, id);
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    let cursorCreatedAt = null;
    let cursorId = null;
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      cursorCreatedAt = separator > 0 ? cursor.slice(0, separator) : null;
      cursorId = separator > 0 ? cursor.slice(separator + 1) : null;
      if (!cursorCreatedAt || !cursorId || !Number.isFinite(Date.parse(cursorCreatedAt))) {
        throw new HttpError(400, "BAD_REQUEST", "API key audit cursor is invalid.");
      }
    }
    const parameters = [currentAppId, id];
    let older = "";
    if (cursorCreatedAt && cursorId) {
      older = "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))";
      parameters.push(cursorCreatedAt, cursorId);
    }
    parameters.push(101);
    const result = await env.DB.prepare(
      `SELECT id, key_id, actor_id, event_type, details, created_at
         FROM ${INTERNAL_TABLES.apiKeyAudit}
        WHERE app_id = ?1 AND key_id = ?2
          ${older}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...parameters).all();
    const rows = result.results ?? [];
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return json({
      audit: page.map(apiKeyAuditJson),
      nextCursor: rows.length > 100 && last ? `${last.created_at}|${last.id}` : null
    });
  }
  if (id && action === "rotate" && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "api-key-issue", apiKeyIssueLimit(env), 60 * 60, await sha256(auth.user.id));
    const current = await apiKeyForOwner(env, currentAppId, auth.user.id, id);
    if (current.revoked_at) throw new HttpError(409, "CONFLICT", "Revoked API keys cannot be rotated.");
    if (current.expires_at && current.expires_at <= now()) {
      throw new HttpError(409, "CONFLICT", "Expired API keys cannot be rotated. Create a new key instead.");
    }
    if (current.grace_expires_at && current.grace_expires_at <= now()) {
      throw new HttpError(409, "CONFLICT", "This API key is no longer active. Create a new key instead.");
    }
    if (current.grace_expires_at) {
      throw new HttpError(409, "CONFLICT", "This API key is already rotating. Wait for its grace period to end.");
    }
    const body = await readJson(request, env);
    const gracePeriodSeconds = body.gracePeriodSeconds === void 0 ? 0 : typeof body.gracePeriodSeconds === "number" ? body.gracePeriodSeconds : Number.NaN;
    if (!Number.isSafeInteger(gracePeriodSeconds) || gracePeriodSeconds < 0 || gracePeriodSeconds > 604800) {
      throw new HttpError(422, "VALIDATION_ERROR", "API key grace period is invalid.", {
        gracePeriodSeconds: "Use an integer from 0 to 604800"
      });
    }
    const timestamp = now();
    const graceExpiresAt = gracePeriodSeconds === 0 ? null : new Date(Date.now() + gracePeriodSeconds * 1e3).toISOString();
    const issued = await issueApiKey(env, currentAppId, auth.user.id, {
      name: current.name,
      description: current.description,
      scopes: apiKeyScopes(JSON.parse(current.scopes)),
      expiresAt: current.expires_at,
      rotatedFrom: current.id
    });
    await env.DB.batch([
      // Guarded on `revoked_at IS NULL`: two concurrent rotations both read a
      // live key, both minted a replacement, and the first replacement was left
      // orphaned but fully valid. The same predicate also refuses to restart a
      // grace window an operator is winding down.
      env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.apiKeys}
            SET revoked_at = ?1, grace_expires_at = ?2
          WHERE app_id = ?3 AND id = ?4 AND revoked_at IS NULL`
      ).bind(graceExpiresAt === null ? timestamp : null, graceExpiresAt, currentAppId, current.id),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.apiKeyAudit}
           (app_id, id, key_id, actor_id, event_type, details, created_at)
         VALUES (?1, ?2, ?3, ?4, 'rotated', ?5, ?6)`
      ).bind(
        currentAppId,
        makeId("key_audit"),
        current.id,
        auth.user.id,
        JSON.stringify({ replacementId: issued.apiKey.id, graceExpiresAt }),
        timestamp
      )
    ]);
    return json({ apiKey: apiKeyJson(issued.apiKey), secret: issued.secret }, 201);
  }
  if (id && !action && request.method === "PATCH") {
    const current = await apiKeyForOwner(env, currentAppId, auth.user.id, id);
    const body = await readJson(request, env);
    const name = body.name === void 0 ? current.name : typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      throw new HttpError(422, "VALIDATION_ERROR", "API key name is invalid.", { name: "Use 1 to 120 characters" });
    }
    const description = body.description === void 0 ? current.description : apiKeyDescription(body.description);
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.apiKeys} SET name = ?1, description = ?2
        WHERE app_id = ?3 AND id = ?4 AND owner_id = ?5`
    ).bind(name, description, currentAppId, id, auth.user.id).run();
    return json({ apiKey: apiKeyJson({ ...current, name, description }) });
  }
  if (id && !action && request.method === "DELETE") {
    const result = await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.apiKeys} SET revoked_at = ?1
        WHERE app_id = ?2 AND id = ?3 AND owner_id = ?4 AND revoked_at IS NULL`
    ).bind(now(), currentAppId, id, auth.user.id).run();
    if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, "NOT_FOUND", "API key not found.");
    await recordApiKeyAudit(env, currentAppId, id, auth.user.id, "revoked", {});
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  apiKeyAuditJson,
  apiKeyDescription,
  apiKeyForOwner,
  apiKeyJson,
  apiKeyScopes,
  apiKeysRoute,
  issueApiKey,
  recordApiKeyAudit
};
