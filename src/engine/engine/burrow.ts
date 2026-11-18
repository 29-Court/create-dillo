import { DATABASE_MIGRATION_VERSION } from "../migrations.js";
import { INTERNAL_TABLES } from "../backend.js";
import type { ArmadilloBackendDefinition } from "../backend.js";
import type { AuthContext } from "./environment.js";
import type { ArmadilloEnv } from "./environment.js";
import { HttpError } from "./http.js";
import { json } from "./http.js";
import { sha256 } from "./helpers/crypto.js";
import { base64Url } from "./helpers/id.js";
import { makeId } from "./helpers/id.js";
import { randomBytes } from "./helpers/id.js";
import { isObject } from "./helpers/json.js";
import { readJson } from "./validation.js";
import { now } from "./records.js";
import { passwordHash } from "./helpers/crypto.js";
import { passwordIterations } from "./http.js";
import { sessionLifetimeMs } from "./http.js";
import { authInput } from "./auth.js";
import { bootstrapSecretMatches } from "./auth.js";
import { configuredBootstrapSecret } from "./auth.js";
import { enforceRateLimit } from "./auth.js";
import { requireUserSession } from "./auth.js";
import { cookieValue } from "./sessions.js";
import { createSessionToken } from "./sessions.js";
import { sessionCookieName } from "./sessions.js";
import { sessionResponse } from "./sessions.js";
import { applicationOrigin } from "./oauth.js";
import { verifySignIn } from "./oauth.js";
import { resolveRequirements } from "../requirements.js";
import { signInProviders } from "../requirements.js";
import type { RuntimeRequirement } from "../requirements.js";
import { describeAccess } from "../access.js";
import { previewRecordAccess } from "./permissions.js";
import { recordAuditJson } from "./record-audit.js";
import { type InternalRecordAuditRow } from "./record-audit.js";
import { type BindValue } from "./environment.js";
import {
  burrowWebhooksRoute,
  webhookEndpointRollups,
  webhookQuarantineWindow,
} from "./burrow-webhooks.js";
import { burrowUsageRoute } from "./burrow-usage.js";
import { burrowSchedulesRoute, scheduleReportStrip } from "./burrow-schedules.js";
import { usageTodaySummary } from "./usage.js";

const SETUP_TTL_MS = 15 * 60 * 1_000;
// The Burrow report stays a bounded view. Each capped list reports the window
// it was drawn from so a cut-off list can never read as a complete one.
const USERS_WINDOW = 200;
const AGENTS_WINDOW = 100;
const AUDIT_WINDOW = 50;
const RECORD_AUDIT_WINDOW = 50;
const COLLECTION = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RECORD_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

interface Installation {
  user_id: string;
  group_id: string;
  used_at: string;
  schema_version: string | null;
}

