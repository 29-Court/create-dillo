// Dillo Vault — Worker `29court-vault` (service-binding broker).
// Reached only through the in-account service binding (consumers bind it
// as SVC_VAULT); no public route in v1. It serves no UI except the plain-
// words OAuth success/failure pages on the callback.
//
// BINDINGS (names only — no secret value in any file):
//   DB         D1 `29court` (the ONE physical D1; birth act still owed —
//              the local proof runs against wrangler dev's real miniflare
//              D1 engine)
//   VAULT_KEK  Secrets Store secret `vault-master-kek`, by reference.
//              Absent KEK ⇒ every call fails closed (503 vault-unreachable).
//   VAULT_TEST_DOUBLE  "1" ONLY in local proof mode (mock grants), never live.
//
// PUBLISHED CONTRACT (F-01/F-06, restated from the Flows side):
//   POST /vault/secret-state  {tenant, owner, name}          -> {state, fingerprint, last4, checkedAt}
//   POST /vault/present       — 403 not-granted BY CONTRACT (in-process only)
//   POST /vault/oauth/fetch   {tenant, owner, name, purpose} -> {accessToken, expiresAt, account, tokenType}
//   POST /vault/oauth/status  {tenant, owner, name}          (never refreshes)
//   POST /vault/revoke        {tenant, owner, name}
//   POST /vault/save          {tenant, owner, name, kind, host, value, ...}
//   POST /vault/get           {tenant, owner, secretId}
//   POST /vault/rotate        {tenant, owner, name}
//   POST /vault/grant         {tenant, owner, caller, callerSecret, name, operation}
//   POST /vault/oauth/start   {tenant, owner, provider, name, scopes?}
//   POST /vault/oauth/refresh {tenant, owner, name, purpose}
//   GET  /oauth/:provider/callback?code&state  — NO session check (identity from state)
//   GET  /health
// Attestation headers on every call: x-vault-tenant, x-vault-owner,
// x-vault-recovery, x-vault-session-hash. A bound Worker may additionally
// identify itself as a caller (x-vault-caller + x-vault-caller-secret);
// value paths then require a matching dillo_vault_grants row. Typed errors
// {ok:false, error:{code, message}}.
import { createVault, VaultError } from "./src/vault.mjs";
import { makeTestDoubleProvider } from "./src/providers.mjs";

const MAX_BODY_BYTES = 64 * 1024; // oversized-payload floor, fail closed

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function errJson(e, requestId) {
  if (e instanceof VaultError) {
    return json({ ok: false, error: { code: e.code, message: e.message } }, e.status);
  }
  // D-3: log the constructor name + a request id, NEVER e.message (a V8
  // SyntaxError message can embed a secret's plaintext prefix).
  const name = e && e.constructor && e.constructor.name ? e.constructor.name : "Error";
  console.error(`vault internal error (${name}) request ${requestId}`);
  return json({ ok: false, error: { code: "internal", message: "Something went wrong on our side." } }, 500);
}

function successPage(account) {
  const a = String(account || "").replace(/[<>&"']/g, "");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Connected</title>` +
      `<body style="font-family:system-ui,sans-serif;padding:32px;max-width:480px;margin:auto">` +
      `<h1>Connected</h1><p>Your account ${a} is connected. You can close this tab.</p></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function failurePage() {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Not connected</title>` +
      `<body style="font-family:system-ui,sans-serif;padding:32px;max-width:480px;margin:auto">` +
      `<h1>No account was connected</h1><p>Go back and start again.</p></body>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function attestation(request) {
  const h = request.headers;
  const tenant = h.get("x-vault-tenant") || "";
  const owner = h.get("x-vault-owner") || "";
  if (!tenant || !owner) return null;
  return {
    tenant, owner,
    recovery: h.get("x-vault-recovery") === "1",
    sessionHash: h.get("x-vault-session-hash") || "",
    // D-1: a bound Worker may identify itself as a distinct caller; the
    // grant boundary in vault.mjs compares these against dillo_vault_grants.
    callerId: h.get("x-vault-caller") || "",
    callerSecret: h.get("x-vault-caller-secret") || "",
  };
}

let errSeq = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestId = `${Date.now().toString(36)}-${(errSeq++).toString(36)}`;
    const testDouble = env.VAULT_TEST_DOUBLE === "1" ? makeTestDoubleProvider() : null;
    const vault = createVault(env.DB, env, { testDouble });

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "29court-vault", testDouble: !!testDouble });
    }

    // Absent KEK ⇒ every call fails closed, before any routing or body read.
    if (!env.VAULT_KEK) {
      return json({ ok: false, error: { code: "vault-unreachable", message: "vault key unavailable" } }, 503);
    }

    // OAuth callback: NO session check by design — identity comes from the
    // state row, not a cookie.
    const cb = url.pathname.match(/^\/oauth\/([^/]+)\/callback$/);
    if (cb && request.method === "GET") {
      const out = await vault.oauth.complete({
        provider: cb[1],
        code: url.searchParams.get("code") || "",
        state: url.searchParams.get("state") || "",
        error: url.searchParams.get("error") || "",
      });
      if (!out.ok) return failurePage();
      return successPage(out.account);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: { code: "bad-request", message: "POST only" } }, 405);
    }

    const actor = attestation(request);
    if (!actor) {
      return json({ ok: false, error: { code: "no-session", message: "Not signed in." } }, 401);
    }

    let body = {};
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return json({ ok: false, error: { code: "bad-request", message: "payload too large" } }, 413);
      }
      body = text ? JSON.parse(text) : {};
    } catch {
      return json({ ok: false, error: { code: "bad-request", message: "bad JSON" } }, 400);
    }

    try {
      switch (url.pathname) {
        case "/vault/save":
          return json({ ok: true, ...(await vault.save({ ...body, actor })) });
        case "/vault/secret-state":
          return json({ ok: true, ...(await vault.secretState({ ...body, actor })) });
        case "/vault/get":
          return json({ ok: true, ...(await vault.get({ ...body, actor })) });
        case "/vault/present":
          return errJson(await vault.present(), requestId);
        case "/vault/rotate":
          return json({ ok: true, ...(await vault.rotate({ ...body, actor })) });
        case "/vault/grant":
          return json({ ok: true, ...(await vault.grant({ ...body, actor })) });
        case "/vault/revoke":
          return json({ ok: true, ...(await vault.revoke({ ...body, actor })) });
        case "/vault/oauth/start":
          return json({ ok: true, ...(await vault.oauth.start({ ...body, actor })) });
        case "/vault/oauth/fetch":
          return json({ ok: true, ...(await vault.oauth.fetch({ ...body, actor })) });
        case "/vault/oauth/status":
          return json({ ok: true, ...(await vault.oauth.status({ ...body, actor })) });
        case "/vault/oauth/refresh":
          return json({ ok: true, ...(await vault.oauth.fetch({ ...body, actor })) });
        default:
          return json({ ok: false, error: { code: "bad-request", message: "unknown route" } }, 404);
      }
    } catch (e) {
      return errJson(e, requestId);
    }
  },
};
