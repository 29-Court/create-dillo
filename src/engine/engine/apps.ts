import { NAME } from "./http.js";
import { HttpError } from "./http.js";
import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
import { type ArmadilloRegisteredApp } from "../backend.js";
import { requireAuth } from "./auth.js";
import { type JsonObject } from "../backend.js";
import { type JsonValue } from "../backend.js";
import { json } from "./http.js";
import { requireUserSession } from "./auth.js";
import { membershipsFor } from "./teams.js";

export function validName(value: string, label: string): string {
  if (!NAME.test(value)) {
    throw new HttpError(400, "BAD_REQUEST", `${label} is invalid.`);
  }
  return value;
}

/**
 * Resolve the tenant namespace for a request.
 *
 * The namespace scopes every auth query, session cookie name, and rate-limit
 * bucket, so it must never be chosen by an anonymous caller on a deployment
 * that has not opted into multi-tenancy. `x-armadillo-app-id` is honoured only
 * when the operator sets `ARMADILLO_ALLOW_CLIENT_APP_ID=1`; otherwise a
 * configured or default namespace wins and the header is ignored entirely.
 */
export function appId(
  request: Request,
  env: ArmadilloEnv,
  options: ArmadilloBackendDefinition = {},
): string {
  const configured = env.ARMADILLO_APP_ID?.trim();
  // When a registered app identity is supplied, `x-armadillo-client-app-id` is the
  // software identity and a configured namespace wins. This preserves the old
  // x-armadillo-app-id tenant header on backends that have not opted in while
  // letting external HTML use the ergonomic `appId: "door-checkin"` surface.
  const registered = Object.keys(options.apps ?? {}).length > 0;
  const multiTenant = registered || env.ARMADILLO_ALLOW_CLIENT_APP_ID === "1";
  const requested = registered && configured
    ? configured
    : multiTenant
      ? request.headers.get("x-armadillo-app-id")?.trim() || configured || "default"
      : configured || "default";
  validName(requested, "App ID");
  if (configured && requested !== configured) {
    throw new HttpError(403, "FORBIDDEN", "This backend does not serve that app ID.");
  }
  return requested;
}

export interface AppOperation {
  resource: string;
  action: string;
}

export function clientAppId(request: Request): string | undefined {
  const value = request.headers.get("x-armadillo-client-app-id")?.trim() ?? "";
  if (!value) return undefined;
  if (!NAME.test(value)) throw new HttpError(403, "FORBIDDEN", "Client app ID is invalid.");
  return value;
}

export function registeredAppFor(
  request: Request,
  options: ArmadilloBackendDefinition,
): ArmadilloRegisteredApp | undefined {
  if (Object.keys(options.apps ?? {}).length === 0) return undefined;
  const id = clientAppId(request);
  // Registration adds explicit policy. It must never be a prerequisite for a
  // normal URL + Armadillo client to use the backend.
  if (!id) return undefined;
  const direct = options.apps?.[id];
  const registration = direct?.id === id
    ? direct
    : Object.values(options.apps ?? {}).find((candidate) => candidate.id === id);
  if (!registration || registration.enabled === false) {
    throw new HttpError(403, "FORBIDDEN", "This client app is not registered or has been disabled.");
  }
  const configuredKey = registration.clientKey?.trim();
  if (configuredKey && request.headers.get("x-armadillo-client-key")?.trim() !== configuredKey) {
    throw new HttpError(403, "FORBIDDEN", "This client app deployment has been revoked.");
  }
  return registration;
}

export function originMatches(request: Request, allowed: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Origin is browser policy, never caller authentication.
  if (allowed === "self") return origin === new URL(request.url).origin;
  if (allowed === origin) return true;
  if (allowed === "http://localhost:*" || allowed === "http://127.0.0.1:*") {
    try {
      const parsed = new URL(origin);
      return `${parsed.protocol}//${parsed.hostname}:*` === allowed;
    } catch {
      return false;
    }
  }
  return false;
}

export function assertRegisteredOrigin(request: Request, registration: ArmadilloRegisteredApp): void {
  const origins = registration.origins ?? ["self"];
  if (!origins.some((origin) => originMatches(request, origin))) {
    throw new HttpError(403, "FORBIDDEN", "Origin is not registered for this client app.");
  }
}

