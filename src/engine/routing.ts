import { HTTP_API_PREFIX, HTTP_API_VERSION } from "../versions.js";
import { explainSchemaJson } from "../access.js";
import { buildPromptPackFromDiscovery, isStructureDiscoveryEnabled } from "../prompt-pack.js";
import { discoverBackend, redactDiscoveryAuthorization } from "../discovery.js";
import { optionalAuth } from "./auth.js";
import { decodeRouteSegments } from "./router.js";
import { HttpError } from "./http.js";
import { type ArmadilloEnv } from "./environment.js";
import { type ArmadilloBackendDefinition } from "../backend.js";
import { preflight } from "./http.js";
import { normalizeRealtimeRequest } from "./events.js";
import { assertOrigin } from "./http.js";
import { clientEtag } from "./http.js";
import CLIENT_MODULE_SOURCE from "../../dist/client.module.js";
import { clientConfigSource } from "./http.js";
import CLIENT_SCRIPT_SOURCE from "../../dist/client.bundle.js";
import { json } from "./http.js";
import { ARMADILLO_VERSION } from "./environment.js";
import { appId } from "./apps.js";
import { enforceRegisteredApp } from "./apps.js";
import { appsRoute } from "./apps.js";
import { bootstrapSuperadmin } from "./auth.js";
import { authRoute } from "./auth.js";
import { apiKeysRoute } from "./api-keys.js";
import { bridgeJoinRoute, bridgeRoute } from "./bridge.js";
import { vouchersRoute } from "./vouchers.js";
import { ticketsRoute } from "./tickets.js";
import { collectorsRoute } from "./collectors.js";
import { groupsRoute } from "./teams.js";
import { eventsRoute } from "./events.js";
import { realtimeConnectRoute } from "./events.js";
import { functionRoute } from "./functions.js";
import { recordFilesRoute } from "./files.js";
import { tableRoute } from "./records.js";
import { ticketInventoryRoute } from "./ticket-inventory.js";
import { expandRoute } from "./queries.js";
import { queryRoute } from "./queries.js";
import { requireAuth } from "./auth.js";
import { completePresignedUpload } from "./files.js";
import { multipartUploadRoute } from "./files.js";
import { filesRoute } from "./files.js";
import { gdprRoute } from "./gdpr.js";
import { ensureGroupProjection } from "./group-projection.js";
import { burrowRoute } from "./burrow.js";
import { oauthCallback } from "./oauth.js";
import { oauthLogin } from "./oauth.js";
import { uiRoute } from "./ui-routing.js";
import { chargeUsage, isUsageExemptPath } from "./usage.js";

export function routeSegments(pathname: string): string[] {
  try {
    return decodeRouteSegments(pathname);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "URL path encoding is invalid.");
  }
}

