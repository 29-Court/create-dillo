import type { EngineDatabase } from "../ports.js";
import { ArmadilloFunctionError, INTERNAL_TABLES } from "../../backend.js";
import { sha256 } from "../helpers/crypto.js";

export interface RateLimitIdentity {
  /** Stable bucket subject, or `undefined` when no trustworthy client id exists. */
  readonly subject?: string;
  /** True when `subject` came from a source the caller cannot forge. */
  readonly trusted: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/;

function usableIp(value: string | null): string | undefined {
  const candidate = value?.trim() ?? "";
  if (!candidate || candidate.length > 45) return undefined;
  if (!IPV4.test(candidate) && !IPV6.test(candidate)) return undefined;
  return candidate.toLowerCase();
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

export function rateLimitIdentity(request: Request, env: RateLimitEnv): RateLimitIdentity {
  // `cf-connecting-ip` is only trustworthy when the request actually crossed
  // the Cloudflare edge. Everywhere else the caller controls this header, so
  // it is never even read unless the operator states the deployment sits
  // behind Cloudflare - an attacker-supplied value cannot mint fresh buckets.
  if (env.ARMADILLO_BEHIND_CLOUDFLARE === "1") {
    const platform = usableIp(request.headers.get("cf-connecting-ip"));
    if (platform) return { subject: platform, trusted: true };
  }
  const trustForwarded = env.ARMADILLO_TRUST_FORWARDED_IP === "1";
  if (trustForwarded) {
    const configured = env.ARMADILLO_FORWARDED_IP_HEADER?.trim();
    const header = configured || "x-forwarded-for";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) return { trusted: false };
    const raw = request.headers.get(header);
    // Only the left-most entry is proxy-controlled; the rest is caller-supplied.
    const forwarded = usableIp(raw?.split(",", 1)[0] ?? null);
    if (forwarded) return { subject: forwarded, trusted: true };
  }
  return { trusted: false };
}

export async function enforceRateLimit(
  request: Request,
  database: EngineDatabase,
  options: RateLimitEnv,
  currentAppId: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
  discriminator = "",
): Promise<void> {
  const identity = rateLimitIdentity(request, options);
  // With a trustworthy client id the bucket is keyed on both. Without one, a
  // caller-supplied discriminator (typically a hash of the account being
  // targeted) is the only subject an attacker cannot rotate, so prefer it over
  // a shared bucket that one hostile client could exhaust for everyone.
  const subject = identity.subject
    ? `ip:${identity.subject}`
    : discriminator
      ? `subject:${discriminator}`
      : "shared";
  const keyHash = await sha256(`${currentAppId}\n${bucket}\n${subject}`);
  const timestamp = new Date().toISOString();
  const resetAt = new Date(Date.now() + windowSeconds * 1_000).toISOString();
  const row = await database.prepare(
    `INSERT INTO ${INTERNAL_TABLES.rateLimits} (key_hash, count, reset_at, updated_at)
     VALUES (?1, 1, ?2, ?3)
     ON CONFLICT(key_hash) DO UPDATE SET
       count = CASE WHEN reset_at <= excluded.updated_at THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= excluded.updated_at THEN excluded.reset_at ELSE reset_at END,
       updated_at = excluded.updated_at
     RETURNING count, reset_at`,
  ).bind(keyHash, resetAt, timestamp).first<{ count: number; reset_at: string }>();
  if (row && row.count > limit) {
    const seconds = Math.max(1, Math.ceil((Date.parse(row.reset_at) - Date.now()) / 1_000));
    throw new ArmadilloFunctionError(
      429,
      "RATE_LIMITED",
      `Too many requests. Try again in ${seconds} seconds.`,
    );
  }
}