function setupCookieName(appId: string): string {
  return `armadillo_setup_${appId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function setupCookie(request: Request, appId: string, token: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${setupCookieName(appId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSetupCookie(request: Request, appId: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${setupCookieName(appId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

async function installation(env: ArmadilloEnv, appId: string): Promise<Installation | null> {
  return env.DB.prepare(
    `SELECT user_id, group_id, used_at, schema_version
       FROM ${INTERNAL_TABLES.bootstrap} WHERE app_id = ?1 LIMIT 1`,
  ).bind(appId).first<Installation>();
}

async function setupIsValid(request: Request, env: ArmadilloEnv, appId: string): Promise<boolean> {
  const token = cookieValue(request, setupCookieName(appId));
  if (!token || token.length > 1_024) return false;
  const row = await env.DB.prepare(
    `SELECT token_hash FROM ${INTERNAL_TABLES.bootstrapSessions}
      WHERE app_id = ?1 AND token_hash = ?2 AND expires_at > ?3 LIMIT 1`,
  ).bind(appId, await sha256(token), now()).first<{ token_hash: string }>();
  return Boolean(row);
}

function hasUserCredential(request: Request, appId: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (/^Bearer\s+\S+/i.test(header)) return true;
  return Boolean(cookieValue(request, sessionCookieName(appId)));
}

async function isOperator(env: ArmadilloEnv, appId: string, auth: AuthContext, row: Installation): Promise<boolean> {
  if (row.user_id === auth.user.id) return true;
  const member = await env.DB.prepare(
    `SELECT role FROM ${INTERNAL_TABLES.groupMembers}
      WHERE app_id = ?1 AND group_id = ?2 AND user_id = ?3 LIMIT 1`,
  ).bind(appId, row.group_id, auth.user.id).first<{ role: string }>();
  return Boolean(member && (member.role === "owner" || member.role === "admin"));
}

export async function requireOperator(request: Request, env: ArmadilloEnv, appId: string): Promise<{ auth: AuthContext; row: Installation }> {
  const auth = await requireUserSession(request, env, appId);
  // An external auth identity is a `user` principal, so `requireUserSession`
  // alone let any externally-authenticated identity holding an admin seat reach
  // Burrow — which lists every account's email and API-key prefix and can inject
  // OAuth secrets. Operator authority has to be an Armadillo-held credential.
  if (auth.external) {
    throw new HttpError(403, "FORBIDDEN", "Burrow requires an Armadillo user session.");
  }
  const row = await installation(env, appId);
  if (!row) throw new HttpError(409, "CONFLICT", "Finish setup before using Burrow.");
  if (!await isOperator(env, appId, auth, row)) {
    throw new HttpError(403, "FORBIDDEN", "Burrow is limited to the application owner.");
  }
  return { auth, row };
}

async function infrastructure(env: ArmadilloEnv, appId: string, definition: ArmadilloBackendDefinition): Promise<{
  deployment: true;
  database: boolean;
  files: boolean;
  schema: "current" | "missing" | "drift";
  appliedAt: string | null;
}> {
  let database = false;
  try {
    const probe = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    database = probe?.ok === 1;
  } catch {
    database = false;
  }
  let schema: "current" | "missing" | "drift" = "current";
  let appliedAt: string | null = null;
  if (definition.schema) {
    const expected = await sha256(JSON.stringify(definition.schema.normalized));
    const row = await env.DB.prepare(
      `SELECT checksum, applied_at FROM ${INTERNAL_TABLES.schemaState} WHERE app_id = ?1 LIMIT 1`,
    ).bind(appId).first<{ checksum: string; applied_at: string }>();
    appliedAt = row?.applied_at ?? null;
    schema = !row ? "missing" : row.checksum === expected ? "current" : "drift";
  }
  return {
    deployment: true,
    database,
    files: env.resources ? Boolean(env.resources.files) : typeof env.FILES?.put === "function",
    schema,
    appliedAt,
  };
}

function presentRequirements(requirements: readonly RuntimeRequirement[], request: Request, env: ArmadilloEnv) {
  const origin = applicationOrigin(request, env);
  return requirements.map((requirement) => ({
    id: requirement.id,
    title: requirement.title,
    kind: requirement.kind,
    ...(requirement.callbackPath ? { callbackUrl: new URL(requirement.callbackPath, `${origin}/`).toString() } : {}),
    fields: requirement.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      configured: field.configured,
    })),
  }));
}

function missingMessage(title: string, field: { label: string; type: string }): string {
  if (field.type === "secret" && /secret/i.test(field.label)) return `${title} is missing a client secret`;
  if (field.type === "config" && /client id/i.test(field.label)) return `${title} is missing a client id`;
  if (/api key/i.test(field.label)) return `${title} is missing an API key`;
  return `${title} is missing ${field.label}`;
}

async function audit(env: ArmadilloEnv, appId: string, actorId: string, action: string, subject: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.audit}
       (app_id, id, actor_id, action, subject, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(appId, makeId("audit"), actorId, action, subject, now()).run();
}

async function exchange(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<Response> {
  await enforceRateLimit(request, env, appId, "burrow-bootstrap", 10, 60 * 60);
  // Check installation first: setup state is already public (see status), so
  // rejecting here leaks nothing — while a wrong-secret 403 on an initialized
  // backend would oracle the bootstrap secret.
  if (await installation(env, appId)) throw new HttpError(409, "CONFLICT", "Setup already finished.");
  const body = await readJson(request, env);
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!await bootstrapSecretMatches(env, secret)) {
    throw new HttpError(403, "FORBIDDEN", "The bootstrap secret is invalid or unavailable.");
  }
  const token = `arm_setup_${base64Url(randomBytes(32))}`;
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.bootstrapSessions}
       (app_id, token_hash, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(appId, await sha256(token), expiresAt, now()).run();
  return new Response(JSON.stringify({ ok: true, expiresAt }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": setupCookie(request, appId, token, expiresAt),
    },
  });
}

async function createOwner(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<Response> {
  if (await installation(env, appId)) throw new HttpError(409, "CONFLICT", "Setup already finished.");
  if (!await setupIsValid(request, env, appId)) {
    throw new HttpError(401, "UNAUTHENTICATED", "Verify bootstrap access before creating the owner.");
  }
  await enforceRateLimit(request, env, appId, "burrow-owner", 5, 60 * 60);
  const body = await readJson(request, env);
  const input = authInput(body, true);
  if (!input.name) {
    throw new HttpError(422, "VALIDATION_ERROR", "Authentication input is invalid.", {
      name: "Enter the owner's name",
    });
  }
  const groupSlug = env.ARMADILLO_SUPERADMIN_GROUP?.trim() || "armadillo-superadmins";
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(groupSlug)) {
    throw new HttpError(500, "INTERNAL_ERROR", "ARMADILLO_SUPERADMIN_GROUP is invalid.");
  }
  const timestamp = now();
  const userId = makeId("user");
  const groupId = makeId("group");
  const salt = base64Url(randomBytes(18));
  const iterations = passwordIterations(env);
  const hash = await passwordHash(input.password, salt, iterations);
  const sessionToken = createSessionToken();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.users}
           (app_id, id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`,
      ).bind(appId, userId, input.email, input.name, hash, salt, iterations, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.groups}
           (app_id, id, name, slug, trusted, created_by, created_at)
         VALUES (?1, ?2, 'Owners', ?3, 1, ?4, ?5)`,
      ).bind(appId, groupId, groupSlug, userId, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.groupMembers}
           (app_id, group_id, user_id, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'owner', ?4, ?4)`,
      ).bind(appId, groupId, userId, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.sessions}
           (app_id, id, token_hash, user_id, created_at, expires_at, auth_method)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'password')`,
      ).bind(appId, makeId("session"), await sha256(sessionToken), userId, timestamp, expiresAt),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.bootstrap}
           (app_id, secret_hash, user_id, group_id, used_at, schema_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(appId, await sha256(configuredBootstrapSecret(env)), userId, groupId, timestamp, DATABASE_MIGRATION_VERSION),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.audit}
           (app_id, id, actor_id, action, subject, created_at)
         VALUES (?1, ?2, ?3, 'burrow.owner_created', 'owner', ?4)`,
      ).bind(appId, makeId("audit"), userId, timestamp),
      env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.bootstrapSessions} WHERE app_id = ?1`,
      ).bind(appId),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new HttpError(409, "CONFLICT", "Setup already finished, or an account with that email already exists.");
    }
    throw error;
  }
  const response = sessionResponse(request, appId, {
    id: userId,
    email: input.email,
    name: input.name,
    createdAt: timestamp,
    updatedAt: timestamp,
  }, sessionToken, expiresAt, 201, { group: { id: groupId, slug: groupSlug, role: "owner", title: "Application owner" } }, env);
  return withCookie(response, clearSetupCookie(request, appId));
}

interface BurrowWindow {
  returned: number;
  total: number;
  truncated: boolean;
}

/**
 * Describe a capped list. `total` counts every row the same filter would match,
 * so a window whose `total` exceeds its cap is the signal that rows were cut.
 */
function windowOf(rows: { results?: unknown[] } | null | undefined, total: number): BurrowWindow {
  const returned = rows?.results?.length ?? 0;
  return { returned, total, truncated: total > returned };
}

async function countWhere(env: ArmadilloEnv, sql: string, ...values: BindValue[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...values).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function report(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  auth: AuthContext,
  row: Installation,
): Promise<Response> {
  const health = await infrastructure(env, appId, definition);
  const requirements = presentRequirements(resolveRequirements(definition, env), request, env);
  const issues: { level: "warning" | "error"; message: string }[] = [];
  if (!health.database) issues.push({ level: "error", message: "Database is not responding." });
  if (definition.files !== false && !health.files) issues.push({ level: "warning", message: "File storage is not available." });
  if (health.schema === "drift") issues.push({ level: "warning", message: "Schema does not match this deployment." });
  if (health.schema === "missing") issues.push({ level: "warning", message: "Schema has not been applied." });
  for (const requirement of requirements) {
    for (const field of requirement.fields) {
      if (!field.required || field.configured) continue;
      issues.push({ level: "warning", message: missingMessage(requirement.title, field) });
    }
  }
  const counts = new Map<string, number>();
  for (const name of Object.keys(definition.schema?.normalized.tables ?? {})) counts.set(name, 0);
  const counted = await env.DB.prepare(
    `SELECT collection, COUNT(*) AS records FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ?1 GROUP BY collection`,
  ).bind(appId).all<{ collection: string; records: number }>();
  for (const item of counted.results ?? []) counts.set(item.collection, Number(item.records));
  const files = await env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
       FROM ${INTERNAL_TABLES.files} WHERE app_id = ?1`,
  ).bind(appId).first<{ count: number; bytes: number }>();
  let bytes: number | null = null;
  try {
    const size = await env.DB.prepare(
      "SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes",
    ).first<{ bytes: number }>();
    if (typeof size?.bytes === "number") bytes = size.bytes;
  } catch {
    bytes = null;
  }
  let migrations: { name: string; appliedAt: string }[] = [];
  try {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_armadillo_local_migrations'",
    ).first<{ name: string }>();
    if (table) {
      const history = await env.DB.prepare(
        "SELECT name, applied_at FROM _armadillo_local_migrations ORDER BY name ASC",
      ).all<{ name: string; applied_at: string }>();
      migrations = (history.results ?? []).map((item) => ({ name: item.name, appliedAt: item.applied_at }));
    }
  } catch {
    migrations = [];
  }
  const users = await env.DB.prepare(
    `SELECT id, email, name FROM ${INTERNAL_TABLES.users}
      WHERE app_id = ?1 ORDER BY created_at ASC LIMIT ${USERS_WINDOW}`,
  ).bind(appId).all<{ id: string; email: string; name: string | null }>();
  const usersTotal = await countWhere(
    env, `SELECT COUNT(*) AS total FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1`, appId,
  );
  const groups = await env.DB.prepare(
    `SELECT g.id, g.name, g.slug, g.trusted,
            (SELECT COUNT(*) FROM ${INTERNAL_TABLES.groupMembers} AS m
              WHERE m.app_id = g.app_id AND m.group_id = g.id) AS members
       FROM ${INTERNAL_TABLES.groups} AS g
      WHERE g.app_id = ?1
      ORDER BY g.name ASC`,
  ).bind(appId).all<{ id: string; name: string; slug: string; trusted: number; members: number }>();
  const keys = await env.DB.prepare(
    `SELECT id, name, key_prefix, owner_id, scopes, created_at, expires_at, revoked_at, grace_expires_at
       FROM ${INTERNAL_TABLES.apiKeys}
      WHERE app_id = ?1 ORDER BY created_at DESC LIMIT ${AGENTS_WINDOW}`,
  ).bind(appId).all<{
    id: string; name: string; key_prefix: string; owner_id: string; scopes: string;
    created_at: string; expires_at: string | null; revoked_at: string | null;
    grace_expires_at: string | null;
  }>();
  const agentsTotal = await countWhere(
    env, `SELECT COUNT(*) AS total FROM ${INTERNAL_TABLES.apiKeys} WHERE app_id = ?1`, appId,
  );
  const events = await env.DB.prepare(
    `SELECT id, actor_id, action, subject, created_at FROM ${INTERNAL_TABLES.audit}
      WHERE app_id = ?1 ORDER BY created_at DESC LIMIT ${AUDIT_WINDOW}`,
  ).bind(appId).all<{ id: string; actor_id: string; action: string; subject: string; created_at: string }>();
  const auditTotal = await countWhere(
    env, `SELECT COUNT(*) AS total FROM ${INTERNAL_TABLES.audit} WHERE app_id = ?1`, appId,
  );
  const recordAuditRows = await env.DB.prepare(
    `SELECT id, table_name, record_id, action, actor_id, created_at FROM ${INTERNAL_TABLES.recordAudit}
      WHERE app_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ${RECORD_AUDIT_WINDOW}`,
  ).bind(appId).all<InternalRecordAuditRow>();
  const recordAuditTotal = await countWhere(
    env, `SELECT COUNT(*) AS total FROM ${INTERNAL_TABLES.recordAudit} WHERE app_id = ?1`, appId,
  );
  const policies = Object.entries(definition.schema?.normalized.tables ?? {}).map(([name, table]) => {
    const roles = [...new Set(["member", "editor", "admin", "owner", ...(table.team?.readRoles ?? []), ...(table.team?.writeRoles ?? [])])];
    const scenarios = [
      { label: "Signed out", authenticated: false, ownsRecord: false },
      { label: "Record creator", authenticated: true, ownsRecord: true, ...(table.team ? { role: "owner" } : {}) },
      { label: "Other user", authenticated: true, ownsRecord: false },
      { label: "Removed creator", authenticated: true, ownsRecord: true },
      ...roles.map(role => ({ label: `${role} member`, authenticated: true, ownsRecord: false, role })),
    ];
    return {
      name, view: describeAccess(table, "view"), edit: describeAccess(table, "edit"),
      teamField: table.team?.field ?? null,
      scenarios: scenarios.map(actor => ({
        label: actor.label,
        read: previewRecordAccess(table, "read", actor),
        edit: previewRecordAccess(table, "edit", actor),
        create: previewRecordAccess(table, "create", actor),
      })),
    };
  });
  const webhookEndpoints = await webhookEndpointRollups(env, appId, definition);
  const webhookQuarantine = await webhookQuarantineWindow(env, appId);
  const usage = await usageTodaySummary(env, appId, definition);
  const schedules = await scheduleReportStrip(env, appId, definition);
  return json({
    phase: "initialized",
    operator: {
      id: auth.user.id,
      name: auth.user.name,
      email: auth.user.email,
      title: row.user_id === auth.user.id ? "Application owner" : "Administrator",
    },
    infrastructure: {
      deployment: health.deployment,
      database: health.database,
      files: health.files,
      schema: health.schema,
    },
    issues,
    requirements,
    policies,
    database: {
      bytes,
      collections: [...counts].map(([name, records]) => ({ name, records })).sort((left, right) => left.name.localeCompare(right.name)),
    },
    files: { count: Number(files?.count ?? 0), bytes: Number(files?.bytes ?? 0) },
    deployment: {
      stage: env.ARMADILLO_STAGE?.trim() || "unknown",
      schemaVersion: row.schema_version ?? DATABASE_MIGRATION_VERSION,
      schema: health.schema,
      appliedAt: health.appliedAt ?? row.used_at,
      migrations,
    },
    users: (users.results ?? []).map((user) => ({ id: user.id, email: user.email, name: user.name })),
    usersWindow: windowOf(users, usersTotal),
    groups: (groups.results ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      slug: group.slug,
      trusted: group.trusted === 1,
      members: Number(group.members),
    })),
    agents: (keys.results ?? []).map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.key_prefix,
      ownerId: key.owner_id,
      scopes: parseScopes(key.scopes),
      createdAt: key.created_at,
      // A rotated key keeps revoked_at NULL through its grace window. Once the
      // grace has passed the key no longer authenticates, so the operator reads
      // the grace expiry as the revocation time. Same rule as apiKeyJson.
      revokedAt: key.revoked_at
        ?? (key.grace_expires_at && key.grace_expires_at <= now() ? key.grace_expires_at : null),
    })),
    agentsWindow: windowOf(keys, agentsTotal),
    audit: (events.results ?? []).map((event) => ({
      id: event.id,
      actorId: event.actor_id,
      action: event.action,
      subject: event.subject,
      createdAt: event.created_at,
    })),
    auditWindow: windowOf(events, auditTotal),
    recordAudit: (recordAuditRows.results ?? []).map(recordAuditJson),
    recordAuditWindow: windowOf(recordAuditRows, recordAuditTotal),
    webhooks: {
      endpoints: webhookEndpoints,
      quarantine: webhookQuarantine.jobs,
      quarantineWindow: webhookQuarantine.quarantineWindow,
    },
    usage,
    schedules,
  });
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    return [];
  }
  return [];
}

