import { scopeAllows } from "../engine/auth.js";
import { REALTIME_PROTOCOL } from "../versions.js";
declare const WebSocketPair: typeof import("@cloudflare/workers-types").WebSocketPair;
type Response = import("@cloudflare/workers-types").Response;
declare const Response: typeof import("@cloudflare/workers-types").Response;
import type { D1Database, DurableObjectState, WebSocket } from "@cloudflare/workers-types";
import {
  isRealtimeChannel,
  matchesRealtimeWhere,
  serializeRealtimeMessage,
  type RealtimeClientMessage,
  type RealtimeEvent,
} from "../index.js";

interface RealtimeAttachment {
  appId: string;
  connectionId: string;
  userId: string;
  allowedChannels: string[];
  groups: Record<string, string>;
  tokenHash: string;
  subscriptions: Record<string, { channel: string; where?: Record<string, unknown> }>;
}

function attachment(socket: WebSocket): RealtimeAttachment {
  return socket.deserializeAttachment() as RealtimeAttachment | null ?? {
    appId: "",
    connectionId: "",
    userId: "",
    allowedChannels: [],
    groups: {},
    tokenHash: "",
    subscriptions: {},
  };
}

function send(socket: WebSocket, value: unknown): void {
  try {
    socket.send(JSON.stringify(value));
  } catch {
    try { socket.close(1011, "Realtime send failed"); } catch { /* Already closed. */ }
  }
}

interface RealtimeAccess {
  kind: "public" | "owner" | "team";
  ownerId?: string;
  groupId?: string;
  roles?: string[];
}

function canReceive(stored: RealtimeAttachment, access: RealtimeAccess | undefined): boolean {
  if (!access) return false;
  if (access.kind === "public") return true;
  if (access.kind === "owner") return access.ownerId === stored.userId;
  if (!access.groupId || !Object.hasOwn(stored.groups, access.groupId)) return false;
  return !access.roles?.length || access.roles.includes(stored.groups[access.groupId] ?? "");
}

/** Cloudflare Durable Object implementing hibernating, multiplexed realtime channels. */
/**
 * Ceiling on sockets examined per broadcast.
 *
 * Each socket costs up to three sequential D1 queries inside the Durable Object
 * request, and connections are capped per socket rather than per Durable Object,
 * so one busy instance could otherwise turn a single record mutation into
 * thousands of serial round trips. Truncating fan-out costs freshness for the
 * overflow sockets, which resynchronise on their next poll.
 */
const REALTIME_FANOUT_CAP = 500;

