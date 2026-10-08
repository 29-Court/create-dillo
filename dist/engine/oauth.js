import { INTERNAL_TABLES } from "../backend.js";
import { HttpError } from "./http.js";
import { passwordIterations } from "./http.js";
import { sessionLifetimeMs } from "./http.js";
import { sha256 } from "./helpers/crypto.js";
import { base64Url } from "./helpers/id.js";
import { makeId } from "./helpers/id.js";
import { randomBytes } from "./helpers/id.js";
import { now } from "./records.js";
import { normalizeEmail } from "./auth.js";
import { enforceRateLimit } from "./auth.js";
import { createSessionToken } from "./sessions.js";
import { sessionCookieHeader } from "./sessions.js";
import { cookieValue } from "./sessions.js";
import { secureCookieSuffix } from "./sessions.js";
import { boundedBody } from "./body.js";
import { constantTimeEqual } from "./helpers/crypto.js";
import { signInProviders } from "../requirements.js";
const encoder = new TextEncoder();
function applicationOrigin(request, env) {
  const configured = env.ARMADILLO_PUBLIC_URL?.trim();
  if (configured) {
    let parsed;
    try {
      parsed = new URL(configured);
    } catch {
      throw new HttpError(500, "INTERNAL_ERROR", "ARMADILLO_PUBLIC_URL is not a valid absolute URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new HttpError(500, "INTERNAL_ERROR", "ARMADILLO_PUBLIC_URL must be an http(s) URL.");
    }
    return parsed.origin;
  }
  return new URL(request.url).origin;
}
const OAUTH_STATE_COOKIE = "armadillo_oauth_state";
function oauthStateCookieHeader(request, state, env) {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secureCookieSuffix(request, env)}`;
}
function clearOauthStateCookie(request, env) {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix(request, env)}`;
}
function oauthStateFromCookie(request) {
  const value = cookieValue(request, OAUTH_STATE_COOKIE);
  return value && value.length >= 16 && value.length <= 256 ? value : void 0;
}
function callbackUrl(request, env, path) {
  return new URL(path, `${applicationOrigin(request, env)}/`).toString();
}
function envString(env, key) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}
function providerCredentials(env, provider) {
  const clientId = provider.requirements.find((field) => field.type === "config");
  const clientSecret = provider.requirements.find((field) => field.type === "secret");
  return {
    clientId: clientId ? envString(env, clientId.key) : "",
    clientSecret: clientSecret ? envString(env, clientSecret.key) : ""
  };
}
function safeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("\n") || value.length > 512) {
    return "/burrow";
  }
  return value;
}
async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64Url(new Uint8Array(digest));
}
function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function readProviderProfile(profile, payload) {
  if (!payload || typeof payload !== "object") return void 0;
  const body = payload;
  let subject = "";
  if (profile === "oidc") subject = clip(body.sub, 1024);
  else if (typeof body.id === "number" && Number.isSafeInteger(body.id)) subject = String(body.id);
  else subject = clip(body.id, 1024);
  const email = normalizeEmail(body.email);
  const name = clip(body.name, 120) || (profile === "github" ? clip(body.login, 120) : "");
  if (!subject || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return void 0;
  return { subject, email, emailVerified: body.email_verified === true, name: name || null };
}
async function readJsonBody(response, maximum = 64 * 1024) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel().catch(() => void 0);
    return void 0;
  }
  if (!response.body) return void 0;
  const text = await new Response(boundedBody(response.body, maximum)).text();
  if (!text) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
