// auth.test.mjs — dillo/src/auth vectors.
//
// Fixtures are LIFTED from the accounts relying-side harnesses, not
// invented in parallel:
//   * surfaces/accounts/test/relying-harness.mjs — HANDOFF_SECRET
//     "relying-test-secret"; no secret -> 401, wrong secret -> 401;
//     member mem_x / x@example.com, personal org org_x.
//   * surfaces/accounts/test/burn-race-harness.mjs — handoff code
//     "handoff-race-code" inserted as a handoff_codes row with
//     code_hash = sha256Hex(code), member mem_r, return_host
//     flows.29court.com, created at T, expires at T + 120000 (the
//     issuer's CODE_TTL_MS); a second exchange of the same code is
//     the replay and answers 401.
//   * surfaces/accounts/src/routes-handoff.js — the issuer's answer
//     shapes: 401 unauthorized (bad secret, checked FIRST),
//     400 bad_request (no code), 401 invalid_code (unknown / used /
//     expired), 403 account_not_active, 200 { member, tenant }.
//     Expiry compares `t > expires_at`, so a code is still valid AT
//     expires_at exactly.
// The exchange-mode tests run verifyHandoff against a stub that
// speaks the issuer's protocol (it is a test double of the issuer,
// asserting the exact request verifyHandoff sends); the issuer
// itself is proven unchanged by its own harnesses, run as gates.

import { createHash } from "node:crypto";
import {
  ACCOUNTS_ORIGIN,
  HANDOFF_CODE_TTL_MS,
  HANDOFF_EXCHANGE_PATH,
  checkHandoffCode,
  exchangeHandoffCode,
  requireMember,
  resolveHandoffSecret,
  sha256Hex,
  timingSafeEqual,
  verifyHandoff,
  verifyHandoffSecret,
} from "../dist/auth/index.js";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { failed++; console.log("FAIL  " + name + (extra ? " — " + extra : "")); }
}

const T = 1760000000000; // relying-harness epoch
const SECRET = "relying-test-secret"; // relying-harness HANDOFF_SECRET
const nodeSha256 = (s) => createHash("sha256").update(s).digest("hex");

console.log("\n[auth] primitives");
check("sha256Hex matches the node:crypto oracle", (await sha256Hex("handoff-race-code")) === nodeSha256("handoff-race-code"));
check("HANDOFF_CODE_TTL_MS is the issuer's 120s", HANDOFF_CODE_TTL_MS === 120000);
check("timingSafeEqual: equal strings", timingSafeEqual("abc", "abc") === true);
check("timingSafeEqual: different strings", timingSafeEqual("abc", "abd") === false);
check("timingSafeEqual: different lengths", timingSafeEqual("abc", "abcd") === false);

console.log("\n[auth] secret resolution + gate (relying-harness vectors)");
check("plain-string secret resolves", (await resolveHandoffSecret({ HANDOFF_SECRET: SECRET })) === SECRET);
check("Secrets-Store object secret resolves via .get()", (await resolveHandoffSecret({ HANDOFF_SECRET: { get: async () => SECRET } })) === SECRET);
check("throwing .get() fails closed to empty", (await resolveHandoffSecret({ HANDOFF_SECRET: { get: async () => { throw new Error("store down"); } } })) === "");
check("missing secret resolves empty", (await resolveHandoffSecret({})) === "");
check("no secret presented -> refused", verifyHandoffSecret("", SECRET) === false);
check("wrong secret -> refused (relying-harness: wrong secret -> 401)", verifyHandoffSecret("wrong", SECRET) === false);
check("empty expected secret refuses everything", verifyHandoffSecret(SECRET, "") === false);
check("correct secret -> admitted", verifyHandoffSecret(SECRET, SECRET) === true);

// The burn-race-harness handoff_codes row for "handoff-race-code".
const raceRow = {
  code_hash: nodeSha256("handoff-race-code"),
  member_id: "mem_r",
  email: "race@example.com",
  created_at: T,
  expires_at: T + 120000,
  used_at: null,
};

