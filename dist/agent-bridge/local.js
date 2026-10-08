import { sha256 } from "../engine/helpers/crypto.js";
import { cookieValue, sessionCookieName } from "../engine/sessions.js";
import {
  handleAgentBridgeRequest
} from "./http.js";
import { MemoryAgentBridgeStore } from "./store.js";
function bridgeSecretFromRequest(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  const token = match?.[1];
  if (token && token.startsWith("abr_") && token.length <= 1024) return token;
  return void 0;
}
function ownerSessionCredential(request, appId) {
  const authorization = request.headers.get("authorization") ?? "";
  if (request.headers.has("authorization")) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    const token = match?.[1];
    if (!token || token.length > 1024 || token.startsWith("abr_")) return void 0;
    return token;
  }
  return cookieValue(request, sessionCookieName(appId));
}
async function resolveOwnerIdFromSqliteSession(request, appId, lookup) {
  const credential = ownerSessionCredential(request, appId);
  if (!credential) return void 0;
  const tokenHash = await sha256(credential);
  return lookup(tokenHash, (/* @__PURE__ */ new Date()).toISOString());
}
async function handleAgentBridgeLocalRequest(request, options) {
  const ownerId = await options.resolveOwnerId(request);
  const bridgeSecret = bridgeSecretFromRequest(request);
  const httpOptions = {
    store: options.store,
    appId: options.appId,
    // sandbox flag ONLY when caller asserts DEV sandbox
    ...options.sandbox ? { sandbox: true } : { sandbox: false },
    ...ownerId ? { ownerId } : {},
    ...bridgeSecret ? { bridgeSecret } : {}
  };
  return handleAgentBridgeRequest(request, httpOptions);
}
function createLocalAgentBridgeStore() {
  return new MemoryAgentBridgeStore();
}
export {
  bridgeSecretFromRequest,
  createLocalAgentBridgeStore,
  handleAgentBridgeLocalRequest,
  ownerSessionCredential,
  resolveOwnerIdFromSqliteSession
};
