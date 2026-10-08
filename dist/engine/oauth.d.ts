import type { ArmadilloBackendDefinition } from "../backend.js";
import type { ArmadilloEnv } from "./environment.js";
import type { SignInProvider } from "../requirements.js";
/**
 * The origin this backend considers its own.
 *
 * A configured public URL always wins. When it is present but unusable, this
 * throws instead of falling through: the fallback is the request's `Host`
 * header, and a Host-derived `redirect_uri` hands the authorization code to
 * whoever controls that header on any adapter that does not pin it.
 */
export declare function applicationOrigin(request: Request, env: ArmadilloEnv): string;
/** Name of the short-lived cookie that binds an OAuth `state` to one browser. */
export declare const OAUTH_STATE_COOKIE = "armadillo_oauth_state";
/**
 * Bind an OAuth `state` to the browser that started the flow.
 *
 * `state` was stored in the database and matched on its hash alone, so nothing
 * tied the callback to the browser that requested it. Anyone could hand a victim
 * a callback URL carrying their own `state` and `code`, and the victim would be
 * silently signed in as the attacker — session fixation, where everything the
 * victim then creates is readable by the attacker.
 */
export declare function oauthStateCookieHeader(request: Request, state: string, env?: Pick<ArmadilloEnv, "ARMADILLO_PUBLIC_URL">): string;
export declare function clearOauthStateCookie(request: Request, env?: Pick<ArmadilloEnv, "ARMADILLO_PUBLIC_URL">): string;
/** Read the browser-bound state nonce, if this request carries one. */
export declare function oauthStateFromCookie(request: Request): string | undefined;
export declare function callbackUrl(request: Request, env: ArmadilloEnv, path: string): string;
export declare function readProviderProfile(profile: SignInProvider["profile"], payload: unknown): {
    subject: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
} | undefined;
export declare function oauthLogin(request: Request, env: ArmadilloEnv, currentAppId: string, definition: ArmadilloBackendDefinition, id: string): Promise<Response>;
export declare function oauthCallback(request: Request, env: ArmadilloEnv, currentAppId: string, definition: ArmadilloBackendDefinition, id: string): Promise<Response>;
export declare function verifySignIn(request: Request, env: ArmadilloEnv, provider: SignInProvider): Promise<{
    id: string;
    ok: boolean;
    message?: string;
}>;
