/**
 * Agent Bridge enrollment v0 (enroll-build-001).
 * Dedicated claim-ticket surface — do not overload /v1/tickets.
 */
export {
  AGENT_BRIDGE_CONNECTORS,
  AGENT_BRIDGE_INTENTS,
  CLAIM_TICKET_DEFAULT_TTL_SECONDS,
  CLAIM_TICKET_MAX_TTL_SECONDS,
  isAgentBridgeConnector,
  isAgentBridgeIntent,
  type AgentBridgeConnector,
  type AgentBridgeIntent,
  type ClaimTicket,
  type CreateTicketInput,
  type EnrollInput,
  type Enrollment,
  type InboxItem,
  type IntentJob,
  type ScopedCredential,
  type SubmitIntentInput,
} from "./types.js";

export {
  AgentBridgeError,
  MemoryAgentBridgeStore,
  type AgentBridgeStore,
} from "./store.js";

export {
  handleAgentBridgeRequest,
  pendingEnrollMarkdown,
  type AgentBridgeHttpOptions,
} from "./http.js";

export {
  bridgeSecretFromRequest,
  createLocalAgentBridgeStore,
  handleAgentBridgeLocalRequest,
  ownerSessionCredential,
  resolveOwnerIdFromSqliteSession,
  type AgentBridgeLocalOptions,
} from "./local.js";
