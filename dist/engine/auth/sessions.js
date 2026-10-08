import { AUTH_PROVIDER } from "../environment.js";
import { INTERNAL_TABLES, ArmadilloFunctionError } from "../../backend.js";
import { sha256, constantTimeEqual, constantTimeEqualSecret, passwordHash } from "../helpers/crypto.js";
import { now } from "../records.js";
import { makeId, base64Url, randomBytes } from "../helpers/id.js";
import { passwordIterations, MAX_PASSWORD_ITERATIONS, HttpError, FIELD, sessionLifetimeMs } from "../http.js";
import { createSessionToken, SESSION_TOKEN_PREFIX, sessionResponse, cookieValue, sessionCookieName } from "../sessions.js";
import { acceptsContentType, readJson } from "../validation.js";
import { encodeUserProfile } from "../../schema.js";
import { userJson } from "../records.js";
import { enforceRateLimit as enforceRateLimitForDatabase } from "../middleware/rate-limit.js";
import { authInput, scopeAllows, sessionAuthMethod, profileAssignments, readProfileAssignment, profileConflict } from "./credentials.js";
const MIN_ADMINISTRATIVE_SECRET_LENGTH = 24;
function assertAdministrativeSecretStrength(env) {
  for (const [name, value] of [
    ["ARMADILLO_ADMIN_KEY", env.ARMADILLO_ADMIN_KEY],
    ["ARMADILLO_BOOTSTRAP_SECRET", env.ARMADILLO_BOOTSTRAP_SECRET]
  ]) {
    if (value !== void 0 && value.trim().length > 0 && value.trim().length < MIN_ADMINISTRATIVE_SECRET_LENGTH) {
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        `${name} must be at least ${MIN_ADMINISTRATIVE_SECRET_LENGTH} characters.`
      );
    }
  }
}
function externalAuthProvider(env) {
  return env[AUTH_PROVIDER];
}
async function externalAuth(request, env, currentAppId, requiredScope) {
  const provider = externalAuthProvider(env);
  if (!provider) return void 0;
  let identity;
  try {
    identity = await provider.authenticate({ request, appId: currentAppId, runtime: env });
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "External authentication could not verify this request.");
  }
  if (!identity) return void 0;
  const subject = identity.subject.trim();
  const email = identity.email.trim().toLowerCase();
  const name = identity.name?.trim() || null;
  if (!subject || subject.length > 1024 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new HttpError(401, "UNAUTHENTICATED", "External authentication returned an invalid identity.");
  }
  const suppliedScopes = identity.scopes;
  if (suppliedScopes && (!Array.isArray(suppliedScopes) || suppliedScopes.some((scope) => typeof scope !== "string" || !scope || scope.length > 128))) {
    throw new HttpError(401, "UNAUTHENTICATED", "External authentication returned invalid scopes.");
  }
  const scopes = suppliedScopes ? [...suppliedScopes] : provider.defaultScopes?.length ? [...provider.defaultScopes] : [];
  if (requiredScope && !scopeAllows(scopes, requiredScope)) {
    throw new HttpError(403, "FORBIDDEN", `External identity is missing the \`${requiredScope}\` scope.`);
  }
  const identityHash = await sha256(`${provider.id}
${subject}`);
  const userId = `external_${identityHash.slice(0, 48)}`;
  const timestamp = now();
  const existing = await env.DB.prepare(
    `SELECT id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, profile, created_at, updated_at
       FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(currentAppId, userId).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.users} SET email = ?1, name = ?2, updated_at = ?3
        WHERE app_id = ?4 AND id = ?5`
    ).bind(email, name, timestamp, currentAppId, userId).run();
  } else {
    try {
      await env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.users}
           (app_id, id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?7)`
      ).bind(currentAppId, userId, email, name, "external", provider.id, timestamp).run();
    } catch {
      throw new HttpError(
        409,
        "CONFLICT",
        "This external identity conflicts with an existing Dillo user. Migrate that user before enabling the provider."
      );
    }
  }
  const user = await env.DB.prepare(
    `SELECT id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, profile, created_at, updated_at
       FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(currentAppId, userId).first();
  if (!user) throw new HttpError(500, "INTERNAL_ERROR", "Could not create the external user profile.");
  return {
    user,
    tokenHash: identityHash,
    external: true,
    principal: { type: "user", id: user.id, name: user.name, scopes }
  };
}
async function requireAuth(request, env, currentAppId, requiredScope) {
  const external = await externalAuth(request, env, currentAppId, requiredScope);
  if (external) return external;
  const provider = externalAuthProvider(env);
  if (provider && !provider.allowBuiltInCredentials) {
    throw new HttpError(401, "UNAUTHENTICATED", "Log in with the configured authentication provider.");
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  const credential = request.headers.has("authorization") ? match?.[1] : cookieValue(request, sessionCookieName(currentAppId));
  if (!credential || credential.length > 1024) {
    throw new HttpError(401, "UNAUTHENTICATED", "Log in to continue.");
  }
  const tokenHash = await sha256(credential);
  const timestamp = now();
  const sweepExpiredSession = credential.startsWith(SESSION_TOKEN_PREFIX);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.password_hash, u.password_salt,
            u.password_iterations, u.password_enabled, u.profile, u.created_at, u.updated_at,
            s.auth_method
       FROM ${INTERNAL_TABLES.sessions} AS s
       JOIN ${INTERNAL_TABLES.users} AS u
         ON u.app_id = s.app_id AND u.id = s.user_id
      WHERE s.app_id = ?1 AND s.token_hash = ?2 AND s.expires_at > ?3
      LIMIT 1`
  ).bind(currentAppId, tokenHash, timestamp).first();
  if (row) {
    const authMethod = sessionAuthMethod(row.auth_method);
    return {
      user: row,
      tokenHash,
      ...authMethod ? { authMethod } : {},
      principal: { type: "user", id: row.id, name: row.name, scopes: ["*"] }
    };
  }
  const key = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.password_hash, u.password_salt,
            u.password_iterations, u.password_enabled, u.profile, u.created_at, u.updated_at,
            k.id AS key_id, k.name AS key_name, k.scopes
       FROM ${INTERNAL_TABLES.apiKeys} AS k
       JOIN ${INTERNAL_TABLES.users} AS u
         ON u.app_id = k.app_id AND u.id = k.owner_id
      WHERE k.app_id = ?1 AND k.key_hash = ?2 AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > ?3)
        AND (k.grace_expires_at IS NULL OR k.grace_expires_at > ?3)
      LIMIT 1`
  ).bind(currentAppId, tokenHash, timestamp).first();
  if (!key) {
    if (sweepExpiredSession) {
      await env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?1 AND token_hash = ?2 AND expires_at <= ?3`
      ).bind(currentAppId, tokenHash, timestamp).run();
    }
    throw new HttpError(401, "UNAUTHENTICATED", "Credential is missing, revoked, or expired.");
  }
  let scopes;
  try {
    const parsed = JSON.parse(key.scopes);
    scopes = Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
  } catch {
    scopes = [];
  }
  if (requiredScope && !scopeAllows(scopes, requiredScope)) {
    throw new HttpError(403, "FORBIDDEN", `API key is missing the \`${requiredScope}\` scope.`);
  }
  const throttleCutoff = new Date(Date.now() - 60 * 60 * 1e3).toISOString();
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.apiKeys} SET last_used_at = ?1
      WHERE app_id = ?2 AND id = ?3
        AND (last_used_at IS NULL OR last_used_at < ?4)`
  ).bind(timestamp, currentAppId, key.key_id, throttleCutoff).run();
  return {
    user: key,
    tokenHash,
    principal: { type: "api_key", id: key.key_id, name: key.key_name, scopes }
  };
}
async function optionalAuth(request, env, currentAppId, requiredScope) {
  try {
    return await requireAuth(request, env, currentAppId, requiredScope);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return void 0;
    throw error;
  }
}
async function requireUserSession(request, env, currentAppId) {
  const auth = await requireAuth(request, env, currentAppId);
  if (auth.principal.type !== "user") {
    throw new HttpError(403, "FORBIDDEN", "A user session is required for credential administration.");
  }
  return auth;
}
async function requireAdminKey(request, env) {
  assertAdministrativeSecretStrength(env);
  const configured = env.ARMADILLO_ADMIN_KEY?.trim() ?? "";
  const provided = request.headers.get("x-armadillo-admin-key")?.trim() ?? "";
  const matches = await constantTimeEqualSecret(configured, provided);
  if (!configured || !provided || !matches) {
    throw new HttpError(403, "FORBIDDEN", "Administrative authority is required.");
  }
}
async function enforceRateLimit(request, env, currentAppId, bucket, limit, windowSeconds, discriminator = "") {
  await enforceRateLimitForDatabase(
    request,
    env.DB,
    env,
    currentAppId,
    bucket,
    limit,
    windowSeconds,
    discriminator
  );
}
function safeRedirect(request, env, candidate) {
  const base = new URL(env.ARMADILLO_PUBLIC_URL?.trim() || request.url);
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  if (candidate === void 0) return base.toString();
  if (typeof candidate !== "string" || candidate.length > 2048) {
    throw new HttpError(422, "VALIDATION_ERROR", "Magic-link redirect is invalid.", {
      redirectTo: "Use an absolute same-origin URL"
    });
  }
  let redirect;
  try {
    redirect = new URL(candidate, base);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Magic-link redirect is invalid.", {
      redirectTo: "Use an absolute same-origin URL"
    });
  }
  const configuredOrigins = (env.CORS_ORIGIN ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (redirect.protocol !== "https:" && redirect.protocol !== "http:") {
    throw new HttpError(422, "VALIDATION_ERROR", "Magic-link redirect is invalid.");
  }
  if (redirect.origin !== base.origin && !configuredOrigins.includes(redirect.origin)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Magic-link redirect must use an allowed application origin.");
  }
  return redirect.toString();
}
function configuredBootstrapSecret(env) {
  return env.ARMADILLO_BOOTSTRAP_SECRET?.trim() || "";
}
async function bootstrapSecretMatches(env, provided) {
  assertAdministrativeSecretStrength(env);
  const configured = configuredBootstrapSecret(env);
  const candidate = provided.trim();
  if (!configured || !candidate) return false;
  return constantTimeEqual(await sha256(configured), await sha256(candidate));
}
async function declaredUserFields(env, currentAppId, schema) {
  if (schema) {
    const result2 = {};
    for (const [name, field] of Object.entries(schema.normalized.users?.fields ?? {})) {
      if (!FIELD.test(name) || !field) continue;
      result2[name] = field;
    }
    return result2;
  }
  const row = await env.DB.prepare(
    `SELECT schema_json FROM ${INTERNAL_TABLES.schemaState} WHERE app_id = ?1 LIMIT 1`
  ).bind(currentAppId).first();
  if (!row) return {};
  let parsed;
  try {
    parsed = JSON.parse(row.schema_json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const users = parsed.users;
  const fields = users?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const result = {};
  for (const [name, field] of Object.entries(fields)) {
    if (!FIELD.test(name) || !field || typeof field !== "object") continue;
    result[name] = field;
  }
  return result;
}
async function assertOwnedProfileFiles(env, currentAppId, userId, fields, assignments) {
  const issues = {};
  await Promise.all(Object.keys(assignments).map(async (key) => {
    const field = fields[key];
    if (field?.type !== "file") return;
    const value = assignments[key];
    if (typeof value !== "string") return;
    const stored = await env.DB.prepare(
      `SELECT content_type, size FROM ${INTERNAL_TABLES.files}
        WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 LIMIT 1`
    ).bind(currentAppId, value, userId).first();
    if (!stored) {
      issues[key] = "Upload this file before attaching it";
      return;
    }
    if (field.contentTypes && !acceptsContentType(stored.content_type, field.contentTypes)) {
      issues[key] = `Use ${field.contentTypes.join(" or ")}`;
      return;
    }
    if (field.maxBytes !== void 0 && stored.size > field.maxBytes) {
      issues[key] = `File must be at most ${field.maxBytes} bytes`;
    }
  }));
  if (Object.keys(issues).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Profile files are invalid.", issues);
  }
}
async function profileJsonForCreate(env, currentAppId, body, reserved, schema) {
  const fields = await declaredUserFields(env, currentAppId, schema);
  if (Object.keys(fields).length === 0) return "{}";
  const missing = Object.entries(fields).some(([key, field]) => field.required && field.type !== "file" && field.default === void 0 && !Object.hasOwn(body, key));
  if (missing) return void 0;
  const assignments = profileAssignments(body, fields, reserved);
  return encodeUserProfile(readProfileAssignment(fields, {}, assignments, "create"));
}
async function signUp(request, env, currentAppId, schema) {
  const mode = env.ARMADILLO_SIGNUP_MODE?.trim().toLowerCase() || "closed";
  if (mode !== "open" && mode !== "closed") {
    throw new HttpError(500, "INTERNAL_ERROR", "Signup policy configuration is invalid.");
  }
  if (mode === "closed") {
    throw new HttpError(403, "FORBIDDEN", "Public signup is disabled.");
  }
  const body = await readJson(request, env);
  const input = authInput(body, true);
  await enforceRateLimit(request, env, currentAppId, "signup", 5, 60 * 60, await sha256(input.email));
  await enforceRateLimit(request, env, currentAppId, "signup-global", 100, 15 * 60);
  const fields = await declaredUserFields(env, currentAppId, schema);
  const assignments = profileAssignments(body, fields, ["email", "password", "name"]);
  const profile = readProfileAssignment(fields, {}, assignments, "create");
  const createdAt = now();
  const userId = makeId("user");
  await assertOwnedProfileFiles(env, currentAppId, userId, fields, assignments);
  const profileJson = encodeUserProfile(profile);
  const salt = base64Url(randomBytes(18));
  const iterations = passwordIterations(env);
  const hash = await passwordHash(input.password, salt, iterations);
  const token = createSessionToken();
  const tokenHash = await sha256(token);
  const sessionId = makeId("session");
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.users}
           (app_id, id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, profile, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?9)`
      ).bind(currentAppId, userId, input.email, input.name, hash, salt, iterations, profileJson, createdAt),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.sessions}
           (app_id, id, token_hash, user_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(currentAppId, sessionId, tokenHash, userId, createdAt, expiresAt)
    ]);
  } catch (error) {
    const conflict = profileConflict(error);
    if (conflict) throw conflict;
    if (String(error).toLowerCase().includes("unique")) {
      const user2 = {
        id: userId,
        email: input.email,
        name: input.name,
        password_hash: hash,
        password_salt: salt,
        password_iterations: iterations,
        password_enabled: 1,
        profile: profileJson,
        created_at: createdAt,
        updated_at: createdAt
      };
      return sessionResponse(request, currentAppId, userJson(user2), token, expiresAt, 201, {}, env);
    }
    throw error;
  }
  const user = {
    id: userId,
    email: input.email,
    name: input.name,
    password_hash: hash,
    password_salt: salt,
    password_iterations: iterations,
    password_enabled: 1,
    profile: profileJson,
    created_at: createdAt,
    updated_at: createdAt
  };
  return sessionResponse(request, currentAppId, userJson(user), token, expiresAt, 201, {}, env);
}
async function logIn(request, env, currentAppId) {
  const input = authInput(await readJson(request, env), false);
  await enforceRateLimit(request, env, currentAppId, "login", 10, 15 * 60, await sha256(input.email));
  await enforceRateLimit(request, env, currentAppId, "login-global", 100, 15 * 60);
  const user = await env.DB.prepare(
    `SELECT id, email, name, password_hash, password_salt,
            password_iterations, password_enabled, profile, created_at, updated_at
       FROM ${INTERNAL_TABLES.users}
      WHERE app_id = ?1 AND email = ?2
      LIMIT 1`
  ).bind(currentAppId, input.email).first();
  const salt = user?.password_salt ?? "invalid-armadillo-password-salt";
  const iterations = user && user.password_iterations > 0 && user.password_iterations <= MAX_PASSWORD_ITERATIONS ? user.password_iterations : passwordIterations(env);
  const candidate = await passwordHash(input.password, salt, iterations);
  if (!user || user.password_iterations <= 0 || user.password_iterations > MAX_PASSWORD_ITERATIONS || user.password_enabled !== 1 || !constantTimeEqual(candidate, user.password_hash)) {
    throw new HttpError(401, "UNAUTHENTICATED", "Email or password is incorrect.");
  }
  const token = createSessionToken();
  const tokenHash = await sha256(token);
  const createdAt = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.sessions}
       (app_id, id, token_hash, user_id, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(
    currentAppId,
    makeId("session"),
    tokenHash,
    user.id,
    createdAt,
    expiresAt
  ).run();
  return sessionResponse(request, currentAppId, userJson(user), token, expiresAt, 200, {}, env);
}
async function changePassword(request, env, currentAppId) {
  const auth = await requireUserSession(request, env, currentAppId);
  const body = await readJson(request, env);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const fields = {};
  const establishingFirstPassword = auth.user.password_enabled === 0;
  if (!establishingFirstPassword && (currentPassword.length < 10 || currentPassword.length > 1024)) {
    fields.currentPassword = "Use between 10 and 1,024 characters";
  }
  if (newPassword.length < 10 || newPassword.length > 1024) {
    fields.newPassword = "Use between 10 and 1,024 characters";
  }
  if (Object.keys(fields).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Password input is invalid.", fields);
  }
  await enforceRateLimit(
    request,
    env,
    currentAppId,
    "password-change",
    10,
    15 * 60,
    await sha256(auth.user.id)
  );
  const legacyUnverifiable = auth.user.password_iterations <= 0 || auth.user.password_iterations > MAX_PASSWORD_ITERATIONS;
  const stepUpProven = auth.authMethod === "magic_link" || auth.authMethod === "oauth";
  if (!establishingFirstPassword && !(legacyUnverifiable && stepUpProven)) {
    const candidate = await passwordHash(
      currentPassword,
      auth.user.password_salt,
      auth.user.password_iterations
    );
    if (!constantTimeEqual(candidate, auth.user.password_hash)) {
      throw new HttpError(401, "UNAUTHENTICATED", "Current password is incorrect.");
    }
  }
  const salt = base64Url(randomBytes(18));
  const iterations = passwordIterations(env);
  const hash = await passwordHash(newPassword, salt, iterations);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.users}
          SET password_hash = ?1, password_salt = ?2,
              password_iterations = ?3, password_enabled = 1, updated_at = ?4
        WHERE app_id = ?5 AND id = ?6`
    ).bind(hash, salt, iterations, now(), currentAppId, auth.user.id),
    env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.sessions}
        WHERE app_id = ?1 AND user_id = ?2 AND token_hash != ?3`
    ).bind(currentAppId, auth.user.id, auth.tokenHash)
  ]);
  return new Response(null, { status: 204 });
}
async function resetUserPassword(env, currentAppId, userId, newPassword) {
  if (newPassword.length < 10 || newPassword.length > 1024) {
    throw new ArmadilloFunctionError(422, "VALIDATION_ERROR", "Password input is invalid.", {
      newPassword: "Use between 10 and 1,024 characters"
    });
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(currentAppId, userId).first();
  if (!existing) throw new ArmadilloFunctionError(404, "NOT_FOUND", "User not found.");
  const salt = base64Url(randomBytes(18));
  const iterations = passwordIterations(env);
  const hash = await passwordHash(newPassword, salt, iterations);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.users}
          SET password_hash = ?1, password_salt = ?2,
              password_iterations = ?3, password_enabled = 1, updated_at = ?4
        WHERE app_id = ?5 AND id = ?6`
    ).bind(hash, salt, iterations, now(), currentAppId, userId),
    env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?1 AND user_id = ?2`
    ).bind(currentAppId, userId)
  ]);
}
async function renameUser(env, currentAppId, userId, name) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new ArmadilloFunctionError(422, "VALIDATION_ERROR", "Name input is invalid.", {
      name: "Use between 1 and 120 characters"
    });
  }
  const updated = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.users} SET name = ?1, updated_at = ?2 WHERE app_id = ?3 AND id = ?4`
  ).bind(trimmed, now(), currentAppId, userId).run();
  if (!updated.meta.changes) throw new ArmadilloFunctionError(404, "NOT_FOUND", "User not found.");
  return { name: trimmed };
}
async function createUserForAdministration(env, currentAppId, input) {
  const validated = authInput(input, true);
  const timestamp = now();
  const userId = makeId("user");
  const salt = base64Url(randomBytes(18));
  const iterations = passwordIterations(env);
  const hash = await passwordHash(validated.password, salt, iterations);
  try {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.users}
         (app_id, id, email, name, password_hash, password_salt, password_iterations,
          password_enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`
    ).bind(currentAppId, userId, validated.email, validated.name, hash, salt, iterations, timestamp).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new ArmadilloFunctionError(409, "CONFLICT", "A user with that email already exists.");
    }
    throw error;
  }
  return { id: userId, email: validated.email, name: validated.name };
}
export {
  MIN_ADMINISTRATIVE_SECRET_LENGTH,
  assertAdministrativeSecretStrength,
  assertOwnedProfileFiles,
  bootstrapSecretMatches,
  changePassword,
  configuredBootstrapSecret,
  createUserForAdministration,
  declaredUserFields,
  enforceRateLimit,
  externalAuth,
  externalAuthProvider,
  logIn,
  optionalAuth,
  profileJsonForCreate,
  renameUser,
  requireAdminKey,
  requireAuth,
  requireUserSession,
  resetUserPassword,
  safeRedirect,
  signUp
};
