import { type ArmadilloEnv } from "./environment.js";
import { ArmadilloFunctionError } from "../backend.js";
import { type ErrorCode } from "./environment.js";
import { ARMADILLO_VERSION } from "./environment.js";
import { isObject } from "./helpers/json.js";

export function sourceFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const DEFAULT_PASSWORD_ITERATIONS = 100_000;

export const MAX_PASSWORD_ITERATIONS = 100_000;
export const MIN_PASSWORD_ITERATIONS = 10_000;

export const DEFAULT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export const DEFAULT_MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1_000;

export const DEFAULT_MAX_JSON_BYTES = 256 * 1_024;

export const DEFAULT_MAX_FILE_BYTES = 5 * 1_024 * 1_024 * 1_024;

export const DIRECT_UPLOAD_LIMIT_BYTES = 100 * 1_024 * 1_024;

export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

export const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export { ROLE } from "../access.js";

export const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,95}$/;

export const RESERVED_FIELDS = new Set([
  "id",
  "ownerId",
  "createdAt",
  "updatedAt",
  "update",
  "delete",
  "toJSON",
  "__proto__",
  "prototype",
  "constructor",
]);

export const encoder = new TextEncoder();

export function configuredInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function passwordIterations(env: ArmadilloEnv): number {
  // `min` used to equal the default, which meant the only value the parser could
  // ever accept was the literal default: `ARMADILLO_PASSWORD_ITERATIONS=600000`
  // was silently ignored. 100 000 is the Workers WebCrypto ceiling for
  // PBKDF2-SHA256, so that remains the maximum; the floor is a lower bound.
  return configuredInteger(
    env.ARMADILLO_PASSWORD_ITERATIONS,
    DEFAULT_PASSWORD_ITERATIONS,
    MIN_PASSWORD_ITERATIONS,
    MAX_PASSWORD_ITERATIONS,
  );
}

export function sessionLifetimeMs(env: ArmadilloEnv): number {
  return configuredInteger(env.ARMADILLO_SESSION_TTL_SECONDS, DEFAULT_SESSION_LIFETIME_MS / 1_000, 300, 31_536_000) * 1_000;
}

export function magicLinkLifetimeMs(env: ArmadilloEnv): number {
  return configuredInteger(env.ARMADILLO_MAGIC_LINK_TTL_SECONDS, DEFAULT_MAGIC_LINK_LIFETIME_MS / 1_000, 60, 3_600) * 1_000;
}

export function maxJsonBytes(env: ArmadilloEnv): number {
  return configuredInteger(env.ARMADILLO_MAX_JSON_BYTES, DEFAULT_MAX_JSON_BYTES, 1_024, 10 * 1_024 * 1_024);
}

export function maxFileBytes(env: ArmadilloEnv): number {
  return configuredInteger(env.ARMADILLO_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES, 1_024, 5 * 1_024 * 1_024 * 1_024);
}

