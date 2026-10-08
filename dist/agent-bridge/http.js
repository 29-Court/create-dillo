import {
  AGENT_BRIDGE_CONNECTORS,
  isAgentBridgeConnector,
  isAgentBridgeIntent
} from "./types.js";
import { AgentBridgeError } from "./store.js";
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
function markdown(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" }
  });
}
function errorResponse(error) {
  if (error instanceof AgentBridgeError) {
    return json(
      { error: { code: error.code, message: error.message, ...error.fields ? { fields: error.fields } : {} } },
      error.status
    );
  }
  return json({ error: { code: "INTERNAL_ERROR", message: "Unexpected agent-bridge error." } }, 500);
}
const AGENT_BRIDGE_MAX_BODY = 64e3;
async function readJson(request) {
  let bytes = 0;
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > AGENT_BRIDGE_MAX_BODY) {
    await request.body?.cancel().catch(() => void 0);
    throw new AgentBridgeError(413, "BAD_REQUEST", "Request body too large.");
  }
  if (!request.body) return {};
  let text;
  try {
    text = await new Response(request.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > AGENT_BRIDGE_MAX_BODY) {
          throw new AgentBridgeError(413, "BAD_REQUEST", "Request body too large.");
        }
        controller.enqueue(chunk);
      }
    }))).text();
  } catch (error) {
    if (error instanceof AgentBridgeError) throw error;
    throw new AgentBridgeError(413, "BAD_REQUEST", "Request body too large.");
  }
  if (text.length > AGENT_BRIDGE_MAX_BODY) throw new AgentBridgeError(413, "BAD_REQUEST", "Request body too large.");
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentBridgeError(400, "BAD_REQUEST", "JSON body is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentBridgeError(400, "BAD_REQUEST", "JSON object required.");
  }
  return parsed;
}
function pendingEnrollMarkdown(ticket, joinPath) {
  const connectors = ticket.connectorHint ? ticket.connectorHint : AGENT_BRIDGE_CONNECTORS.join(" | ");
  return [
    "# Agent Bridge \u2014 pending enrollment",
    "",
    `- **status:** pending-enroll`,
    `- **agent_id:** \`${ticket.agentId}\``,
    `- **intent:** \`${ticket.intent}\``,
    `- **expires_at:** ${ticket.expiresAt}`,
    `- **ticket_id:** \`${ticket.id}\``,
    `- **connectors:** ${connectors}`,
    `- **join:** \`${joinPath}\``,
    "",
    "## Next",
    "Owner approves via `POST /v1/enroll` (scoped-cred, owner session).",
    "Claim tickets are single-use, short-TTL, hash-at-rest \u2014 not durable chat/email secrets.",
    "",
    "## Bounds",
    "Sandbox/box only. No prod deploy. No live external webhook fan-out.",
    ""
  ].join("\n");
}
async function handleAgentBridgeRequest(request, options) {
  const url = new URL(request.url);
  const { pathname } = url;
  const { store, appId } = options;
  try {
    const joinMatch = pathname.match(/^\/join\/([^/]+)\/?$/);
    if (joinMatch && (request.method === "GET" || request.method === "HEAD")) {
      const token = decodeURIComponent(joinMatch[1]);
      const ticket = await store.getTicketByToken(appId, token);
      if (!ticket || ticket.status !== "pending") {
        return markdown("# Agent Bridge\n\nClaim ticket is not available for enrollment.\n", 404);
      }
      const body = pendingEnrollMarkdown(ticket, pathname);
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" }
        });
      }
      return markdown(body);
    }
    if (pathname === "/v1/enroll/tickets" && request.method === "POST") {
      if (!options.ownerId) throw new AgentBridgeError(401, "UNAUTHENTICATED", "Owner session required.");
      const body = await readJson(request);
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      const intent = body.intent;
      if (!isAgentBridgeIntent(intent)) {
        throw new AgentBridgeError(422, "VALIDATION_ERROR", "intent is invalid.", {
          intent: "Use bridge_enroll_v0"
        });
      }
      const connectorHint = body.connectorHint === void 0 || body.connectorHint === null ? null : body.connectorHint;
      if (connectorHint !== null && !isAgentBridgeConnector(connectorHint)) {
        throw new AgentBridgeError(422, "VALIDATION_ERROR", "connectorHint is invalid.");
      }
      const ttlRaw = body.ttlSeconds === void 0 ? void 0 : Number(body.ttlSeconds);
      const ttlSeconds = ttlRaw !== void 0 && Number.isFinite(ttlRaw) ? ttlRaw : void 0;
      const { ticket, token } = await store.createTicket({
        appId,
        ownerId: options.ownerId,
        agentId,
        intent,
        connectorHint,
        ...ttlSeconds === void 0 ? {} : { ttlSeconds }
      });
      return json({
        ticket: {
          id: ticket.id,
          agentId: ticket.agentId,
          intent: ticket.intent,
          connectorHint: ticket.connectorHint,
          status: ticket.status,
          expiresAt: ticket.expiresAt,
          createdAt: ticket.createdAt,
          joinPath: `/join/${token}`
        },
        // Plaintext once; sandbox flag required to echo (Detail L1 / R5).
        ...options.sandbox ? { token } : {},
        message: options.sandbox ? "Sandbox: token returned once. Store hash-at-rest only; do not paste into chat/email as a durable secret." : "Token delivered via configured short-lived channel (not returned in non-sandbox responses)."
      }, 201);
    }
    if (pathname === "/v1/enroll" && request.method === "POST") {
      if (!options.ownerId) throw new AgentBridgeError(401, "UNAUTHENTICATED", "Owner session required.");
      const body = await readJson(request);
      const token = typeof body.token === "string" ? body.token : "";
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      const intent = body.intent;
      const connector = body.connector;
      if (!token) throw new AgentBridgeError(422, "VALIDATION_ERROR", "token is required.");
      if (!isAgentBridgeIntent(intent)) {
        throw new AgentBridgeError(422, "VALIDATION_ERROR", "intent is invalid.");
      }
      if (!isAgentBridgeConnector(connector)) {
        throw new AgentBridgeError(422, "VALIDATION_ERROR", "connector is invalid.");
      }
      const { enrollment, credential } = await store.enroll({
        appId,
        ownerId: options.ownerId,
        token,
        agentId,
        intent,
        connector
      });
      return json({
        enrollment: {
          id: enrollment.id,
          agentId: enrollment.agentId,
          intent: enrollment.intent,
          connector: enrollment.connector,
          status: enrollment.status,
          createdAt: enrollment.createdAt
        },
        credential: {
          secret: credential.secret,
          credentialId: credential.credentialId,
          prefix: credential.prefix,
          scopes: credential.scopes,
          expiresAt: credential.expiresAt
        },
        message: "Scoped credential shown once. Hash-at-rest thereafter; no external webhook send in v0."
      }, 201);
    }
    if (pathname === "/v1/intents" && request.method === "POST") {
      if (!options.bridgeSecret) throw new AgentBridgeError(401, "UNAUTHENTICATED", "Bridge credential required.");
      const enrollment = await store.resolveCredential(appId, options.bridgeSecret);
      if (!enrollment) throw new AgentBridgeError(401, "UNAUTHENTICATED", "Bridge credential required.");
      const body = await readJson(request);
      const type = typeof body.type === "string" ? body.type : "";
      const job = await store.submitIntent({
        appId,
        enrollmentId: enrollment.id,
        agentId: enrollment.agentId,
        type,
        payload: body.payload ?? {}
      });
      return json({ job_id: job.id, status: job.status, connector: enrollment.connector }, 201);
    }
    if (pathname === "/v1/inbox" && request.method === "GET") {
      if (!options.bridgeSecret) throw new AgentBridgeError(401, "UNAUTHENTICATED", "Bridge credential required.");
      const enrollment = await store.resolveCredential(appId, options.bridgeSecret);
      if (!enrollment) throw new AgentBridgeError(401, "UNAUTHENTICATED", "Bridge credential required.");
      const after = url.searchParams.get("after") ?? void 0;
      const limitRaw = url.searchParams.get("limit");
      const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : void 0;
      const limit = limitParsed !== void 0 && Number.isFinite(limitParsed) ? limitParsed : void 0;
      const items = await store.listInbox(appId, enrollment.id, {
        ...after === void 0 ? {} : { after },
        ...limit === void 0 ? {} : { limit }
      });
      return json({
        connector: enrollment.connector,
        enrollmentId: enrollment.id,
        items: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          status: item.status,
          jobId: item.jobId,
          body: JSON.parse(item.body),
          createdAt: item.createdAt,
          ackedAt: item.ackedAt
        }))
      });
    }
    return void 0;
  } catch (error) {
    return errorResponse(error);
  }
}
export {
  handleAgentBridgeRequest,
  pendingEnrollMarkdown
};