async function saveSecrets(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<Response> {
  const { auth } = await requireOperator(request, env, appId);
  const body = await readJson(request, env);
  if (!isObject(body.values)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Secret values must be an object.", { values: "Expected an object" });
  }
  const allowed = new Map(resolveRequirements(definition, env).flatMap((requirement) => requirement.fields.map((field) => [field.key, field])));
  const entries = Object.entries(body.values);
  if (entries.length === 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Paste at least one credential.");
  }
  for (const [key, value] of entries) {
    if (!allowed.has(key)) {
      throw new HttpError(422, "VALIDATION_ERROR", "That setting is not required by this application.", {
        [key]: "Unknown requirement",
      });
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(422, "VALIDATION_ERROR", "Credential values cannot be empty.", { [key]: "Enter a value" });
    }
  }
  const vault = env.ARMADILLO_SECRET_VAULT;
  if (!vault) {
    throw new HttpError(
      409,
      "CONFLICT",
      `This deployment keeps secrets in its platform environment. Set ${entries.map(([key]) => key).join(", ")} there, then refresh Burrow.`,
    );
  }
  for (const [key, value] of entries) {
    await vault.put(key, (value as string).trim());
    await audit(env, appId, auth.user.id, "burrow.secret_set", key);
  }
  const requirements = presentRequirements(resolveRequirements(definition, env), request, env);
  const verification = [];
  if (body.verify === true) {
    for (const provider of signInProviders(definition.auth)) {
      const ready = provider.requirements.every((field) => {
        const current = requirements.find((requirement) => requirement.id === provider.id);
        return current?.fields.find((item) => item.key === field.key)?.configured;
      });
      if (ready) verification.push(await verifySignIn(request, env, provider));
    }
  }
  return json({ requirements, ...(verification.length > 0 ? { verification } : {}) });
}

async function verify(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<Response> {
  await requireOperator(request, env, appId);
  const body = await readJson(request, env);
  const id = typeof body.id === "string" ? body.id : "";
  const provider = signInProviders(definition.auth).find((item) => item.id === id);
  if (!provider) throw new HttpError(404, "NOT_FOUND", "That sign-in method is not declared.");
  return json(await verifySignIn(request, env, provider));
}

async function records(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<Response> {
  const { auth } = await requireOperator(request, env, appId);
  const collection = new URL(request.url).searchParams.get("collection") ?? "";
  if (!COLLECTION.test(collection)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Choose a table to inspect.", { collection: "Invalid table" });
  }
  const rows = await env.DB.prepare(
    `SELECT id, owner_id, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
      WHERE app_id = ?1 AND collection = ?2
      ORDER BY created_at DESC LIMIT 50`,
  ).bind(appId, collection).all<{ id: string; owner_id: string; created_at: string; updated_at: string }>();
  await audit(env, appId, auth.user.id, "burrow.records_read", collection);
  return json({
    records: (rows.results ?? []).map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  });
}

async function recordAudit(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
): Promise<Response> {
  const { auth } = await requireOperator(request, env, appId);
  const params = new URL(request.url).searchParams;
  const collection = params.get("collection") ?? "";
  const recordId = params.get("recordId") ?? "";
  if (collection !== "" && !COLLECTION.test(collection)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Choose a table to inspect.", { collection: "Invalid table" });
  }
  if (recordId !== "" && !RECORD_ID.test(recordId)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Choose a record to inspect.", { recordId: "Invalid record" });
  }
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.get("limit") ?? "50", 10) || 50));
  const conditions = ["app_id = ?1"];
  const values: BindValue[] = [appId];
  if (collection !== "") {
    values.push(collection);
    conditions.push(`table_name = ?${values.length}`);
  }
  if (recordId !== "") {
    values.push(recordId);
    conditions.push(`record_id = ?${values.length}`);
  }
  const filters = values.slice();
  filters.push(limit);
  const rows = await env.DB.prepare(
    `SELECT id, table_name, record_id, action, actor_id, created_at
       FROM ${INTERNAL_TABLES.recordAudit}
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, rowid DESC LIMIT ?${filters.length}`,
  ).bind(...filters).all<InternalRecordAuditRow>();
  // Counted with the row filters but without the limit, so the window describes
  // the same slice the entries came from.
  const total = await countWhere(
    env,
    `SELECT COUNT(*) AS total FROM ${INTERNAL_TABLES.recordAudit} WHERE ${conditions.join(" AND ")}`,
    ...values,
  );
  await audit(env, appId, auth.user.id, "burrow.record_audit_read", collection || "all");
  return json({
    entries: (rows.results ?? []).map(recordAuditJson),
    recordAuditWindow: windowOf(rows, total),
  });
}

