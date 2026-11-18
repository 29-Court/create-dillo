// dillo/src/auth — the ONE handoff verifier (overnight slice A2).
//
// Semantics are the accounts issuer's, read from the issuer itself
// (surfaces/accounts/src/routes-handoff.js, 2026-10-20) — NOT from the
// hand-rolled relying-party copies this module replaces:
//
//   * The handoff credential is an OPAQUE one-time code, not a signed
//     token: authorize mints newToken(32) (base64url of 32 random
//     bytes), stores only its SHA-256 hex in handoff_codes, and 302s
//     the member to the relying surface with ?handoff=<raw code>.
//   * TTL is 120 seconds (CODE_TTL_MS in the issuer). The code is
//     single-use: the exchange burns it (conditional UPDATE) BEFORE
//     any member check, so a refused exchange still spends the code
//     and a replay always answers 401 invalid_code.
//   * Verification is a server-to-server exchange, never a local
//     signature check: POST /api/handoff/exchange { code } with the
//     header x-handoff-secret, compared timing-safe against the
//     shared HANDOFF_SECRET (a Secrets Store binding — an object
//     with .get() — in production, a plain string locally). The code
//     alone is worthless without the secret.
//   * "Audience" in this scheme is the return-host allowlist
//     (HANDOFF_ALLOW_HOSTS, https only), enforced by the ISSUER at
//     mint time; the code carries no audience claim a relying party
//     could check locally. The relying party's check is the exchange.
//   * Exchange answers: 401 {error:"unauthorized"} (bad secret),
//     400 {error:"bad_request"} (no code), 401 {error:"invalid_code"}
//     (unknown / used / expired code, or unknown member),
//     403 {error:"account_not_active"} (member not active — the code
//     stays burned), 200 { member: { id, email }, tenant: { id } }
//     with the tenant id re-derived from org membership at exchange
//     time (the code row's stamp is never trusted).
//   * After a successful exchange the relying surface mints its OWN
//     session: raw token "s_" + base64url(32 random bytes), only the
//     SHA-256 hex at rest, 30-day absolute / 7-day idle lifetime,
//     HttpOnly + Secure + SameSite=Lax cookie. requireMember below is
//     that session check, in the D1 shape Drive/Photos use.

export const HANDOFF_CODE_TTL_MS = 120 * 1000;
export const HANDOFF_EXCHANGE_PATH = "/api/handoff/exchange";
export const ACCOUNTS_ORIGIN = "https://accounts.29court.com";
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000;
export const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_TOUCH_MS = 3600 * 1000;

export interface HandoffMember {
  id: string;
  email: string;
}

export interface HandoffTenant {
  id: string | null;
}

export type VerifyHandoffResult =
  | { ok: true; member: HandoffMember; tenant: HandoffTenant }
  | { ok: false; status: number; error: string };

/** The slice of a Worker env this module reads. */
export interface HandoffEnv {
  HANDOFF_SECRET?: unknown;
  SVC_ACCOUNTS?: { fetch: (input: string, init?: unknown) => Promise<Response> } | null;
  DB?: D1Like | null;
}

export interface D1PreparedLike {
  bind(...args: unknown[]): {
    first(): Promise<Record<string, unknown> | null>;
    run(): Promise<unknown>;
  };
}

export interface D1Like {
  prepare(sql: string): D1PreparedLike;
}

/* ---------------- primitives (accounts util.js shapes) ---------------- */

const enc = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Byte-wise timing-safe equality, exactly as accounts util.js. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ---------------- the shared secret ---------------- */

/**
 * Unwrap HANDOFF_SECRET: a Secrets Store binding (object with
 * .get()) in production, a plain string locally. A failing .get()
 * resolves to "" (fail closed) — the posture of the Drive/Photos
 * copies; the issuer and Pleasant do not catch, which is one of the
 * drifts this module settles (see the A2 run record).
 */
export async function resolveHandoffSecret(env: HandoffEnv): Promise<string> {
  let raw: unknown = env ? env.HANDOFF_SECRET : undefined;
  if (raw && typeof raw === "object" && typeof (raw as { get?: unknown }).get === "function") {
    try {
      raw = await (raw as { get: () => Promise<unknown> }).get();
    } catch {
      raw = "";
    }
  }
  return typeof raw === "string" ? raw : "";
}

