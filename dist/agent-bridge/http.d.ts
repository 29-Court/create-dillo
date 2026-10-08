/**
 * Dedicated Agent Bridge HTTP surface (sandbox).
 * Does NOT use /v1/tickets — see Detail security review (M1).
 */
import { type ClaimTicket } from "./types.js";
import { type AgentBridgeStore } from "./store.js";
export interface AgentBridgeHttpOptions {
    store: AgentBridgeStore;
    /** Resolved app id for this request (adapter-provided). */
    appId: string;
    /**
     * Owner session user id for issue/enroll.
     * Leave undefined for public join + credential-auth routes.
     */
    ownerId?: string;
    /** Bearer secret for enrolled agent (bridge scoped-cred). */
    bridgeSecret?: string;
    /** Sandbox-only: allow plaintext token in issue JSON (never log it). */
    sandbox?: boolean;
}
export declare function pendingEnrollMarkdown(ticket: ClaimTicket, joinPath: string): string;
/**
 * Handle Agent Bridge routes. Returns undefined when the path is not bridge-owned
 * so the host router can continue.
 */
export declare function handleAgentBridgeRequest(request: Request, options: AgentBridgeHttpOptions): Promise<Response | undefined>;