export class HttpError extends ArmadilloFunctionError {
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    fields?: Record<string, string>,
    hint?: string,
  ) {
    super(status, code, message, fields, hint);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function allowedOrigin(request: Request, env: ArmadilloEnv): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const configured = env.CORS_ORIGIN?.trim() || "*";
  if (configured === "*") return "*";
  const allowed = configured.split(",").map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

export function assertOrigin(request: Request, env: ArmadilloEnv): void {
  if (request.headers.has("origin") && allowedOrigin(request, env) === null) {
    throw new HttpError(403, "FORBIDDEN", "Origin is not allowed.");
  }
  // Wildcard CORS permits public/token clients, not ambient cookie authority.
  // SameSite alone is insufficient against an untrusted sibling subdomain.
  const cookieAuthority = !request.headers.has("authorization")
    && (request.headers.has("cookie") || request.headers.get("x-armadillo-auth-mode") === "cookie");
  const sensitive = !["GET", "HEAD", "OPTIONS"].includes(request.method)
    || request.headers.get("upgrade")?.toLowerCase() === "websocket";
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

export function finish(response: Response, request: Request, env: ArmadilloEnv, requestId: string): Response {
  // Cloning a Cloudflare 101 response drops its non-standard `webSocket`
  // attachment, so an accepted upgrade must pass through unchanged.
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

export function clientConfigSource(request: Request, env: ArmadilloEnv, source: string): string {
  const url = new URL(request.url);
  // This is deliberately a tiny public-only bootstrap. Runtime values, API
  // keys, and provider credentials never cross this boundary.
  const config = JSON.stringify({
    url: url.origin,
    stage: env.ARMADILLO_STAGE?.trim() || "unknown",
    // The backend namespace is public routing metadata, not a client-app
    // credential. Supplying it makes `Armadillo()` work in same-origin ESM
    // pages as well as plain `<script>` pages.
    ...(env.ARMADILLO_APP_ID?.trim() ? { appId: env.ARMADILLO_APP_ID.trim() } : {}),
  }).replaceAll("<", "\\u003c");
  return `globalThis.__ARMADILLO__ = Object.freeze({ ...(globalThis.__ARMADILLO__ ?? {}), ...${config} });\n${source}`;
}

export function clientEtag(kind: "module" | "script", source: string, env: ArmadilloEnv): string {
  // The served source includes stage and appId. Cache validation must follow
  // those public values too, otherwise a browser can retain a module from a
  // prior deployment and send requests to the wrong backend namespace.
  const publicIdentity = JSON.stringify({
    stage: env.ARMADILLO_STAGE?.trim() || "unknown",
    appId: env.ARMADILLO_APP_ID?.trim() || "",
  });
  return `W/"armadillo-client-${kind}-${ARMADILLO_VERSION}-${sourceFingerprint(`${source}\n${publicIdentity}`)}"`;
}

export function preflight(request: Request, env: ArmadilloEnv): Response {
  assertOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-armadillo-auth-mode, x-armadillo-app-id, x-armadillo-client-app-id, x-armadillo-client-key, x-armadillo-file-name, x-armadillo-admin-key, x-armadillo-bootstrap-secret",
      "access-control-max-age": "86400",
    },
  });
}

/**
 * Column names from a SQLite unique failure.
 *
 * Internal table and column names stay out of the response: `password_hash`,
 * `token_hash`, `key_hash`, and `storage_key` are not columns the caller wrote,
 * and naming them tells an anonymous caller which internal table collided.
 */
const INTERNAL_CONFLICT_COLUMNS = new Set([
  "app_id", "id", "user_id", "owner_id", "group_id", "session_id", "storage_key",
  "password_hash", "password_salt", "token_hash", "key_hash", "code_hash",
  "recipient_hash", "collection", "created_at", "updated_at", "expires_at",
  "email", "profile", "scopes", "consumed_at", "consumed_by_session",
]);

function uniqueConflictFields(error: unknown): Record<string, string> | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const detail = /unique constraint failed: ([^\n]+)/i.exec(message)?.[1];
  if (!detail) return undefined;
  const fields: Record<string, string> = {};
  for (const part of detail.split(",")) {
    const column = part.trim().split(".").pop() ?? "";
    if (!FIELD.test(column) || INTERNAL_CONFLICT_COLUMNS.has(column)) continue;
    fields[column] = "Already in use";
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ArmadilloFunctionError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.hint ? { hint: error.hint } : {}),
        requestId,
      },
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
  if (isObject(error)
    && typeof error.status === "number"
    && typeof error.code === "string"
    && typeof error.message === "string"
    && ["BAD_REQUEST", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "STRUCTURE_DISCOVERY_DISABLED", "CONFLICT",
      "VALIDATION_ERROR", "RATE_LIMITED", "INTERNAL_ERROR"].includes(error.code)) {
    return json({
      error: { code: error.code, message: error.message, requestId },
    }, error.status);
  }
  const uniqueFields = uniqueConflictFields(error);
  if (uniqueFields || /unique constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
    return json({
      error: {
        code: "CONFLICT",
        message: "A unique value is already in use.",
        ...(uniqueFields ? { fields: uniqueFields } : {}),
        requestId,
      },
    }, 409);
  }
  console.error("Armadillo request failed", requestId, error);
  return json({
    error: {
      code: "INTERNAL_ERROR",
      message: "The backend could not complete the request.",
      requestId,
    },
  }, 500);
}
