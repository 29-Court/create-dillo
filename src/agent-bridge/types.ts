/** Agent Bridge enrollment v0 — dedicated claim-ticket surface (NOT /v1/tickets). */

export const AGENT_BRIDGE_CONNECTORS = ["muse-poll", "grok-webhook", "generic-manual"] as const;
export type AgentBridgeConnector = (typeof AGENT_BRIDGE_CONNECTORS)[number];

/** Tight intent allowlist (Detail R3). */
export const AGENT_BRIDGE_INTENTS = ["bridge_enroll_v0"] as const;
export type AgentBridgeIntent = (typeof AGENT_BRIDGE_INTENTS)[number];

export const CLAIM_TICKET_DEFAULT_TTL_SECONDS = 15 * 60;
export const CLAIM_TICKET_MAX_TTL_SECONDS = 30 * 60;
export const CLAIM_TICKET_MIN_TTL_SECONDS = 60;

export type ClaimTicketStatus = "pending" | "consumed" | "expired";
export type EnrollmentStatus = "active" | "revoked";
export type InboxItemStatus = "pending" | "delivered" | "acked" | "webhook_queued";

export interface ClaimTicket {
  id: string;
  appId: string;
  ownerId: string;
  agentId: string;
  intent: AgentBridgeIntent;
  connectorHint: AgentBridgeConnector | null;
  tokenHash: string;
  status: ClaimTicketStatus;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface Enrollment {
  id: string;
  appId: string;
  ownerId: string;
  agentId: string;
  intent: AgentBridgeIntent;
  connector: AgentBridgeConnector;
  credentialId: string;
  credentialPrefix: string;
  status: EnrollmentStatus;
  ticketId: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface IntentJob {
  id: string;
  appId: string;
  enrollmentId: string;
  agentId: string;
  type: string;
  payload: string;
  status: "queued" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  id: string;
  appId: string;
  enrollmentId: string;
  jobId: string | null;
  kind: string;
  body: string;
  status: InboxItemStatus;
  createdAt: string;
  ackedAt: string | null;
}

export interface ScopedCredential {
  /** Shown once at enroll time. Never logged. */
  secret: string;
  credentialId: string;
  prefix: string;
  scopes: readonly string[];
  expiresAt: string | null;
}

export interface CreateTicketInput {
  appId: string;
  ownerId: string;
  agentId: string;
  intent: AgentBridgeIntent;
  connectorHint?: AgentBridgeConnector | null;
  /** Default 900 (15m). Cap 1800 (30m). Required expiry always set. */
  ttlSeconds?: number;
}

export interface EnrollInput {
  appId: string;
  ownerId: string;
  token: string;
  /** Must match ticket.agentId */
  agentId: string;
  /** Must match ticket.intent */
  intent: AgentBridgeIntent;
  connector: AgentBridgeConnector;
}

export interface SubmitIntentInput {
  appId: string;
  enrollmentId: string;
  agentId: string;
  type: string;
  payload: unknown;
}

export function isAgentBridgeConnector(value: unknown): value is AgentBridgeConnector {
  return typeof value === "string" && (AGENT_BRIDGE_CONNECTORS as readonly string[]).includes(value);
}

export function isAgentBridgeIntent(value: unknown): value is AgentBridgeIntent {
  return typeof value === "string" && (AGENT_BRIDGE_INTENTS as readonly string[]).includes(value);
}
