import { base64Url } from "./helpers/id.js";
import { randomBytes } from "./helpers/id.js";
import {} from "../backend.js";
import {} from "../schema.js";
import { json } from "./http.js";
import {} from "./environment.js";
import {} from "./mail.js";
import { now } from "./records.js";
import { INTERNAL_TABLES } from "../backend.js";
import { sha256 } from "./helpers/crypto.js";
import { deliverMail } from "./mail.js";
import { HttpError } from "./http.js";
import { readJson } from "./validation.js";
import { normalizeEmail } from "./auth.js";
import { enforceRateLimit } from "./auth.js";
import { profileJsonForCreate, profileConflict } from "./auth.js";
import {} from "../backend.js";
import { makeId } from "./helpers/id.js";
import { passwordIterations } from "./http.js";
import { passwordHash } from "./helpers/crypto.js";
import { magicLinkLifetimeMs } from "./http.js";
import { safeRedirect } from "./auth.js";
import { renderTransactionalEmail } from "./mail.js";
import { sessionLifetimeMs } from "./http.js";
import { userJson } from "./records.js";
const SESSION_TOKEN_PREFIX = "arm_session_";
function createSessionToken() {
  return `${SESSION_TOKEN_PREFIX}${base64Url(randomBytes(32))}`;
}
function sessionCookieName(appId) {
  return `armadillo_session_${appId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
function secureCookieSuffix(request, env) {
  const configured = env?.ARMADILLO_PUBLIC_URL?.trim();
  if (configured) {
    try {
      if (new URL(configured).protocol === "https:") return "; Secure";
    } catch {
    }
  }
  return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}
function sessionCookieHeader(request, appId, token, expiresAt, env) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1e3));
  const secure = secureCookieSuffix(request, env);
  return `${sessionCookieName(appId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function cookieValue(request, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`).exec(request.headers.get("cookie") ?? "")?.[1];
}
function requestedSessionMode(request) {
  const mode = request.headers.get("x-armadillo-auth-mode");
  return mode === "cookie" || mode === "token" ? mode : void 0;
}
function sessionResponse(request, appId, user, token, expiresAt, status = 200, extra = {}, env) {
  const mode = requestedSessionMode(request);
  if (mode === "token") return json({ user, token, expiresAt, ...extra }, status);
  return new Response(JSON.stringify({ user, expiresAt, ...extra }), {
    status,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookieHeader(request, appId, token, expiresAt, env)
    }
  });
}
function clearSessionCookie(request, appId, env) {
  const secure = secureCookieSuffix(request, env);
  return `${sessionCookieName(appId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
async function enqueueMail(env, currentAppId, job) {
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.mailJobs}
       (app_id, id, kind, recipient_hash, status, attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, ?5)`
  ).bind(currentAppId, job.id, job.kind, await sha256(job.to), timestamp).run();
  try {
    if (env.MAIL_QUEUE) {
      await env.MAIL_QUEUE.send(job);
    } else {
      await deliverMail(job, env);
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.mailJobs} SET status = 'sent', attempts = 1, updated_at = ?1
          WHERE app_id = ?2 AND id = ?3`
      ).bind(now(), currentAppId, job.id).run();
    }
  } catch (error) {
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.mailJobs}
          SET status = 'failed', attempts = attempts + 1, last_error = ?1, updated_at = ?2
        WHERE app_id = ?3 AND id = ?4`
    ).bind(String(error).slice(0, 500), now(), currentAppId, job.id).run();
    throw new HttpError(503, "INTERNAL_ERROR", "The sign-in email could not be queued. Try again shortly.");
  }
}
async function requestMagicLink(request, env, currentAppId, schema) {
  const body = await readJson(request, env);
  const email = normalizeEmail(body.email);
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new HttpError(422, "VALIDATION_ERROR", "Email is invalid.", { email: "Enter a valid email address" });
  }
  await enforceRateLimit(request, env, currentAppId, "magic-link", 5, 15 * 60, await sha256(email));
  let user = await env.DB.prepare(
    `SELECT id, email, name, password_hash, password_salt, password_iterations,
            password_enabled, profile, created_at, updated_at
       FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND email = ?2 LIMIT 1`
  ).bind(currentAppId, email).first();
  const signupMode = env.ARMADILLO_SIGNUP_MODE?.trim().toLowerCase() || "closed";
  if (!user && signupMode === "open") {
    await enforceRateLimit(request, env, currentAppId, "magic-link-global", 100, 15 * 60);
    const createdAt2 = now();
    const userId = makeId("user");
    const salt = base64Url(randomBytes(18));
    const iterations = passwordIterations(env);
    const unusablePassword = await passwordHash(base64Url(randomBytes(48)), salt, iterations);
    const profileJson = await profileJsonForCreate(env, currentAppId, body, ["email", "redirectTo", "password", "name"], schema);
    if (profileJson !== void 0) {
      try {
        await env.DB.prepare(
          `INSERT INTO ${INTERNAL_TABLES.users}
             (app_id, id, email, name, password_hash, password_salt, password_iterations,
              password_enabled, profile, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 0, ?7, ?8, ?8)`
        ).bind(currentAppId, userId, email, unusablePassword, salt, iterations, profileJson, createdAt2).run();
      } catch (error) {
        const conflict = profileConflict(error);
        if (conflict) throw conflict;
        if (!String(error).toLowerCase().includes("unique")) throw error;
      }
    }
    user = await env.DB.prepare(
      `SELECT id, email, name, password_hash, password_salt, password_iterations,
              password_enabled, profile, created_at, updated_at
         FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND email = ?2 LIMIT 1`
    ).bind(currentAppId, email).first();
  }
  if (!user) return json({ queued: true }, 202);
  const token = base64Url(randomBytes(32));
  const linkId = makeId("magic");
  const createdAt = now();
  const expiresAt = new Date(Date.now() + magicLinkLifetimeMs(env)).toISOString();
  const redirect = new URL(safeRedirect(request, env, body.redirectTo));
  redirect.searchParams.set("armadillo_magic_token", token);
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.magicLinks}
       (app_id, id, token_hash, user_id, requested_email, redirect_url, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(currentAppId, linkId, await sha256(token), user.id, email, redirect.toString(), createdAt, expiresAt).run();
  const emailContent = renderTransactionalEmail({
    appName: env.ARMADILLO_MAIL_BRAND_NAME?.trim() || "Armadillo",
    ...env.ARMADILLO_MAIL_ACCENT_COLOR ? { accentColor: env.ARMADILLO_MAIL_ACCENT_COLOR } : {},
    eyebrow: "Secure sign-in",
    heading: "Your sign-in link is ready",
    intro: "Use this secure link to sign in. No password is needed.",
    ctaLabel: "Sign in securely",
    ctaUrl: redirect.toString(),
    detail: `This link expires in ${Math.round(magicLinkLifetimeMs(env) / 6e4)} minutes and works once.`
  });
  const job = {
    version: 1,
    id: makeId("mail"),
    appId: currentAppId,
    kind: "magic_link",
    to: email,
    from: env.ARMADILLO_MAIL_FROM?.trim() || "Armadillo <noreply@localhost>",
    subject: `Your secure ${env.ARMADILLO_MAIL_BRAND_NAME?.trim() || "Armadillo"} sign-in link`,
    text: emailContent.text,
    html: emailContent.html,
    createdAt
  };
  await enqueueMail(env, currentAppId, job);
  const exposeToken = env.ARMADILLO_DEV_MODE === "1" && env.ARMADILLO_EXPOSE_DEBUG_TOKENS === "1";
  return json({ queued: true, ...exposeToken ? { debugToken: token } : {} }, 202);
}
function isErasedTombstone(email) {
  return typeof email === "string" && (email.startsWith("erased_") || email.startsWith("anon_")) && email.endsWith("@deleted.local");
}
async function verifyMagicLink(request, env, currentAppId) {
  const body = await readJson(request, env);
  const token = typeof body.token === "string" ? body.token : "";
  if (token.length < 32 || token.length > 1024) {
    throw new HttpError(401, "UNAUTHENTICATED", "Magic link is invalid or expired.");
  }
  await enforceRateLimit(request, env, currentAppId, "magic-verify", 10, 15 * 60);
  const tokenHash = await sha256(token);
  const sessionToken = createSessionToken();
  const sessionId = makeId("session");
  const timestamp = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(env)).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.magicLinks}
          SET consumed_at = ?1, consumed_by_session = ?2
        WHERE app_id = ?3 AND token_hash = ?4 AND consumed_at IS NULL AND expires_at > ?1`
    ).bind(timestamp, sessionId, currentAppId, tokenHash),
    env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.sessions}
         (app_id, id, token_hash, user_id, created_at, expires_at, auth_method)
       SELECT app_id, ?1, ?2, user_id, ?3, ?4, 'magic_link'
         FROM ${INTERNAL_TABLES.magicLinks}
        WHERE app_id = ?5 AND token_hash = ?6 AND consumed_by_session = ?1`
    ).bind(sessionId, await sha256(sessionToken), timestamp, expiresAt, currentAppId, tokenHash)
  ]);
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.password_hash, u.password_salt, u.password_iterations,
            u.password_enabled, u.profile, u.created_at, u.updated_at
       FROM ${INTERNAL_TABLES.sessions} AS s
       JOIN ${INTERNAL_TABLES.users} AS u ON u.app_id = s.app_id AND u.id = s.user_id
      WHERE s.app_id = ?1 AND s.id = ?2 LIMIT 1`
  ).bind(currentAppId, sessionId).first();
  if (!user || isErasedTombstone(user.email)) {
    await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?1 AND id = ?2`).bind(currentAppId, sessionId).run();
    throw new HttpError(401, "UNAUTHENTICATED", "Magic link is invalid or expired.");
  }
  return sessionResponse(request, currentAppId, userJson(user), sessionToken, expiresAt, 200, {}, env);
}
export {
  SESSION_TOKEN_PREFIX,
  clearSessionCookie,
  cookieValue,
  createSessionToken,
  enqueueMail,
  requestMagicLink,
  requestedSessionMode,
  secureCookieSuffix,
  sessionCookieHeader,
  sessionCookieName,
  sessionResponse,
  verifyMagicLink
};