export async function route(
  request: Request,
  env: ArmadilloEnv,
  options: ArmadilloBackendDefinition,
): Promise<Response> {
  if (request.method === "OPTIONS") return preflight(request, env);
  request = normalizeRealtimeRequest(request);
  assertOrigin(request, env);
  const url = new URL(request.url);
  const currentAppId = appId(request, env, options);
  await ensureGroupProjection(env, currentAppId, options.schema);
  const segments = routeSegments(url.pathname);
  // Usage Slice 1: count and optionally quota non-exempt API traffic.
  // Burrow, health, and client assets stay available for operator recovery.
  // One statement does both: the charge *is* the gate, so a request cannot slip
  // past the ceiling while its own increment is still in flight. The charge is
  // kept whatever the route then answers — the request was served either way.
  if (!isUsageExemptPath(segments) && segments[0] === HTTP_API_VERSION) {
    await chargeUsage(env, currentAppId, options, "requests");
  }
  const page = await uiRoute(request, env, currentAppId, options);
  if (page) return page;
  // A listener may handle custom API routes, but cannot bypass a registered
  // client's capability ceiling. Invoke it exactly once after that check.
  const registration = segments[0] === HTTP_API_VERSION
    ? await enforceRegisteredApp(request, env, currentAppId, options, segments)
    : undefined;
  const listenerResponse = await options.listeners?.request?.({ request, appId: currentAppId });
  if (listenerResponse) return listenerResponse;

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/client.js") {
    const etag = clientEtag("module", CLIENT_MODULE_SOURCE, env);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
    return new Response(request.method === "HEAD" ? null : clientConfigSource(request, env, CLIENT_MODULE_SOURCE), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, no-cache",
        "access-control-allow-origin": "*",
        etag,
      },
    });
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/armadillo/client.js") {
    const etag = clientEtag("script", CLIENT_SCRIPT_SOURCE, env);
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
    return new Response(request.method === "HEAD" ? null : clientConfigSource(request, env, CLIENT_SCRIPT_SOURCE), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, no-cache",
        "access-control-allow-origin": "*",
        etag,
      },
    });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === HTTP_API_PREFIX)) {
    const structureDiscovery = isStructureDiscoveryEnabled(options);
    return json({
      name: "Armadillo",
      version: ARMADILLO_VERSION,
      stage: env.ARMADILLO_STAGE?.trim() || "unknown",
      purpose: env.ARMADILLO_PURPOSE ?? "A sturdy little application backend.",
      client: new URL("/client.js", url).toString(),
      script: new URL("/armadillo/client.js", url).toString(),
      storage: env.ARMADILLO_STORAGE_LABELS ?? ["database", "objects"],
      structureDiscovery,
      ...(structureDiscovery ? {
        schema: new URL("/v1/schema", url).toString(),
        discovery: new URL("/v1/discovery", url).toString(),
        prompt: new URL("/v1/discovery/prompt", url).toString(),
      } : {}),
    });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return json({ ok: result?.ok === 1, version: ARMADILLO_VERSION });
  }
  if (segments[0] === "join" && segments.length === 2 && (request.method === "GET" || request.method === "HEAD")) {
    return bridgeJoinRoute(request, env, currentAppId, segments[1] ?? "");
  }
  const oauthMatch = /^\/auth\/(login|callback)\/([a-z][a-z0-9-]{0,31})$/.exec(url.pathname);
  if (oauthMatch && request.method === "GET") {
    return oauthMatch[1] === "login"
      ? oauthLogin(request, env, currentAppId, options, oauthMatch[2]!)
      : oauthCallback(request, env, currentAppId, options, oauthMatch[2]!);
  }

  if (segments[0] !== HTTP_API_VERSION) throw new HttpError(404, "NOT_FOUND", "Route not found.");
  if (segments[1] === "schema" && segments.length === 2 && request.method === "GET") {
    if (!isStructureDiscoveryEnabled(options)) {
      throw new HttpError(404, "STRUCTURE_DISCOVERY_DISABLED", "Structure discovery is disabled on this backend.");
    }
    if (!options.schema) return json({ tables: {} });
    return json({ tables: explainSchemaJson(options.schema) });
  }
  if (segments[1] === "discovery" && request.method === "GET"
    && (segments.length === 2 || (segments.length === 3 && segments[2] === "prompt"))) {
    if (!isStructureDiscoveryEnabled(options)) {
      throw new HttpError(404, "STRUCTURE_DISCOVERY_DISABLED", "Structure discovery is disabled on this backend.");
    }
    // Discovery is unauthenticated by default, so the trusted team and role
    // names behind each function's `authorize` rule are withheld until the
    // caller has proven an identity. Reporting *that* a rule exists is enough
    // for a legitimate integrator; the values are a privilege map.
    const identified = Boolean(await optionalAuth(request, env, currentAppId));
    const discovery = discoverBackend(options);
    const pack = buildPromptPackFromDiscovery(
      identified ? discovery : redactDiscoveryAuthorization(discovery),
      options,
      { baseUrl: url.origin },
    );
    if (segments.length === 3) {
      return new Response(pack.markdown, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    const { markdown: _markdown, ...jsonPack } = pack;
    return json(jsonPack);
  }
  if (segments[1] === "apps" && registration
    && (segments.length === 2 || (segments.length === 3 && segments[2] === "current"))) {
    return appsRoute(request, env, currentAppId, options, registration, segments[2]);
  }
  if (segments[1] === "admin" && segments[2] === "bootstrap" && segments.length === 3 && request.method === "POST") {
    return bootstrapSuperadmin(request, env, currentAppId);
  }
  if (segments[1] === "burrow") return burrowRoute(request, env, currentAppId, options, segments);
  if (segments[1] === "auth" && segments[2] && segments.length === 3) {
    return authRoute(request, env, currentAppId, segments[2], options.schema);
  }
  if (segments[1] === "api-keys" && (segments.length === 2 || segments.length === 3 || segments.length === 4)) {
    return apiKeysRoute(request, env, currentAppId, segments[2], segments[3]);
  }
  if (segments[1] === "bridge") return bridgeRoute(request, env, currentAppId, segments);
  if (segments[1] === "vouchers" && segments.length >= 2 && segments.length <= 4) {
    return vouchersRoute(request, env, currentAppId, segments[2], segments[3]);
  }
  if (segments[1] === "tickets" && (segments.length === 2 || segments.length === 3)) {
    return ticketsRoute(request, env, currentAppId, options.tickets, segments[2]);
  }
  if (segments[1] === "collectors" && segments[2]
    && (segments.length === 3 || (segments.length === 4 && segments[3] === "submissions"))) {
    return collectorsRoute(
      request,
      env,
      currentAppId,
      segments[2],
      options.collectors?.[segments[2]],
      options,
      segments[3],
    );
  }
  if (segments[1] === "groups" && segments.length === 2) {
    return groupsRoute(request, env, currentAppId, options);
  }
  if (segments[1] === "groups" && segments[2] && segments.length === 4) {
    return groupsRoute(request, env, currentAppId, options, segments[2], segments[3]);
  }
  if (segments[1] === "groups" && segments[2] && segments[3] === "members" && segments[4] && segments.length === 5) {
    return groupsRoute(request, env, currentAppId, options, segments[2], segments[3], false, segments[4]);
  }
  if (segments[1] === "admin" && segments[2] === "groups" && segments.length === 3) {
    return groupsRoute(request, env, currentAppId, options, undefined, undefined, true);
  }
  if (segments[1] === "events" && segments.length === 2) {
    return eventsRoute(request, env, currentAppId);
  }
  if (segments[1] === "realtime" && segments[2] === "connect" && segments.length === 3) {
    return realtimeConnectRoute(request, env, currentAppId, options);
  }
  if (segments[1] === "functions" && segments[2] && segments.length === 3) {
    return functionRoute(request, env, currentAppId, segments[2], options);
  }
  if (options.files === false && (segments[1] === "files" || (segments[1] === "tables" && segments[4] === "files"))) {
    throw new HttpError(503, "INTERNAL_ERROR", "Files are not enabled for this application.");
  }
  if (segments[1] === "tables" && segments[2] && segments[3] && segments[4] === "files"
    && (segments.length === 5 || segments.length === 6)) {
    return recordFilesRoute(
      request,
      env,
      currentAppId,
      segments[2],
      segments[3],
      options.schema,
      segments[5],
    );
  }
  if (segments[1] === "tables" && segments[2] && segments[3] && segments[4] === "expand" && segments.length === 5) {
    return expandRoute(request, env, currentAppId, segments[2], segments[3], options.schema);
  }
  if (segments[1] === "tables" && segments[2] && segments[3] === "tickets"
    && (segments[4] === "issue" || segments[4] === "consume") && segments.length === 5) {
    return ticketInventoryRoute(request, env, currentAppId, segments[2], segments[4], options.schema);
  }
  if (segments[1] === "tables" && segments[2] && segments.length <= 4) {
    return tableRoute(request, env, currentAppId, segments[2], options.schema, segments[3], options);
  }
  if (segments[1] === "query" && segments[2] && segments.length === 3) {
    return queryRoute(request, env, currentAppId, segments[2], options.schema);
  }
  if (segments[1] === "files" && segments[2] === "uploads" && segments[3]
    && segments[4] === "complete" && segments.length === 5 && request.method === "POST") {
    const auth = await requireAuth(request, env, currentAppId, "files:write");
    return completePresignedUpload(env, currentAppId, auth, segments[3], options);
  }
  if (segments[1] === "files" && segments[2] === "multipart" && segments[3] && segments.length >= 4) {
    const auth = await requireAuth(request, env, currentAppId, "files:write");
    if (segments[4] === "parts" && segments[5] && segments.length === 6) {
      return multipartUploadRoute(request, env, currentAppId, auth, segments[3], "parts", segments[5], options);
    }
    if (segments[4] === "complete" && segments.length === 5) {
      return multipartUploadRoute(request, env, currentAppId, auth, segments[3], "complete", undefined, options);
    }
    if (segments.length === 4) {
      return multipartUploadRoute(request, env, currentAppId, auth, segments[3], undefined, undefined, options);
    }
  }
  if (segments[1] === "files"
    && (segments.length === 2 || segments.length === 3
      || (segments.length === 4 && (segments[3] === "meta" || segments[3] === "url")))) {
    return filesRoute(request, env, currentAppId, segments[2], segments[3], options.schema, options);
  }
  if (segments[1] === "gdpr" && (segments.length === 3 || segments.length === 2)) {
    return gdprRoute(request, env, currentAppId, options, segments[2]);
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