console.log("\n[auth] issuer code-record checks (burn-race fixtures)");
check("valid code at mint time", (await checkHandoffCode("handoff-race-code", raceRow, { now: T })) === "ok");
check("valid at expires_at exactly (issuer compares t > expires_at)", (await checkHandoffCode("handoff-race-code", raceRow, { now: T + 120000 })) === "ok");
check("expired one ms past expires_at", (await checkHandoffCode("handoff-race-code", raceRow, { now: T + 120001 })) === "expired");
check("replayed code (used_at set by the first exchange)", (await checkHandoffCode("handoff-race-code", { ...raceRow, used_at: T + 1000 }, { now: T + 2000 })) === "used");
check("tampered code (hash mismatch)", (await checkHandoffCode("handoff-race-code-tampered", raceRow, { now: T })) === "hash_mismatch");
check("unknown code (no row)", (await checkHandoffCode("handoff-race-code", null, { now: T })) === "unknown");

console.log("\n[auth] verifyHandoff, issuer-record mode");
{
  const ok = await verifyHandoff("handoff-race-code", { record: raceRow, issuerKey: SECRET, presentedSecret: SECRET, now: T });
  check("valid + right secret -> member payload", ok.ok === true && ok.member.id === "mem_r" && ok.member.email === "race@example.com", JSON.stringify(ok));
  const badSecret = await verifyHandoff("handoff-race-code", { record: raceRow, issuerKey: SECRET, presentedSecret: "wrong", now: T });
  check("wrong secret -> 401 unauthorized, before the code is read", badSecret.ok === false && badSecret.status === 401 && badSecret.error === "unauthorized", JSON.stringify(badSecret));
  const replayed = await verifyHandoff("handoff-race-code", { record: { ...raceRow, used_at: T + 1000 }, issuerKey: SECRET, presentedSecret: SECRET, now: T + 2000 });
  check("replayed code -> 401 invalid_code", replayed.ok === false && replayed.status === 401 && replayed.error === "invalid_code");
  const expired = await verifyHandoff("handoff-race-code", { record: raceRow, issuerKey: SECRET, presentedSecret: SECRET, now: T + 120001 });
  check("expired code -> 401 invalid_code", expired.ok === false && expired.status === 401 && expired.error === "invalid_code");
  const tampered = await verifyHandoff("handoff-race-code-tampered", { record: raceRow, issuerKey: SECRET, presentedSecret: SECRET, now: T });
  check("tampered code -> 401 invalid_code", tampered.ok === false && tampered.status === 401 && tampered.error === "invalid_code");
  const unknown = await verifyHandoff("handoff-race-code", { record: null, issuerKey: SECRET, presentedSecret: SECRET, now: T });
  check("unknown code -> 401 invalid_code", unknown.ok === false && unknown.status === 401 && unknown.error === "invalid_code");
  const unconfigured = await verifyHandoff("handoff-race-code", { record: raceRow, now: T });
  check("no secret configured -> 401 unauthorized (fail closed)", unconfigured.ok === false && unconfigured.status === 401 && unconfigured.error === "unauthorized");
}