/** Alias matching the name every hand-rolled copy uses. */
export const handoffSecret = resolveHandoffSecret;

/**
 * The issuer's exchange gate: an empty expected secret refuses
 * everything, and the comparison is timing-safe. (Vectors: the
 * accounts relying harness — no secret -> 401, wrong secret -> 401.)
 */
export function verifyHandoffSecret(presented: string, expected: string): boolean {
  if (!expected) return false;
  return timingSafeEqual(presented || "", expected);
}

/* ---------------- issuer-side code record check ---------------- */

export interface HandoffCodeRecord {
  code_hash: string;
  member_id: string;
  email?: string;
  expires_at: number;
  used_at?: number | null;
}

export type HandoffCodeVerdict = "ok" | "unknown" | "used" | "expired" | "hash_mismatch";

/**
 * The issuer's code checks as a pure function over a handoff_codes
 * row (the row the issuer loads by code_hash): unknown row, replay
 * (used_at set), expiry (now past expires_at — the issuer compares
 * `t > row.expires_at`), and hash match. `now` is injectable so the
 * harness vectors (minted at T, expiring at T + 120_000) run as-is.
 */
export async function checkHandoffCode(
  code: string,
  record: HandoffCodeRecord | null | undefined,
  opts: { now?: number } = {},
): Promise<HandoffCodeVerdict> {
  if (!record) return "unknown";
  if (!code) return "unknown";
  const presentedHash = await sha256Hex(code);
  if (!timingSafeEqual(presentedHash, String(record.code_hash || ""))) return "hash_mismatch";
  if (record.used_at) return "used";
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  if (now > record.expires_at) return "expired";
  return "ok";
}

/* ---------------- the verifier ---------------- */

export interface VerifyHandoffOptions {
  /**
   * The shared HANDOFF_SECRET. `issuerKey` is accepted as an alias
   * (the governing spec's name for the same value). When neither is
   * given, the secret is resolved from `env.HANDOFF_SECRET`.
   */
  issuerKey?: string;
  handoffSecret?: string;
  secret?: string;
  env?: HandoffEnv;
  /** Injectable fetch for the exchange (tests, non-Workers hosts). */
  fetch?: (input: string, init?: unknown) => Promise<Response>;
  /** Accounts origin override; defaults to ACCOUNTS_ORIGIN. */
  accountsOrigin?: string;
  /** Accepted for interface compatibility; the issuer is the
   *  authority on expiry, so a relying-side clock never overrules
   *  the exchange answer. Recorded on nothing, changes nothing. */
  now?: number;
  /**
   * Issuer-record mode (issuer-side checks and tests): verify the
   * code against a handoff_codes row instead of calling the
   * exchange. `null` models an unknown code.
   */
  record?: HandoffCodeRecord | null;
  /**
   * Record mode only: the x-handoff-secret value presented with the
   * exchange, checked against the configured secret (issuerKey /
   * handoffSecret / env). Omit when the transport is already the
   * issuer's own gate; when given, a mismatch answers 401
   * unauthorized before the code is ever looked at — the issuer's
   * order.
   */
  presentedSecret?: string;
}

/**
 * Verify a handoff code — the relying party's one call.
 *
 * Default mode performs the issuer's exchange exactly as the
 * hand-rolled copies did: the SVC_ACCOUNTS service binding's fetch
 * when bound (a plain same-zone fetch dies at the edge), else the
 * provided/global fetch, POSTing { code } with the x-handoff-secret
 * header, and mapping the issuer's statuses through unchanged.
 */
