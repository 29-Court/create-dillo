import {} from "./environment.js";
import { ArmadilloFunctionError } from "../backend.js";
import {} from "./environment.js";
import { ARMADILLO_VERSION } from "./environment.js";
import { isObject } from "./helpers/json.js";
function sourceFingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
const DEFAULT_PASSWORD_ITERATIONS = 1e5;
const MAX_PASSWORD_ITERATIONS = 1e5;
const MIN_PASSWORD_ITERATIONS = 1e4;
const DEFAULT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1e3;
const DEFAULT_MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1e3;
const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const DIRECT_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
import { ROLE } from "../access.js";
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,95}$/;
const RESERVED_FIELDS = /* @__PURE__ */ new Set([
  "id",
  "ownerId",
  "createdAt",
  "updatedAt",
  "update",
  "delete",
  "toJSON",
  "__proto__",
  "prototype",
  "constructor"
]);
const encoder = new TextEncoder();
function configuredInteger(value, fallback, minimum, maximum) {
  if (value === void 0 || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}
function passwordIterations(env) {
  return configuredInteger(
    env.ARMADILLO_PASSWORD_ITERATIONS,
    DEFAULT_PASSWORD_ITERATIONS,
    MIN_PASSWORD_ITERATIONS,
    MAX_PASSWORD_ITERATIONS
  );
}
function sessionLifetimeMs(env) {
  return configuredInteger(env.ARMADILLO_SESSION_TTL_SECONDS, DEFAULT_SESSION_LIFETIME_MS / 1e3, 300, 31536e3) * 1e3;
}
function magicLinkLifetimeMs(env) {
  return configuredInteger(env.ARMADILLO_MAGIC_LINK_TTL_SECONDS, DEFAULT_MAGIC_LINK_LIFETIME_MS / 1e3, 60, 3600) * 1e3;
}
function maxJsonBytes(env) {
  return configuredInteger(env.ARMADILLO_MAX_JSON_BYTES, DEFAULT_MAX_JSON_BYTES, 1024, 10 * 1024 * 1024);
}
function maxFileBytes(env) {
  return configuredInteger(env.ARMADILLO_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES, 1024, 5 * 1024 * 1024 * 1024);
}
class HttpError extends ArmadilloFunctionError {
  constructor(status, code, message, fields, hint) {
    super(status, code, message, fields, hint);
    this.name = "HttpError";
  }
}
function json(data, status = 200) {
  return Response.json(data, { status });
}
function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const configured = env.CORS_ORIGIN?.trim() || "*";
  if (configured === "*") return "*";
  const allowed = configured.split(",").map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}
