import { type ArmadilloEnv } from "../environment.js";
import { HttpError, passwordIterations } from "../http.js";
import { sha256, passwordHash } from "../helpers/crypto.js";
import { DATABASE_MIGRATION_VERSION } from "../../migrations.js";
import { now } from "../records.js";
import { INTERNAL_TABLES, type InternalUserRow } from "../../backend.js";
import { makeId, base64Url, randomBytes } from "../helpers/id.js";
import { createSessionToken, sessionResponse } from "../sessions.js";
import { sessionLifetimeMs } from "../http.js";
import { readJson } from "../validation.js";
import { enforceRateLimit, configuredBootstrapSecret, bootstrapSecretMatches } from "./sessions.js";
import { authInput } from "./credentials.js";
import { userJson } from "../records.js";

export async function bootstrapSuperadmin(
  request: Request,
  env: ArmadilloEnv,
  currentAppId: string,
): Promise<Response> {
  await enforceRateLimit(request, env, currentAppId, "bootstrap", 5, 60 * 60);
  const body = await readJson(request, env);
  const provided = (request.headers.get("x-armadillo-bootstrap-secret") ?? "").trim();
  const burned = await env.DB.prepare(
    `SELECT used_at FROM ${INTERNAL_TABLES.bootstrap} WHERE app_id = ?1 LIMIT 1`,
  ).bind(currentAppId).first<{ used_at: string }>();
  if (burned) throw new HttpError(409, "CONFLICT", "Superadmin bootstrap has already been completed.");
  if (!await bootstrapSecretMatches(env, provided)) {
    throw new HttpError(403, "FORBIDDEN", "The bootstrap secret is invalid or unavailable.");
  }

  const input = authInput(body, true);
  const timestamp = now();
  const userId = makeId("user");
  const groupId = makeId("group");
  const groupSlug = env.ARMADILLO_SUPERADMIN_GROUP?.trim() || "armadillo-superadmins";
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(groupSlug)) {
    throw new HttpError(500, "INTERNAL_ERROR", "ARMADILLO_SUPERADMIN_GROUP is invalid.");
  }
  const salt = base64Url(randomBytes(18));
  const iterations = passwordIterations(env);
  const hash = await passwordHash(input.password, salt, iterations);
  const sessionToken = createSessionToken();
  const sessionId = makeId("session");
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.users}
           (app_id, id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`,
      ).bind(currentAppId, userId, input.email, input.name, hash, salt, iterations, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.groups}
           (app_id, id, name, slug, trusted, created_by, created_at)
         VALUES (?1, ?2, 'Superadmins', ?3, 1, ?4, ?5)`,
      ).bind(currentAppId, groupId, groupSlug, userId, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.groupMembers}
           (app_id, group_id, user_id, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'owner', ?4, ?4)`,
      ).bind(currentAppId, groupId, userId, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.sessions}
           (app_id, id, token_hash, user_id, created_at, expires_at, auth_method)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'password')`,
      ).bind(
        currentAppId,
        sessionId,
        await sha256(sessionToken),
        userId,
        timestamp,
        expiresAt,
      ),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.bootstrap}
           (app_id, secret_hash, user_id, group_id, used_at, schema_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(currentAppId, await sha256(configuredBootstrapSecret(env)), userId, groupId, timestamp, DATABASE_MIGRATION_VERSION),
      env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.bootstrapSessions} WHERE app_id = ?1`,
      ).bind(currentAppId),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new HttpError(409, "CONFLICT", "Bootstrap was already used or that account already exists.");
    }
    throw error;
  }
  const user: InternalUserRow = {
    id: userId,
    email: input.email,
    name: input.name,
    password_hash: hash,
    password_salt: salt,
    password_iterations: iterations,
    password_enabled: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
  return sessionResponse(
    request,
    currentAppId,
    userJson(user),
    sessionToken,
    expiresAt,
    201,
    { group: { id: groupId, slug: groupSlug, role: "owner" } },
    env,
  );
}