export async function verifyHandoff(
  code: string,
  opts: VerifyHandoffOptions = {},
): Promise<VerifyHandoffResult> {
  const secret =
    opts.handoffSecret ?? opts.secret ?? opts.issuerKey ??
    (opts.env ? await resolveHandoffSecret(opts.env) : "");

  if (opts.record !== undefined) {
    // Issuer-record mode: secret gate first (the issuer refuses a
    // bad secret before it ever looks at the code), then the code
    // checks in the issuer's order. With no secret configured at
    // all, the gate fails closed.
    if (!secret) return { ok: false, status: 401, error: "unauthorized" };
    if (opts.presentedSecret !== undefined && !verifyHandoffSecret(opts.presentedSecret, secret)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    const verdict = await checkHandoffCode(code || "", opts.record, { now: opts.now });
    if (verdict !== "ok") return { ok: false, status: 401, error: "invalid_code" };
    const record = opts.record as HandoffCodeRecord;
    return {
      ok: true,
      member: { id: record.member_id, email: record.email || "" },
      tenant: { id: null },
    };
  }

  if (!code) return { ok: false, status: 400, error: "bad_request" };
  const origin = opts.accountsOrigin || ACCOUNTS_ORIGIN;
  const exchangeFetch =
    opts.fetch ||
    (opts.env && opts.env.SVC_ACCOUNTS
      ? opts.env.SVC_ACCOUNTS.fetch.bind(opts.env.SVC_ACCOUNTS)
      : globalThis.fetch);
  let res: Response;
  try {
    res = await exchangeFetch(origin + HANDOFF_EXCHANGE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-handoff-secret": secret },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, status: 502, error: "exchange_unreachable" };
  }
  if (!res.ok) {
    let error = "invalid_code";
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") error = body.error;
    } catch { /* keep the default */ }
    return { ok: false, status: res.status, error };
  }
  const data = (await res.json().catch(() => null)) as {
    member?: HandoffMember;
    tenant?: HandoffTenant;
  } | null;
  const member = data && data.member ? data.member : null;
  if (!member || !member.id || !member.email) {
    return { ok: false, status: 401, error: "invalid_code" };
  }
  return { ok: true, member, tenant: data && data.tenant ? data.tenant : { id: null } };
}

/**
 * Convenience in the shape the relying copies call it: the code and
 * the Worker env (secret + SVC_ACCOUNTS binding read from env).
 */
export async function exchangeHandoffCode(
  code: string,
  env: HandoffEnv,
  opts: Omit<VerifyHandoffOptions, "env"> = {},
): Promise<VerifyHandoffResult> {
  return verifyHandoff(code, { ...opts, env });
}

/* ---------------- the relying surface's session gate ---------------- */

export function presentedSessionToken(request: Request, cookieName: string): string {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp("(?:^|;\\s*)" + cookieName + "=([^;]+)"));
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

export interface RequireMemberOptions {
  /** Session cookie name (per-surface: "photos_session", ...). */
  cookieName?: string;
  /** Session table (per-surface: "photos_sessions", ...). Identifiers
   *  are interpolated into SQL, so they are shape-checked. */
  table?: string;
  now?: number;
  absoluteMs?: number;
  idleMs?: number;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve the relying surface's own session cookie to its member —
 * the D1 session check Drive/Photos hand-roll (token hash at rest,
 * absolute + idle expiry with the expired row deleted, last-seen
 * touched at most hourly). Returns { memberId, email } or null.
 * The session table's columns are the relying shape:
 * token_hash, member_id, email, created_at, last_seen_at, expires_at.
 */
export async function requireMember(
  request: Request,
  env: HandoffEnv,
  opts: RequireMemberOptions = {},
): Promise<{ memberId: string; email: string } | null> {
  const cookieName = opts.cookieName || "dillo_session";
  const table = opts.table || "dillo_sessions";
  if (!IDENT_RE.test(cookieName) || !IDENT_RE.test(table)) return null;
  if (!env || !env.DB) return null;
  const raw = presentedSessionToken(request, cookieName);
  if (!raw || !raw.startsWith("s_")) return null;
  const tokenHash = await sha256Hex(raw);
  const row = await env.DB
    .prepare(
      `SELECT member_id, email, created_at, last_seen_at, expires_at FROM ${table} WHERE token_hash = ?1`,
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  const t = typeof opts.now === "number" ? opts.now : Date.now();
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  if (t > Number(row.expires_at) || t - Number(row.last_seen_at) > idleMs) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE token_hash = ?1`)
      .bind(tokenHash)
      .run()
      .catch(() => {});
    return null;
  }
  if (t - Number(row.last_seen_at) > SESSION_TOUCH_MS) {
    await env.DB.prepare(`UPDATE ${table} SET last_seen_at = ?1 WHERE token_hash = ?2`)
      .bind(t, tokenHash)
      .run()
      .catch(() => {});
  }
  return { memberId: String(row.member_id), email: String(row.email) };
}
