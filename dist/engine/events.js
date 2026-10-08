import { recordReadAudience } from "./permissions.js";
import { HTTP_API_PREFIX, REALTIME_PROTOCOL } from "../versions.js";
import {} from "../backend.js";
import {} from "../backend.js";
import {} from "./environment.js";
import {} from "../backend.js";
import { prepareWebhookEvent } from "./handlers/webhooks.js";
import { now } from "./records.js";
import {} from "../backend.js";
import { EVENT_TYPE } from "./http.js";
import { ArmadilloFunctionError } from "../backend.js";
import { requireGroupMembership } from "./teams.js";
import { validateData } from "./validation.js";
import { INTERNAL_TABLES } from "../backend.js";
import { makeId } from "./helpers/id.js";
import { HttpError } from "./http.js";
import { requireAuth, scopeAllows } from "./auth.js";
import { integer } from "./queries.js";
import {} from "./environment.js";
import { json } from "./http.js";
import { isRealtimeChannel } from "../index.js";
function eventJson(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    type: row.type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    data: JSON.parse(row.data),
    createdAt: row.created_at
  };
}
async function realtimeStub(env, currentAppId) {
  const namespace = env.ARMADILLO_REALTIME;
  if (!namespace) return void 0;
  return namespace.get(namespace.idFromName(currentAppId));
}
const pendingBroadcasts = /* @__PURE__ */ Symbol("armadillo.pending-broadcasts");
function pendingRealtimeFor(env) {
  return env[pendingBroadcasts];
}
function deferRealtime(env) {
  const pending = [];
  env[pendingBroadcasts] = pending;
  const clear = () => {
    if (env[pendingBroadcasts] === pending) {
      delete env[pendingBroadcasts];
    }
    pending.length = 0;
  };
  return {
    async flush() {
      const queued = [...pending];
      clear();
      for (const { appId, event } of queued) await broadcastRealtime(env, appId, event);
    },
    discard() {
      clear();
    }
  };
}
async function broadcastRealtime(env, currentAppId, event) {
  const pending = pendingRealtimeFor(env);
  if (pending) {
    pending.push({ appId: currentAppId, event: structuredClone(event) });
    return;
  }
  try {
    const stub = await realtimeStub(env, currentAppId);
    if (!stub) return;
    const response = await stub.fetch("https://armadillo.internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json", "x-armadillo-app-id": currentAppId },
      body: JSON.stringify(event)
    });
    if (!response.ok) console.warn("Armadillo realtime broadcast failed", { status: response.status });
  } catch (error) {
    console.warn("Armadillo realtime broadcast failed after commit", { error: String(error) });
  }
}
async function emitTableMutation(env, currentAppId, options, collection, type, record, _actorId) {
  const table = options.schema?.normalized.tables[collection];
  const access = recordReadAudience(table, record);
  await broadcastRealtime(env, currentAppId, {
    type,
    channel: `table:${collection}`,
    table: collection,
    record,
    timestamp: now(),
    _access: access
  });
}
async function emitEvent(env, currentAppId, actorId, groupId, type, data, options) {
  if (!EVENT_TYPE.test(type)) {
    throw new ArmadilloFunctionError(500, "INTERNAL_ERROR", "The function emitted an invalid event type.");
  }
  await requireGroupMembership(env, currentAppId, groupId, actorId);
  const encoded = validateData(data, env).encoded;
  const jobs = await prepareWebhookEvent(env, currentAppId, options, type, data, actorId);
  await env.DB.batch([env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.events}
       (app_id, id, group_id, type, actor_id, data, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(currentAppId, makeId("event"), groupId, type, actorId, encoded, now()), ...jobs]);
  await broadcastRealtime(env, currentAppId, {
    type: "event",
    channel: type,
    _access: { kind: "team", groupId },
    event: type,
    record: data,
    timestamp: now()
  });
}
async function eventsRoute(request, env, currentAppId) {
  if (request.method !== "GET") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  const auth = await requireAuth(request, env, currentAppId, "events:read");
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const cursor = url.searchParams.get("cursor");
  if (after && cursor) {
    throw new HttpError(400, "BAD_REQUEST", "Pass after or cursor, not both.");
  }
  if (after && Number.isNaN(Date.parse(after))) {
    throw new HttpError(400, "BAD_REQUEST", "after must be an ISO timestamp.");
  }
  let cursorCreatedAt = null;
  let cursorId = null;
  if (cursor) {
    const separator = cursor.lastIndexOf("|");
    cursorCreatedAt = separator > 0 ? cursor.slice(0, separator) : null;
    cursorId = separator > 0 ? cursor.slice(separator + 1) : null;
    if (!cursorCreatedAt || !cursorId || !Number.isFinite(Date.parse(cursorCreatedAt))) {
      throw new HttpError(400, "BAD_REQUEST", "Event cursor is invalid.");
    }
  }
  const limit = integer(url.searchParams.get("limit") === null ? void 0 : Number.parseInt(url.searchParams.get("limit") ?? "", 10), 50, 1, 200, "limit");
  const parameters = [currentAppId, auth.user.id];
  let older = "";
  const afterClause = after ? "AND e.created_at > ?" : "";
  if (after) parameters.push(new Date(after).toISOString());
  if (cursorCreatedAt && cursorId) {
    older = "AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))";
    parameters.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }
  parameters.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT e.id, e.group_id, e.type, e.actor_id, u.name AS actor_name,
            e.data, e.created_at
       FROM ${INTERNAL_TABLES.events} AS e
       JOIN ${INTERNAL_TABLES.groupMembers} AS m
         ON m.app_id = e.app_id AND m.group_id = e.group_id
       JOIN ${INTERNAL_TABLES.users} AS u
         ON u.app_id = e.app_id AND u.id = e.actor_id
      WHERE e.app_id = ? AND m.user_id = ? ${afterClause} ${older}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?`
  ).bind(...parameters).all();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return json({
    events: page.map(eventJson),
    nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null
  });
}
function decodeRealtimeCredential(value) {
  try {
    const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return void 0;
  }
}
function normalizeRealtimeRequest(request) {
  const url = new URL(request.url);
  if (url.pathname !== `${HTTP_API_PREFIX}/realtime/connect`) return request;
  const headers = new Headers(request.headers);
  const protocols = (headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
  const encoded = protocols.find((protocol) => protocol.startsWith("credential."))?.slice("credential.".length);
  const credential = encoded ? decodeRealtimeCredential(encoded) : void 0;
  if (credential) headers.set("authorization", `Bearer ${credential}`);
  const namespace = url.searchParams.get("appId");
  const clientApp = url.searchParams.get("clientAppId");
  const clientKey = url.searchParams.get("clientKey");
  if (namespace) headers.set("x-armadillo-app-id", namespace);
  if (clientApp) headers.set("x-armadillo-client-app-id", clientApp);
  if (clientKey) headers.set("x-armadillo-client-key", clientKey);
  return new Request(request, { headers });
}
async function realtimeConnectRoute(request, env, currentAppId, options) {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "BAD_REQUEST", "Realtime connections require a WebSocket upgrade.");
  }
  if (!options.realtime || !env.ARMADILLO_REALTIME) {
    throw new HttpError(404, "NOT_FOUND", "Realtime is not configured for this backend.");
  }
  const auth = await requireAuth(request, env, currentAppId, "realtime:connect");
  if (auth.external) throw new HttpError(403, "FORBIDDEN", "Realtime currently requires an Armadillo session or API key so credentials can be revalidated.");
  const url = new URL(request.url);
  const requested = [...new Set(url.searchParams.getAll("channel"))];
  if (requested.length === 0 || requested.length > 20) {
    throw new HttpError(400, "BAD_REQUEST", "Request between 1 and 20 realtime channels.");
  }
  for (const channel of requested) {
    if (!isRealtimeChannel(channel)) throw new HttpError(400, "BAD_REQUEST", "A realtime channel is invalid.");
    const readScope = channel.startsWith("table:") ? "tables:read" : "events:read";
    if (!scopeAllows(auth.principal.scopes, readScope)) {
      throw new HttpError(403, "FORBIDDEN", `Realtime channel requires the ${readScope} scope.`);
    }
    if (channel.startsWith("table:")) {
      const tableName = channel.slice("table:".length);
      if (!options.schema?.normalized.tables[tableName]) {
        throw new HttpError(404, "NOT_FOUND", `Realtime table \`${tableName}\` is not declared.`);
      }
    } else if (!options.realtime.channels?.includes(channel)) {
      throw new HttpError(403, "FORBIDDEN", `Realtime channel \`${channel}\` is not configured.`);
    }
    const authorized = await options.realtime.authorize?.({
      appId: currentAppId,
      channel,
      user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
      request
    });
    if (authorized === false) throw new HttpError(403, "FORBIDDEN", `Realtime channel \`${channel}\` is not allowed.`);
  }
  const stub = await realtimeStub(env, currentAppId);
  if (!stub) throw new HttpError(503, "INTERNAL_ERROR", "Realtime binding is unavailable.");
  const connectionId = makeId("realtime");
  const connectedAt = now();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.realtimeConnections}
       (app_id, id, user_id, channels, connected_at, last_heartbeat)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    currentAppId,
    connectionId,
    auth.user.id,
    JSON.stringify(requested),
    connectedAt,
    connectedAt
  ).run();
  const headers = new Headers(request.headers);
  headers.set("x-armadillo-realtime-token-hash", auth.tokenHash);
  headers.set("x-armadillo-realtime-user", auth.user.id);
  headers.set("x-armadillo-realtime-channels", requested.join(","));
  headers.set("x-armadillo-realtime-connection", connectionId);
  headers.set("x-armadillo-app-id", currentAppId);
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
  if (protocols.includes(REALTIME_PROTOCOL)) headers.set("sec-websocket-protocol", REALTIME_PROTOCOL);
  else headers.delete("sec-websocket-protocol");
  const response = await stub.fetch(new Request("https://armadillo.internal/connect", {
    method: "GET",
    headers
  }));
  if (response.status !== 101) {
    await env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.realtimeConnections} WHERE app_id = ? AND id = ?`
    ).bind(currentAppId, connectionId).run();
  }
  return response;
}
export {
  broadcastRealtime,
  decodeRealtimeCredential,
  deferRealtime,
  emitEvent,
  emitTableMutation,
  eventJson,
  eventsRoute,
  normalizeRealtimeRequest,
  pendingRealtimeFor,
  realtimeConnectRoute,
  realtimeStub
};
