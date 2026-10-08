import { type JsonObject } from "../backend.js";
import { type SchemaDefinition } from "../schema.js";
import { type ArmadilloEnv } from "./environment.js";
import { type SendMailJob } from "./mail.js";
/**
 * Prefix on every opaque session credential. Callers use it to recognize their
 * own tokens without a database round trip, so it is part of the wire contract.
 */
export declare const SESSION_TOKEN_PREFIX = "arm_session_";
export declare function createSessionToken(): string;
export declare function sessionCookieName(appId: string): string;
/**
 * Decide whether `Secure` belongs on an auth cookie.
 *
 * A configured `ARMADILLO_PUBLIC_URL` always wins: it is the URL the operator
 * advertises to browsers, so its scheme is the scheme those browsers actually
 * use - even when a TLS-terminating proxy forwards plain http internally.
 * Without it we keep the historical behaviour (Secure when the request URL
 * itself arrived over https). Local dev that sets a public https URL while
 * hitting the worker over plain http will get Secure cookies the browser
 * refuses to send back: omit ARMADILLO_PUBLIC_URL for that setup.
 */
export declare function secureCookieSuffix(request: Request, env?: Pick<ArmadilloEnv, "ARMADILLO_PUBLIC_URL">): string;
export declare function sessionCookieHeader(request: Request, appId: string, token: string, expiresAt: string, env?: Pick<ArmadilloEnv, "ARMADILLO_PUBLIC_URL">): string;
export declare function cookieValue(request: Request, name: string): string | undefined;
export declare function requestedSessionMode(request: Request): "cookie" | "token" | undefined;
/**
 * Build a sign-in response.
 *
 * The session token is a long-lived bearer credential, so it is only ever
 * serialized into the response body when the caller explicitly asks for token
 * transport with `x-armadillo-auth-mode: token`. Everything else — including a
 * plain `fetch` from a browser that sends no such header — gets an `HttpOnly`
 * cookie and never sees the secret in JavaScript-reachable JSON.
 */
export declare function sessionResponse(request: Request, appId: string, user: JsonObject, token: string, expiresAt: string, status?: number, extra?: JsonObject, env?: Pick<ArmadilloEnv, "ARMADILLO_PUBLIC_URL">): Response;
export declare function clearSessionCookie(request: Request, appId: string, env?: Pick<ArmadilloEnv, "ARMADILLO_PUBLIC_URL">): string;
export declare function enqueueMail(env: ArmadilloEnv, currentAppId: string, job: SendMailJob): Promise<void>;
export declare function requestMagicLink(request: Request, env: ArmadilloEnv, currentAppId: string, schema?: SchemaDefinition): Promise<Response>;
export declare function verifyMagicLink(request: Request, env: ArmadilloEnv, currentAppId: string): Promise<Response>;