async function status(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
): Promise<Response> {
  const row = await installation(env, appId);
  if (hasUserCredential(request, appId)) {
    const auth = await requireUserSession(request, env, appId);
    if (!row || !await isOperator(env, appId, auth, row)) {
      throw new HttpError(403, "FORBIDDEN", "Burrow is limited to the application owner.");
    }
    return report(request, env, appId, definition, auth, row);
  }
  if (row) return json({ phase: "initialized" });
  const health = await infrastructure(env, appId, definition);
  if (await setupIsValid(request, env, appId)) return json({ phase: "bootstrapping", infrastructure: health });
  return json({ phase: "uninitialized", infrastructure: health });
}

export async function burrowRoute(
  request: Request,
  env: ArmadilloEnv,
  appId: string,
  definition: ArmadilloBackendDefinition,
  segments: readonly string[],
): Promise<Response> {
  const action = segments[2];
  if (!action && request.method === "GET") return status(request, env, appId, definition);
  if (action === "session" && request.method === "POST") return exchange(request, env, appId);
  if (action === "owner" && request.method === "POST") return createOwner(request, env, appId);
  if (action === "secrets" && request.method === "POST") return saveSecrets(request, env, appId, definition);
  if (action === "verify" && request.method === "POST") return verify(request, env, appId, definition);
  if (action === "records" && request.method === "GET") return records(request, env, appId);
  if (action === "record-audit" && request.method === "GET") return recordAudit(request, env, appId);
  if (action === "webhooks") return burrowWebhooksRoute(request, env, appId, definition, segments);
  if (action === "usage") return burrowUsageRoute(request, env, appId, definition, segments);
  if (action === "schedules") return burrowSchedulesRoute(request, env, appId, definition, segments);
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