async function providerRequest(url, init) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new HttpError(500, "INTERNAL_ERROR", "The identity provider endpoint must use HTTPS.");
  }
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(8e3) });
}
function findProvider(definition, id) {
  return signInProviders(definition.auth).find((provider) => provider.id === id);
}
async function oauthLogin(request, env, currentAppId, definition, id) {
  const provider = findProvider(definition, id);
  if (!provider) throw new HttpError(404, "NOT_FOUND", "That sign-in method is not declared.");
  await enforceRateLimit(request, env, currentAppId, "oauth-login", 20, 15 * 60);
  const { clientId, clientSecret } = providerCredentials(env, provider);
  if (!clientId || !clientSecret) {
    throw new HttpError(409, "CONFLICT", `${provider.label} is not configured yet. Add its credentials in Burrow.`);
  }
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(32));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1e3).toISOString();
  const redirectPath = safeNext(new URL(request.url).searchParams.get("next"));
  await env.DB.prepare(
    `DELETE FROM ${INTERNAL_TABLES.oauthStates} WHERE app_id = ?1 AND expires_at <= ?2`
  ).bind(currentAppId, now()).run();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.oauthStates}
       (app_id, state_hash, provider, verifier, redirect_path, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(currentAppId, await sha256(state), provider.id, verifier, redirectPath, expiresAt, now()).run();
  const destination = new URL(provider.authorizeUrl);
  destination.searchParams.set("response_type", "code");
  destination.searchParams.set("client_id", clientId);
  destination.searchParams.set("redirect_uri", callbackUrl(request, env, provider.callbackPath));
  destination.searchParams.set("scope", provider.scopes);
  destination.searchParams.set("state", state);
  destination.searchParams.set("code_challenge", await codeChallenge(verifier));
  destination.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      // Bind this authorization attempt to this browser. The callback must
      // present the same nonce, so a callback URL cannot be replayed into
      // someone else's session.
      "set-cookie": oauthStateCookieHeader(request, state, env)
    }
  });
}
async function openSession(env, currentAppId, userId, providerId, name) {
  const token = createSessionToken();
  const timestamp = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
  const statements = [];
  if (name) {
    statements.push(env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.users} SET name = ?1, updated_at = ?2 WHERE app_id = ?3 AND id = ?4`
    ).bind(name, timestamp, currentAppId, userId));
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.sessions}
         (app_id, id, token_hash, user_id, created_at, expires_at, auth_method)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'oauth')`
    ).bind(currentAppId, makeId("session"), await sha256(token), userId, timestamp, expiresAt),
    env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.audit}
         (app_id, id, actor_id, action, subject, created_at)
       VALUES (?1, ?2, ?3, 'auth.login', ?4, ?5)`
    ).bind(currentAppId, makeId("audit"), userId, providerId, timestamp)
  );
  await env.DB.batch(statements);
  return { token, expiresAt };
}
function redirectSession(request, currentAppId, path, token, expiresAt, env) {
  return new Response(null, {
    status: 302,
    headers: [
      ["location", path],
      ["cache-control", "no-store"],
      ["set-cookie", sessionCookieHeader(request, currentAppId, token, expiresAt, env)],
      // The state nonce has served its purpose; drop it so it cannot be reused.
      ["set-cookie", clearOauthStateCookie(request, env)]
    ]
  });
}
async function oauthCallback(request, env, currentAppId, definition, id) {
  const provider = findProvider(definition, id);
  if (!provider) throw new HttpError(404, "NOT_FOUND", "That sign-in method is not declared.");
  await enforceRateLimit(request, env, currentAppId, "oauth-callback", 30, 15 * 60);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || state.length > 512 || !code || code.length > 2048) {
    throw new HttpError(400, "BAD_REQUEST", "The sign-in attempt expired or was already used.");
  }
  const presented = oauthStateFromCookie(request);
  if (!presented || !constantTimeEqual(presented, state)) {
    throw new HttpError(400, "BAD_REQUEST", "The sign-in attempt expired or was already used.");
  }
  const consumed = await env.DB.prepare(
    `DELETE FROM ${INTERNAL_TABLES.oauthStates}
      WHERE app_id = ?1 AND state_hash = ?2 AND provider = ?3 AND expires_at > ?4
      RETURNING verifier, redirect_path`
  ).bind(currentAppId, await sha256(state), provider.id, now()).first();
  if (!consumed) throw new HttpError(400, "BAD_REQUEST", "The sign-in attempt expired or was already used.");
  const { clientId, clientSecret } = providerCredentials(env, provider);
  if (!clientId || !clientSecret) {
    throw new HttpError(409, "CONFLICT", `${provider.label} is not configured yet. Add its credentials in Burrow.`);
  }
  let tokenPayload;
  try {
    const tokenResponse = await providerRequest(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(request, env, provider.callbackPath),
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: consumed.verifier
      })
    });
    tokenPayload = await readJsonBody(tokenResponse);
    const accessToken = tokenPayload && typeof tokenPayload === "object" ? tokenPayload.access_token : void 0;
    if (!tokenResponse.ok || typeof accessToken !== "string" || !accessToken) {
      throw new HttpError(401, "UNAUTHENTICATED", "The identity provider rejected the sign-in.");
    }
    const profileResponse = await providerRequest(provider.userInfoUrl, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` }
    });
    const profile = readProviderProfile(provider.profile, await readJsonBody(profileResponse));
    if (!profileResponse.ok || !profile) {
      throw new HttpError(401, "UNAUTHENTICATED", "The identity provider rejected the sign-in.");
    }
    const identity = await env.DB.prepare(
      `SELECT user_id FROM ${INTERNAL_TABLES.identities}
        WHERE app_id = ?1 AND provider = ?2 AND subject = ?3 LIMIT 1`
    ).bind(currentAppId, provider.id, profile.subject).first();
    if (identity) {
      const session = await openSession(env, currentAppId, identity.user_id, provider.id, profile.name);
      return redirectSession(request, currentAppId, consumed.redirect_path, session.token, session.expiresAt, env);
    }
    const existing = await env.DB.prepare(
      `SELECT id FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND email = ?2 LIMIT 1`
    ).bind(currentAppId, profile.email).first();
    if (existing && !profile.emailVerified) {
      throw new HttpError(409, "CONFLICT", "An account with that email already exists.");
    }
    const timestamp = now();
    const userId = existing?.id ?? makeId("user");
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
    const statements = [];
    if (!existing) {
      statements.push(env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.users}
           (app_id, id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`
      ).bind(
        currentAppId,
        userId,
        profile.email,
        profile.name,
        base64Url(randomBytes(32)),
        base64Url(randomBytes(18)),
        passwordIterations(env),
        timestamp
      ));
    } else if (profile.name) {
      statements.push(env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET name = ?1, updated_at = ?2 WHERE app_id = ?3 AND id = ?4`
      ).bind(profile.name, timestamp, currentAppId, userId));
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.identities}
           (app_id, provider, subject, user_id, email, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
      ).bind(currentAppId, provider.id, profile.subject, userId, profile.email, timestamp),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.sessions}
           (app_id, id, token_hash, user_id, created_at, expires_at, auth_method)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'oauth')`
      ).bind(currentAppId, makeId("session"), await sha256(token), userId, timestamp, expiresAt),
      env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.audit}
           (app_id, id, actor_id, action, subject, created_at)
         VALUES (?1, ?2, ?3, 'auth.login', ?4, ?5)`
      ).bind(currentAppId, makeId("audit"), userId, provider.id, timestamp)
    );
    try {
      await env.DB.batch(statements);
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
      const winner = await env.DB.prepare(
        `SELECT user_id FROM ${INTERNAL_TABLES.identities}
          WHERE app_id = ?1 AND provider = ?2 AND subject = ?3 LIMIT 1`
      ).bind(currentAppId, provider.id, profile.subject).first();
      if (!winner) throw new HttpError(409, "CONFLICT", "An account with that email already exists.");
      const session = await openSession(env, currentAppId, winner.user_id, provider.id, profile.name);
      return redirectSession(request, currentAppId, consumed.redirect_path, session.token, session.expiresAt, env);
    }
    return redirectSession(request, currentAppId, consumed.redirect_path, token, expiresAt, env);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "UNAUTHENTICATED", "The identity provider rejected the sign-in.");
  }
}
async function verifySignIn(request, env, provider) {
  const { clientId, clientSecret } = providerCredentials(env, provider);
  if (!clientId || !clientSecret) {
    return { id: provider.id, ok: false, message: `${provider.label} is missing credentials.` };
  }
  try {
    const response = await providerRequest(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "armadillo-verify",
        redirect_uri: callbackUrl(request, env, provider.callbackPath),
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: "verify"
      })
    });
    const payload = await readJsonBody(response);
    const error = payload && typeof payload === "object" ? payload.error : void 0;
    if (response.ok || response.status === 400 && error === "invalid_grant") return { id: provider.id, ok: true };
    return { id: provider.id, ok: false, message: `${provider.label} did not accept the credentials.` };
  } catch {
    return { id: provider.id, ok: false, message: `${provider.label} could not be reached.` };
  }
}
export {
  OAUTH_STATE_COOKIE,
  applicationOrigin,
  callbackUrl,
  clearOauthStateCookie,
  oauthCallback,
  oauthLogin,
  oauthStateCookieHeader,
  oauthStateFromCookie,
  readProviderProfile,
  verifySignIn
};
