import { ArmadilloFunctionError, INTERNAL_TABLES } from "../../backend.js";
import { sha256 } from "../helpers/crypto.js";
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/;
function usableIp(value) {
  const candidate = value?.trim() ?? "";
  if (!candidate || candidate.length > 45) return void 0;
  if (!IPV4.test(candidate) && !IPV6.test(candidate)) return void 0;
  return candidate.toLowerCase();
}
function rateLimitIdentity(request, env) {
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
    const forwarded = usableIp(raw?.split(",", 1)[0] ?? null);
    if (forwarded) return { subject: forwarded, trusted: true };
  }
  return { trusted: false };
}
async function enforceRateLimit(request, database, options, currentAppId, bucket, limit, windowSeconds, discriminator = "") {
  const identity = rateLimitIdentity(request, options);
  const subject = identity.subject ? `ip:${identity.subject}` : discriminator ? `subject:${discriminator}` : "shared";
  const keyHash = await sha256(`${currentAppId}
${bucket}
${subject}`);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const resetAt = new Date(Date.now() + windowSeconds * 1e3).toISOString();
  const row = await database.prepare(
    `INSERT INTO ${INTERNAL_TABLES.rateLimits} (key_hash, count, reset_at, updated_at)
     VALUES (?1, 1, ?2, ?3)
     ON CONFLICT(key_hash) DO UPDATE SET
       count = CASE WHEN reset_at <= excluded.updated_at THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= excluded.updated_at THEN excluded.reset_at ELSE reset_at END,
       updated_at = excluded.updated_at
     RETURNING count, reset_at`
  ).bind(keyHash, resetAt, timestamp).first();
  if (row && row.count > limit) {
    const seconds = Math.max(1, Math.ceil((Date.parse(row.reset_at) - Date.now()) / 1e3));
    throw new ArmadilloFunctionError(
      429,
      "RATE_LIMITED",
      `Too many requests. Try again in ${seconds} seconds.`
    );
  }
}
export {
  enforceRateLimit,
  rateLimitIdentity
};