function assertOrigin(request, env) {
  if (request.headers.has("origin") && allowedOrigin(request, env) === null) {
    throw new HttpError(403, "FORBIDDEN", "Origin is not allowed.");
  }
  const cookieAuthority = !request.headers.has("authorization") && (request.headers.has("cookie") || request.headers.get("x-armadillo-auth-mode") === "cookie");
  const sensitive = !["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (cookieAuthority && sensitive) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin && allowedOrigin(request, env) === "*") {
      throw new HttpError(403, "FORBIDDEN", "Cookie authentication requires an explicitly allowed origin.");
    }
    if (!origin && request.headers.get("sec-fetch-site") === "cross-site") {
      throw new HttpError(403, "FORBIDDEN", "Cross-site cookie requests require an allowed origin.");
    }
  }
}
function finish(response, request, env, requestId) {
  if (response.status === 101) return response;
  const output = new Response(response.body, response);
  const origin = allowedOrigin(request, env);
  if (origin) output.headers.set("access-control-allow-origin", origin);
  if (origin && origin !== "*") output.headers.set("access-control-allow-credentials", "true");
  if (origin !== "*") output.headers.append("vary", "Origin");
  output.headers.set("x-content-type-options", "nosniff");
  output.headers.set("referrer-policy", "no-referrer");
  output.headers.set("x-armadillo-version", ARMADILLO_VERSION);
  output.headers.set("x-request-id", requestId);
  if (new URL(request.url).pathname.startsWith("/v1/") && !output.headers.has("cache-control")) {
    output.headers.set("cache-control", "private, no-store");
  }
  return output;
}
function clientConfigSource(request, env, source) {
  const url = new URL(request.url);
  const config = JSON.stringify({
    url: url.origin,
    stage: env.ARMADILLO_STAGE?.trim() || "unknown",
    // The backend namespace is public routing metadata, not a client-app
    // credential. Supplying it makes `Armadillo()` work in same-origin ESM
    // pages as well as plain `<script>` pages.
    ...env.ARMADILLO_APP_ID?.trim() ? { appId: env.ARMADILLO_APP_ID.trim() } : {}
  }).replaceAll("<", "\\u003c");
  return `globalThis.__ARMADILLO__ = Object.freeze({ ...(globalThis.__ARMADILLO__ ?? {}), ...${config} });
${source}`;
}
function clientEtag(kind, source, env) {
  const publicIdentity = JSON.stringify({
    stage: env.ARMADILLO_STAGE?.trim() || "unknown",
    appId: env.ARMADILLO_APP_ID?.trim() || ""
  });
  return `W/"armadillo-client-${kind}-${ARMADILLO_VERSION}-${sourceFingerprint(`${source}
${publicIdentity}`)}"`;
}
function preflight(request, env) {
  assertOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-armadillo-auth-mode, x-armadillo-app-id, x-armadillo-client-app-id, x-armadillo-client-key, x-armadillo-file-name, x-armadillo-admin-key, x-armadillo-bootstrap-secret",
      "access-control-max-age": "86400"
    }
  });
}
const INTERNAL_CONFLICT_COLUMNS = /* @__PURE__ */ new Set([
  "app_id",
  "id",
  "user_id",
  "owner_id",
  "group_id",
  "session_id",
  "storage_key",
  "password_hash",
  "password_salt",
  "token_hash",
  "key_hash",
  "code_hash",
  "recipient_hash",
  "collection",
  "created_at",
  "updated_at",
  "expires_at",
  "email",
  "profile",
  "scopes",
  "consumed_at",
  "consumed_by_session"
]);
function uniqueConflictFields(error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = /unique constraint failed: ([^\n]+)/i.exec(message)?.[1];
  if (!detail) return void 0;
  const fields = {};
  for (const part of detail.split(",")) {
    const column = part.trim().split(".").pop() ?? "";
    if (!FIELD.test(column) || INTERNAL_CONFLICT_COLUMNS.has(column)) continue;
    fields[column] = "Already in use";
  }
  return Object.keys(fields).length > 0 ? fields : void 0;
}
function errorResponse(error, requestId) {
  if (error instanceof ArmadilloFunctionError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        ...error.fields ? { fields: error.fields } : {},
        ...error.hint ? { hint: error.hint } : {},
        requestId
      }
    };
    const response = json(body, error.status);
    const retryAfter = error.fields?.retryAfter;
    if (typeof retryAfter === "string" && /^\d+$/.test(retryAfter)) {
      const output = new Response(response.body, response);
      output.headers.set("retry-after", retryAfter);
      return output;
    }
    return response;
  }
  if (isObject(error) && typeof error.status === "number" && typeof error.code === "string" && typeof error.message === "string" && [
    "BAD_REQUEST",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "STRUCTURE_DISCOVERY_DISABLED",
    "CONFLICT",
    "VALIDATION_ERROR",
    "RATE_LIMITED",
    "INTERNAL_ERROR"
  ].includes(error.code)) {
    return json({
      error: { code: error.code, message: error.message, requestId }
    }, error.status);
  }
  const uniqueFields = uniqueConflictFields(error);
  if (uniqueFields || /unique constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
    return json({
      error: {
        code: "CONFLICT",
        message: "A unique value is already in use.",
        ...uniqueFields ? { fields: uniqueFields } : {},
        requestId
      }
    }, 409);
  }
  console.error("Armadillo request failed", requestId, error);
  return json({
    error: {
      code: "INTERNAL_ERROR",
      message: "The backend could not complete the request.",
      requestId
    }
  }, 500);
}
export {
  DEFAULT_MAGIC_LINK_LIFETIME_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_JSON_BYTES,
  DEFAULT_PASSWORD_ITERATIONS,
  DEFAULT_SESSION_LIFETIME_MS,
  DIRECT_UPLOAD_LIMIT_BYTES,
  EVENT_TYPE,
  FIELD,
  HttpError,
  MAX_PASSWORD_ITERATIONS,
  MIN_PASSWORD_ITERATIONS,
  NAME,
  RESERVED_FIELDS,
  ROLE,
  allowedOrigin,
  assertOrigin,
  clientConfigSource,
  clientEtag,
  configuredInteger,
  encoder,
  errorResponse,
  finish,
  json,
  magicLinkLifetimeMs,
  maxFileBytes,
  maxJsonBytes,
  passwordIterations,
  preflight,
  sessionLifetimeMs,
  sourceFingerprint
};
