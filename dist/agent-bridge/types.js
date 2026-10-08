const AGENT_BRIDGE_CONNECTORS = ["muse-poll", "grok-webhook", "generic-manual"];
const AGENT_BRIDGE_INTENTS = ["bridge_enroll_v0"];
const CLAIM_TICKET_DEFAULT_TTL_SECONDS = 15 * 60;
const CLAIM_TICKET_MAX_TTL_SECONDS = 30 * 60;
const CLAIM_TICKET_MIN_TTL_SECONDS = 60;
function isAgentBridgeConnector(value) {
  return typeof value === "string" && AGENT_BRIDGE_CONNECTORS.includes(value);
}
function isAgentBridgeIntent(value) {
  return typeof value === "string" && AGENT_BRIDGE_INTENTS.includes(value);
}
export {
  AGENT_BRIDGE_CONNECTORS,
  AGENT_BRIDGE_INTENTS,
  CLAIM_TICKET_DEFAULT_TTL_SECONDS,
  CLAIM_TICKET_MAX_TTL_SECONDS,
  CLAIM_TICKET_MIN_TTL_SECONDS,
  isAgentBridgeConnector,
  isAgentBridgeIntent
};