console.log("\n[auth] verifyHandoff, exchange mode (issuer-protocol stub)");
// The stub speaks routes-handoff.js: secret gate first, then the
// code; it records the request so the test asserts verifyHandoff
// sends exactly the issuer's shape.
const seen = [];
const issuerStub = async (url, init) => {
  seen.push({ url, init });
  const headers = init.headers || {};
  if (headers["x-handoff-secret"] !== SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized", message: "Bad handoff secret." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  let code = "";
  try { code = JSON.parse(init.body).code || ""; } catch {}
  if (!code) return new Response(JSON.stringify({ error: "bad_request", message: "code required." }), { status: 400, headers: { "content-type": "application/json" } });
  if (code === "code-mem_x") {
    return new Response(JSON.stringify({ member: { id: "mem_x", email: "x@example.com" }, tenant: { id: "org_x" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (code === "code-suspended") {
    return new Response(JSON.stringify({ error: "account_not_active", message: "This account is not active." }), { status: 403, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "invalid_code", message: "That handoff code is used or expired." }), { status: 401, headers: { "content-type": "application/json" } });
};
{
  const ok = await verifyHandoff("code-mem_x", { fetch: issuerStub, handoffSecret: SECRET });
  check("valid exchange -> member + tenant (relying-harness member/org)", ok.ok === true && ok.member.id === "mem_x" && ok.member.email === "x@example.com" && ok.tenant.id === "org_x", JSON.stringify(ok));
  const req = seen[seen.length - 1];
  check("request shape: POST <accounts>/api/handoff/exchange, x-handoff-secret header, {code} body",
    req.url === ACCOUNTS_ORIGIN + HANDOFF_EXCHANGE_PATH && req.init.method === "POST" &&
    req.init.headers["x-handoff-secret"] === SECRET && JSON.parse(req.init.body).code === "code-mem_x");
  const badSecret = await verifyHandoff("code-mem_x", { fetch: issuerStub, handoffSecret: "wrong" });
  check("wrong secret -> 401 unauthorized (issuer answer passes through)", badSecret.ok === false && badSecret.status === 401 && badSecret.error === "unauthorized");
  const replayed = await verifyHandoff("code-used-already", { fetch: issuerStub, handoffSecret: SECRET });
  check("replayed/used code -> 401 invalid_code", replayed.ok === false && replayed.status === 401 && replayed.error === "invalid_code");
  const suspended = await verifyHandoff("code-suspended", { fetch: issuerStub, handoffSecret: SECRET });
  check("non-active member -> 403 account_not_active", suspended.ok === false && suspended.status === 403 && suspended.error === "account_not_active");
  const empty = await verifyHandoff("", { fetch: issuerStub, handoffSecret: SECRET });
  check("missing code -> 400 bad_request without a fetch", empty.ok === false && empty.status === 400 && empty.error === "bad_request");
  const down = await verifyHandoff("code-mem_x", { fetch: async () => { throw new Error("edge down"); }, handoffSecret: SECRET });
  check("unreachable exchange -> 502 exchange_unreachable", down.ok === false && down.status === 502 && down.error === "exchange_unreachable");
  // exchangeHandoffCode reads secret + binding from env, like the copies did.
  const viaEnv = await exchangeHandoffCode("code-mem_x", {
    HANDOFF_SECRET: SECRET,
    SVC_ACCOUNTS: { fetch: issuerStub },
  });
  check("exchangeHandoffCode via env SVC_ACCOUNTS binding", viaEnv.ok === true && viaEnv.member.id === "mem_x");
  const viaEnvObjectSecret = await exchangeHandoffCode("code-mem_x", {
    HANDOFF_SECRET: { get: async () => SECRET },
    SVC_ACCOUNTS: { fetch: issuerStub },
  });
  check("exchangeHandoffCode with Secrets-Store object secret", viaEnvObjectSecret.ok === true);
}

console.log("\n[auth] requireMember (D1 session shape, photos/drive semantics)");
{
  // Minimal D1-shaped stub over one sessions table.
  const rows = new Map();
  const db = {
    prepare(sql) {
      let args = [];
      const self = {
        bind(...a) { args = a; return self; },
        async first() {
          if (!sql.startsWith("SELECT")) return null;
          return rows.get(args[0]) || null;
        },
        async run() {
          if (sql.startsWith("DELETE")) rows.delete(args[0]);
          if (sql.startsWith("UPDATE")) { const r = rows.get(args[1]); if (r) r.last_seen_at = args[0]; }
          return { meta: { changes: 1 } };
        },
      };
      return self;
    },
  };
  const raw = "s_" + "A".repeat(43);
  const hash = nodeSha256(raw);
  rows.set(hash, { member_id: "mem_x", email: "x@example.com", created_at: T, last_seen_at: T, expires_at: T + 30 * 24 * 3600 * 1000 });
  const req = (cookie) => new Request("https://photos.29court.com/photos/api/events", { headers: cookie ? { Cookie: cookie } : {} });
  const member = await requireMember(req(`photos_session=${raw}`), { DB: db }, { cookieName: "photos_session", table: "photos_sessions", now: T + 1000 });
  check("live session resolves to its member", member !== null && member.memberId === "mem_x" && member.email === "x@example.com", JSON.stringify(member));
  check("no cookie -> null", (await requireMember(req(null), { DB: db }, { cookieName: "photos_session", table: "photos_sessions", now: T })) === null);
  check("wrong cookie name -> null", (await requireMember(req(`other=${raw}`), { DB: db }, { cookieName: "photos_session", table: "photos_sessions", now: T })) === null);
  check("token without s_ prefix -> null", (await requireMember(req("photos_session=plain-token"), { DB: db }, { cookieName: "photos_session", table: "photos_sessions", now: T })) === null);
  const idle = await requireMember(req(`photos_session=${raw}`), { DB: db }, { cookieName: "photos_session", table: "photos_sessions", now: T + 8 * 24 * 3600 * 1000 });
  check("idle-expired session -> null and row deleted", idle === null && rows.has(hash) === false);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
