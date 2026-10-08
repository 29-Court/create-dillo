import type { EngineDatabase } from "../ports.js";
export interface RateLimitIdentity {
    /** Stable bucket subject, or `undefined` when no trustworthy client id exists. */
    readonly subject?: string;
    /** True when `subject` came from a source the caller cannot forge. */
    readonly trusted: boolean;
}
/**
 * Resolve the rate-limit subject for a request.
 *
 * `cf-connecting-ip` is written by the Cloudflare edge, but on any deployment
 * that does not sit behind Cloudflare the caller sets this header themselves,
 * so it is only honoured when the operator explicitly opts in with
 * `ARMADILLO_BEHIND_CLOUDFLARE=1`. Forwarded headers can be set by anyone
 * and are only honoured when an operator states their proxy rewrites them
 * (`ARMADILLO_TRUST_FORWARDED_IP=1`). `x-forwarded-for` in particular is
 * client-controlled on every non-Cloudflare deployment, so trusting it by
 * default let an attacker mint a fresh bucket per request and brute force past
 * every login and signup limit.
 *
 * When nothing trustworthy is available we report `trusted: false` so callers
 * can fall back to an unspoofable discriminator instead of sharing one global
 * bucket with every other anonymous client.
 */
export interface RateLimitEnv {
    readonly ARMADILLO_TRUST_FORWARDED_IP?: string;
    readonly ARMADILLO_FORWARDED_IP_HEADER?: string;
    readonly ARMADILLO_BEHIND_CLOUDFLARE?: string;
}
export declare function rateLimitIdentity(request: Request, env: RateLimitEnv): RateLimitIdentity;
export declare function enforceRateLimit(request: Request, database: EngineDatabase, options: RateLimitEnv, currentAppId: string, bucket: string, limit: number, windowSeconds: number, discriminator?: string): Promise<void>;