export function appOperation(request: Request, segments: readonly string[]): AppOperation {
  const method = request.method;
  const root = segments[1] ?? "";
  if (root === "auth") return { resource: "Auth", action: segments[2] ?? method.toLowerCase() };
  if (root === "apps") return { resource: "App", action: segments[2] === "current" ? "read:current" : "inspect" };
  if (root === "api-keys") return { resource: "ApiKey", action: method === "GET" ? "read" : "write" };
  if (root === "bridge") return { resource: "Bridge", action: method === "GET" ? "read" : "write" };
  if (root === "vouchers") return {
    resource: "Voucher",
    action: segments[2] === "consume" ? "consume" : method === "GET" ? "read" : "write",
  };
  if (root === "tickets") return {
    resource: "Ticket",
    action: segments[2] === "consume" ? "consume"
      : segments[2] === "lookup" ? "read"
        : method === "GET" ? "read" : "issue",
  };
  if (root === "collectors") return {
    resource: `Collector:${segments[2] ?? ""}`,
    action: segments[3] === "submissions" ? "read" : "submit",
  };
  if (root === "groups" || (root === "admin" && segments[2] === "groups")) {
    return { resource: "Team", action: method === "GET" ? "read" : "write" };
  }
  if (root === "events") return { resource: "Event", action: "read" };
  if (root === "functions") return { resource: "Function", action: segments[2] ?? "invoke" };
  if (root === "tables") {
    const action = method === "GET" ? "read" : method === "POST" ? "create"
      : method === "PATCH" ? "update" : "delete";
    return { resource: segments[2] ?? "Table", action };
  }
  if (root === "query") return { resource: segments[2] ?? "Table", action: "read" };
  if (root === "files") return { resource: "File", action: method === "GET" ? "read" : "write" };
  if (root === "gdpr") return { resource: "Gdpr", action: segments[2] ?? method.toLowerCase() };
  if (root === "admin") return { resource: "Admin", action: segments[2] ?? method.toLowerCase() };
  return { resource: "System", action: root || method.toLowerCase() };
}

export function hasAppCapability(registration: ArmadilloRegisteredApp, operation: AppOperation): boolean {
  const actions = registration.capabilities?.[operation.resource]
    ?? registration.capabilities?.["*"]
    ?? [];
  return actions.includes("*") || actions.includes(operation.action);
}

export async function enforceRegisteredApp(
  request: Request,
  env: ArmadilloEnv,
  currentAppId: string,
  options: ArmadilloBackendDefinition,
  segments: readonly string[],
): Promise<ArmadilloRegisteredApp | undefined> {
  const registration = registeredAppFor(request, options);
  if (!registration) return undefined;
  assertRegisteredOrigin(request, registration);
  const operation = appOperation(request, segments);
  // Bootstrap is deliberately outside a browser app's ordinary capability
  // list: the one-time deployment secret is its authorization boundary.
  const bootstrap = operation.resource === "Admin" && operation.action === "bootstrap";
  if (!bootstrap && !hasAppCapability(registration, operation)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `${registration.name} may not perform ${operation.resource}.${operation.action}.`,
    );
  }
  if ((registration.auth ?? "optional") === "required" && operation.resource !== "Auth" && !bootstrap) {
    await requireAuth(request, env, currentAppId);
  }
  return registration;
}

export function registrationJson(registration: ArmadilloRegisteredApp): JsonObject {
  return {
    id: registration.id,
    name: registration.name,
    mode: registration.mode ?? (registration.auth === "none" ? "public" : "external"),
    auth: registration.auth ?? "optional",
    origins: [...(registration.origins ?? ["self"])],
    capabilities: (registration.capabilities ?? {}) as Record<string, JsonValue>,
    enabled: registration.enabled !== false,
    clientKeyConfigured: Boolean(registration.clientKey),
    ...(registration.provenance ? { provenance: registration.provenance as JsonObject } : {}),
    ...(registration.public ? { public: registration.public } : {}),
  };
}

export async function appsRoute(
  request: Request,
  env: ArmadilloEnv,
  currentAppId: string,
  options: ArmadilloBackendDefinition,
  registration: ArmadilloRegisteredApp,
  action?: string,
): Promise<Response> {
  if (action === "current" && request.method === "GET") {
    return json({ app: registrationJson(registration) });
  }
  if (!action && request.method === "GET") {
    const auth = await requireUserSession(request, env, currentAppId);
    const groups = await membershipsFor(env, currentAppId, auth.user.id);
    const superadmin = env.ARMADILLO_SUPERADMIN_GROUP?.trim() || "armadillo-superadmins";
    if (!groups.some((group) => group.trusted && group.groupSlug === superadmin
      && ["owner", "admin"].includes(group.role))) {
      throw new HttpError(403, "FORBIDDEN", "Superadmin membership is required to inspect apps.");
    }
    const applications = Object.values(options.apps ?? {})
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(registrationJson);
    return json({ apps: applications });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
