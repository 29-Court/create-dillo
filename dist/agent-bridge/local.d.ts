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
export declare function bridgeSecretFromRequest(request: Request): string | undefined;
/**
 * Resolve owner session credential (Bearer session token or ambient cookie).
 * Does not treat `abr_` bridge secrets as sessions.
 */
export declare function ownerSessionCredential(request: Request, appId: string): string | undefined;
/** SQLite session → user_id lookup used by LocalArmadilloServer under DEV. */
export declare function resolveOwnerIdFromSqliteSession(request: Request, appId: string, lookup: (tokenHash: string, nowIso: string) => string | undefined): Promise<string | undefined>;
/**
 * Map local request auth into Agent Bridge options and dispatch.
 * Returns undefined for non-bridge paths so the host can continue
 * (including library `/v1/tickets`).
 */
export declare function handleAgentBridgeLocalRequest(request: Request, options: AgentBridgeLocalOptions): Promise<Response | undefined>;
/** Process-lifetime in-memory store factory for one local DEV server. */
export declare function createLocalAgentBridgeStore(): MemoryAgentBridgeStore;
