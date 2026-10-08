/**
 * Local/DEV mount for Agent Bridge enrollment surfaces.
 * Sandbox-only — never enable on non-dev / prod Workers.
 */
import { sha256 } from "../engine/helpers/crypto.js";
import { cookieValue, sessionCookieName } from "../engine/sessions.js";
import {
  handleAgentBridgeRequest,
  type AgentBridgeHttpOptions,
} from "./http.js";
import { MemoryAgentBridgeStore, type AgentBridgeStore } from "./store.js";

export interface AgentBridgeLocalOptions {
  store: AgentBridgeStore;
  appId: string;
  /**
   * Must be true only under local DEV (`ARMADILLO_DEV_MODE` / development: true).
   * Controls plaintext claim-token echo (Detail R5).
   */
  sandbox: boolean;
  /** Look up owner user id from a Dillo session cookie or Bearer session token. */
  resolveOwnerId: (request: Request) => Promise<string | undefined>;
}

/** Extract Bearer `abr_` scoped credential when present. */
export function bridgeSecretFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  const token = match?.[1];
  if (token && token.startsWith("abr_") && token.length <= 1_024) return token;
  return undefined;
}

/**
 * Resolve owner session credential (Bearer session token or ambient cookie).
 * Does not treat `abr_` bridge secrets as sessions.
 */
export function ownerSessionCredential(
  request: Request,
  appId: string,
): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  if (request.headers.has("authorization")) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    const token = match?.[1];
    if (!token || token.length > 1_024 || token.startsWith("abr_")) return undefined;
    return token;
  }
  return cookieValue(request, sessionCookieName(appId));
}

/** SQLite session → user_id lookup used by LocalArmadilloServer under DEV. */
export async function resolveOwnerIdFromSqliteSession(
  request: Request,
  appId: string,
  lookup: (tokenHash: string, nowIso: string) => string | undefined,
): Promise<string | undefined> {
  const credential = ownerSessionCredential(request, appId);
  if (!credential) return undefined;
  const tokenHash = await sha256(credential);
  return lookup(tokenHash, new Date().toISOString());
}

/**
 * Map local request auth into Agent Bridge options and dispatch.
 * Returns undefined for non-bridge paths so the host can continue
 * (including library `/v1/tickets`).
 */
export async function handleAgentBridgeLocalRequest(
  request: Request,
  options: AgentBridgeLocalOptions,
): Promise<Response | undefined> {
  const ownerId = await options.resolveOwnerId(request);
  const bridgeSecret = bridgeSecretFromRequest(request);
  const httpOptions: AgentBridgeHttpOptions = {
    store: options.store,
    appId: options.appId,
    // sandbox flag ONLY when caller asserts DEV sandbox
    ...(options.sandbox ? { sandbox: true } : { sandbox: false }),
    ...(ownerId ? { ownerId } : {}),
    ...(bridgeSecret ? { bridgeSecret } : {}),
  };
  return handleAgentBridgeRequest(request, httpOptions);
}

/** Process-lifetime in-memory store factory for one local DEV server. */
export function createLocalAgentBridgeStore(): MemoryAgentBridgeStore {
  return new MemoryAgentBridgeStore();
}