export class ArmadilloRealtime {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: { DB?: D1Database },
  ) {}

  private async revalidate(socket: WebSocket, stored: RealtimeAttachment, channel?: string): Promise<boolean> {
    const db = this.env.DB;
    if (!db || !stored.tokenHash) { socket.close(1008, "Reconnect to authenticate"); return false; }
    const timestamp = new Date().toISOString();
    const session = await db.prepare(
      `SELECT s.user_id FROM _armadillo_sessions AS s JOIN _armadillo_users AS u
       ON u.app_id = s.app_id AND u.id = s.user_id
       WHERE s.app_id = ? AND s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?`,
    ).bind(stored.appId, stored.tokenHash, stored.userId, timestamp).first();
    if (!session) {
      const key = await db.prepare(
        `SELECT k.scopes FROM _armadillo_api_keys AS k JOIN _armadillo_users AS u
         ON u.app_id = k.app_id AND u.id = k.owner_id
         WHERE k.app_id = ? AND k.key_hash = ? AND k.owner_id = ?
         AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
         AND (k.grace_expires_at IS NULL OR k.grace_expires_at > ?)`,
      ).bind(stored.appId, stored.tokenHash, stored.userId, timestamp, timestamp).first<{ scopes: string }>();
      let scopes: unknown = [];
      try { scopes = JSON.parse(key?.scopes ?? "[]"); } catch { /* Invalid scopes deny access. */ }
      if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === "string") || !scopeAllows(scopes as string[], "realtime:connect")) {
        socket.close(1008, "Credential revoked or expired"); return false;
      }
      if (channel && !scopeAllows(scopes as string[], channel.startsWith("table:") ? "tables:read" : "events:read")) {
        return false;
      }
    }
    const memberships = await db.prepare(
      `SELECT group_id, role FROM _armadillo_group_members WHERE app_id = ? AND user_id = ?`,
    ).bind(stored.appId, stored.userId).all<{ group_id: string; role: string }>();
    stored.groups = Object.fromEntries(memberships.results.map(row => [row.group_id, row.role]));
    return true;
  }

  async fetch(request: import("@cloudflare/workers-types").Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const internal = await request.json<RealtimeEvent & { _access?: RealtimeAccess }>();
      const { _access: access, ...event } = internal;
      if (!event || !isRealtimeChannel(event.channel) || !event.record || typeof event.record !== "object") {
        return new Response("Invalid realtime event", { status: 400 });
      }
      // `canReceive` reads the membership map that `revalidate` just refreshed, so the
      // order matters: refresh first, then decide. The cost is bounded by
      // `REALTIME_FANOUT_CAP` below.
      let examined = 0;
      for (const socket of this.state.getWebSockets()) {
        if (examined >= REALTIME_FANOUT_CAP) break;
        examined += 1;
        const stored = attachment(socket);
        if (stored.appId !== request.headers.get("x-armadillo-app-id")) continue;
        if (!await this.revalidate(socket, stored, event.channel) || !canReceive(stored, access)) continue;
        for (const [id, subscription] of Object.entries(stored.subscriptions)) {
          if (subscription.channel === event.channel
            && matchesRealtimeWhere(event.record as Record<string, unknown>, subscription.where)) {
            send(socket, { type: "change", id, event });
          }
        }
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname !== "/connect" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const tokenHash = request.headers.get("x-armadillo-realtime-token-hash") ?? "";
    const userId = request.headers.get("x-armadillo-realtime-user") ?? "";
    const appId = request.headers.get("x-armadillo-app-id") ?? "";
    const connectionId = request.headers.get("x-armadillo-realtime-connection") ?? "";
    const allowedChannels = (request.headers.get("x-armadillo-realtime-channels") ?? "")
      .split(",").filter(Boolean);
    if (!tokenHash || !userId || !appId || !connectionId || allowedChannels.length === 0) {
      return new Response("Realtime authorization required", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      appId, connectionId, userId, allowedChannels, groups: {}, tokenHash, subscriptions: {},
    } satisfies RealtimeAttachment);
    this.state.acceptWebSocket(server as unknown as WebSocket);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: request.headers.get("sec-websocket-protocol") === REALTIME_PROTOCOL
        ? { "sec-websocket-protocol": REALTIME_PROTOCOL } : {},
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if ((typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength) > 8_192) {
        socket.close(1009, "Realtime message exceeds 8 KiB"); return;
      }
      const parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as RealtimeClientMessage;
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid message");
      if (parsed.type === "heartbeat") {
        if (typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) throw new Error("Invalid heartbeat");
      } else if (parsed.type === "subscribe" || parsed.type === "unsubscribe") {
        if (typeof parsed.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.id)
          || ["__proto__", "prototype", "constructor"].includes(parsed.id)) throw new Error("Invalid subscription id");
        if (parsed.type === "subscribe" && parsed.where !== undefined) {
          if (!parsed.where || typeof parsed.where !== "object" || Array.isArray(parsed.where)
            || Object.keys(parsed.where).length > 32
            || Object.entries(parsed.where).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(key)
              || (value !== null && !["string", "number", "boolean"].includes(typeof value)))) throw new Error("Invalid filter");
        }
      } else throw new Error("Invalid message type");
      const stored = attachment(socket);
      if (!await this.revalidate(socket, stored, parsed.type === "subscribe" && typeof parsed.channel === "string" ? parsed.channel : undefined)) {
        send(socket, { type: "error", message: "Realtime credential or channel scope is not authorized." });
        return;
      }
      if (parsed.type === "heartbeat") {
        if (this.env.DB && stored.appId && stored.connectionId) {
          await this.env.DB.prepare(
            "UPDATE _armadillo_realtime_connections SET last_heartbeat = ? WHERE app_id = ? AND id = ?",
          ).bind(new Date().toISOString(), stored.appId, stored.connectionId).run();
        }
        send(socket, { type: "heartbeat", timestamp: parsed.timestamp });
        return;
      }
      if (parsed.type === "unsubscribe") {
        delete stored.subscriptions[parsed.id];
        stored.groups = {};
        socket.serializeAttachment(stored);
        send(socket, { type: "unsubscribed", id: parsed.id });
        return;
      }
      if (parsed.type !== "subscribe" || !isRealtimeChannel(parsed.channel)
        || !stored.allowedChannels.includes(parsed.channel)) {
        send(socket, {
          type: "error",
          ...(typeof (parsed as { id?: unknown }).id === "string" ? { id: (parsed as { id: string }).id } : {}),
          message: "Realtime subscription is not authorized.",
        });
        return;
      }
      if (Object.keys(stored.subscriptions).length >= 100 && !stored.subscriptions[parsed.id]) {
        send(socket, { type: "error", id: parsed.id, message: "Subscription limit reached." }); return;
      }
      const subscriptions = { ...stored.subscriptions, [parsed.id]: {
        channel: parsed.channel,
        ...(parsed.where ? { where: parsed.where } : {}),
      } };
      // Membership is always loaded live. Do not persist a potentially large
      // membership list inside the platform's bounded websocket attachment.
      stored.groups = {};
      const next = { ...stored, subscriptions };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 12_000) {
        send(socket, { type: "error", id: parsed.id, message: "Subscription state limit reached." }); return;
      }
      socket.serializeAttachment(next);
      send(socket, { type: "subscribed", id: parsed.id, channel: parsed.channel });
    } catch {
      send(socket, { type: "error", message: "Realtime message is invalid." });
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const stored = attachment(socket);
    if (this.env.DB && stored.appId && stored.connectionId) {
      await this.env.DB.prepare(
        "DELETE FROM _armadillo_realtime_connections WHERE app_id = ? AND id = ?",
      ).bind(stored.appId, stored.connectionId).run();
    }
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Realtime socket error");
  }
}

export { serializeRealtimeMessage };
