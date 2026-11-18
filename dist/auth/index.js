//#region src/auth/index.ts
const HANDOFF_CODE_TTL_MS = 12e4;
const HANDOFF_EXCHANGE_PATH = "/api/handoff/exchange";
const ACCOUNTS_ORIGIN = "https://accounts.29court.com";
const SESSION_ABSOLUTE_MS = 2592e6;
const SESSION_IDLE_MS = 6048e5;
const SESSION_TOUCH_MS = 36e5;
const enc = new TextEncoder();
async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Byte-wise timing-safe equality, exactly as accounts util.js. */
function timingSafeEqual(a, b) {
	const x = enc.encode(a);
	const y = enc.encode(b);
	if (x.length !== y.length) return false;
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}
/**
* Unwrap HANDOFF_SECRET: a Secrets Store binding (object with
* .get()) in production, a plain string locally. A failing .get()
* resolves to "" (fail closed) — the posture of the Drive/Photos
* copies; the issuer and Pleasant do not catch, which is one of the
* drifts this module settles (see the A2 run record).
*/
async function resolveHandoffSecret(env) {
	let raw = env ? env.HANDOFF_SECRET : void 0;
	if (raw && typeof raw === "object" && typeof raw.get === "function") try {
		raw = await raw.get();
	} catch {
		raw = "";
	}
	return typeof raw === "string" ? raw : "";
}
/** Alias matching the name every hand-rolled copy uses. */
const handoffSecret = resolveHandoffSecret;
/**
* The issuer's exchange gate: an empty expected secret refuses
* everything, and the comparison is timing-safe. (Vectors: the
* accounts relying harness — no secret -> 401, wrong secret -> 401.)
*/
function verifyHandoffSecret(presented, expected) {
	if (!expected) return false;
	return timingSafeEqual(presented || "", expected);
}
/**
* The issuer's code checks as a pure function over a handoff_codes
* row (the row the issuer loads by code_hash): unknown row, replay
* (used_at set), expiry (now past expires_at — the issuer compares
* `t > row.expires_at`), and hash match. `now` is injectable so the
* harness vectors (minted at T, expiring at T + 120_000) run as-is.
*/
async function checkHandoffCode(code, record, opts = {}) {
	if (!record) return "unknown";
	if (!code) return "unknown";
	if (!timingSafeEqual(await sha256Hex(code), String(record.code_hash || ""))) return "hash_mismatch";
	if (record.used_at) return "used";
	if ((typeof opts.now === "number" ? opts.now : Date.now()) > record.expires_at) return "expired";
	return "ok";
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
async function verifyHandoff(code, opts = {}) {
	const secret = opts.handoffSecret ?? opts.secret ?? opts.issuerKey ?? (opts.env ? await resolveHandoffSecret(opts.env) : "");
	if (opts.record !== void 0) {
		if (!secret) return {
			ok: false,
			status: 401,
			error: "unauthorized"
		};
		if (opts.presentedSecret !== void 0 && !verifyHandoffSecret(opts.presentedSecret, secret)) return {
			ok: false,
			status: 401,
			error: "unauthorized"
		};
		if (await checkHandoffCode(code || "", opts.record, { now: opts.now }) !== "ok") return {
			ok: false,
			status: 401,
			error: "invalid_code"
		};
		const record = opts.record;
		return {
			ok: true,
			member: {
				id: record.member_id,
				email: record.email || ""
			},
			tenant: { id: null }
		};
	}
	if (!code) return {
		ok: false,
		status: 400,
		error: "bad_request"
	};
	const origin = opts.accountsOrigin || "https://accounts.29court.com";
	const exchangeFetch = opts.fetch || (opts.env && opts.env.SVC_ACCOUNTS ? opts.env.SVC_ACCOUNTS.fetch.bind(opts.env.SVC_ACCOUNTS) : globalThis.fetch);
	let res;
	try {
		res = await exchangeFetch(origin + HANDOFF_EXCHANGE_PATH, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-handoff-secret": secret
			},
			body: JSON.stringify({ code })
		});
	} catch {
		return {
			ok: false,
			status: 502,
			error: "exchange_unreachable"
		};
	}
	if (!res.ok) {
		let error = "invalid_code";
		try {
			const body = await res.json();
			if (body && typeof body.error === "string") error = body.error;
		} catch {}
		return {
			ok: false,
			status: res.status,
			error
		};
	}
	const data = await res.json().catch(() => null);
	const member = data && data.member ? data.member : null;
	if (!member || !member.id || !member.email) return {
		ok: false,
		status: 401,
		error: "invalid_code"
	};
	return {
		ok: true,
		member,
		tenant: data && data.tenant ? data.tenant : { id: null }
	};
}
/**
* Convenience in the shape the relying copies call it: the code and
* the Worker env (secret + SVC_ACCOUNTS binding read from env).
*/
async function exchangeHandoffCode(code, env, opts = {}) {
	return verifyHandoff(code, {
		...opts,
		env
	});
}
function presentedSessionToken(request, cookieName) {
	const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + cookieName + "=([^;]+)"));
	if (!m) return "";
	try {
		return decodeURIComponent(m[1]).trim();
	} catch {
		return m[1].trim();
	}
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
async function requireMember(request, env, opts = {}) {
	const cookieName = opts.cookieName || "dillo_session";
	const table = opts.table || "dillo_sessions";
	if (!IDENT_RE.test(cookieName) || !IDENT_RE.test(table)) return null;
	if (!env || !env.DB) return null;
	const raw = presentedSessionToken(request, cookieName);
	if (!raw || !raw.startsWith("s_")) return null;
	const tokenHash = await sha256Hex(raw);
	const row = await env.DB.prepare(`SELECT member_id, email, created_at, last_seen_at, expires_at FROM ${table} WHERE token_hash = ?1`).bind(tokenHash).first();
	if (!row) return null;
	const t = typeof opts.now === "number" ? opts.now : Date.now();
	const idleMs = opts.idleMs ?? 6048e5;
	if (t > Number(row.expires_at) || t - Number(row.last_seen_at) > idleMs) {
		await env.DB.prepare(`DELETE FROM ${table} WHERE token_hash = ?1`).bind(tokenHash).run().catch(() => {});
		return null;
	}
	if (t - Number(row.last_seen_at) > 36e5) await env.DB.prepare(`UPDATE ${table} SET last_seen_at = ?1 WHERE token_hash = ?2`).bind(t, tokenHash).run().catch(() => {});
	return {
		memberId: String(row.member_id),
		email: String(row.email)
	};
}
//#endregion
export { ACCOUNTS_ORIGIN, HANDOFF_CODE_TTL_MS, HANDOFF_EXCHANGE_PATH, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_TOUCH_MS, checkHandoffCode, exchangeHandoffCode, handoffSecret, presentedSessionToken, requireMember, resolveHandoffSecret, sha256Hex, timingSafeEqual, verifyHandoff, verifyHandoffSecret };
