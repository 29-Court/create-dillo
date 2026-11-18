// Dillo Vault — own proof + adversarial suite (VAULT-SPEC build).
//
// Runs the Vault under `wrangler dev` (real miniflare D1 engine, NOT a
// SQLite shim) with a THROWAWAY KEK injected per run (`--var VAULT_KEK`)
// — no KEK material ever touches a file. Then drives the adversary legs
// from VAULT-SPEC + the build brief's step 6, recording KILL / WOUND /
// SURVIVES before any fix is allowed to pass.
//
// Run: node dillo/src/vault/test/proof.mjs [--target http://127.0.0.1:<port>]
//   --target  : hit an already-running worker instead of spawning wrangler dev
//   --port N  : spawn port (default 8788)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, "..");

const argv = process.argv.slice(2);
const ti = argv.indexOf("--target");
const target = ti >= 0 ? argv[ti + 1] : null;
const pi = argv.indexOf("--port");
const port = pi >= 0 ? Number(argv[pi + 1]) : 8788;
const base = target || `http://127.0.0.1:${port}`;

const checks = [];
function check(name, cond, detail = "") {
  checks.push([name, !!cond, detail]);
  console.log((cond ? "  ok  " : "  FAIL ") + name + (cond && !detail ? "" : "  → " + String(detail).slice(0, 220)));
}

// ---------- vault HTTP helper ----------
function attrs(tenant, owner, extra = {}) {
  return {
    "content-type": "application/json",
    "x-vault-tenant": tenant,
    "x-vault-owner": owner,
    "x-vault-recovery": extra.recovery ? "1" : "0",
    "x-vault-session-hash": extra.sessionHash || "",
    ...(extra.headers || {}),
  };
}
async function vcall(path, { tenant, owner, method = "POST", body, ...extra } = {}) {
  const init = { method, headers: attrs(tenant, owner, extra) };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const T = "adversary-tenant";
const A = "m_alice";
const B = "m_bob";

// D-1a/D-1b fixtures (synthetic, never real secrets). The console caller is
// the owner's own console; `flows` is the Flows runtime. Their secrets are
// presented as headers and authenticated by SHA-256 against grant rows (the
// console secret also verifies against env.VAULT_CONSOLE_SECRET for minting).
const CONSOLE = "console";
const CONSOLE_SECRET = "console-caller-fixture";
const FLOWS = "flows";
const FLOWS_SECRET = "flows-caller-fixture";
const consoleHeaders = { "x-vault-caller": CONSOLE, "x-vault-caller-secret": CONSOLE_SECRET };
const flowsHeaders = { "x-vault-caller": FLOWS, "x-vault-caller-secret": FLOWS_SECRET };

async function save(tenant, owner, { name, kind, host, value, provider, scopes }, extra) {
  return vcall("/vault/save", { tenant, owner, body: { tenant, owner, name, kind, host, value, provider, scopes }, ...extra });
}

// Minimal in-memory D1 double used ONLY by unit legs (the HTTP legs run
// against the real miniflare engine). It dispatches on the SQL text so a
// corrupted row can be staged without touching the real store. It also
// captures every `run()` statement + bind params so a unit leg can assert
// the access-log write for a mint ("mint logged with the verified actor").
function makeFakeDb(rowsByTable) {
  const table = (sql) => {
    if (sql.includes("dillo_secret_keys")) return "dillo_secret_keys";
    if (sql.includes("dillo_secrets")) return "dillo_secrets";
    if (sql.includes("dillo_vault_grants")) return "dillo_vault_grants";
    return null;
  };
  const statements = [];
  const db = {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args; return stmt; },
        async first() {
          const t = table(sql);
          return (t && rowsByTable[t]) || null;
        },
        async run() { statements.push({ sql, params: params.slice() }); return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async batch(list) { for (const s of list) await s.run(); },
  };
  db.statements = statements;
  return db;
}

// ---------- unit legs (module-level, no DB needed) ----------
async function unitLegs() {
  console.log("\n[unit] crypto at rest + KEK-missing fail-closed");
  const crypto = await import("../src/crypto.mjs");
  const secret = "SUPER-SECRET-VALUE-9f3a";
  const sealed = await crypto.sealText("unit-test-key-material", secret);
  check("KILL sealed envelope never contains the plaintext", !sealed.includes(secret) && !sealed.includes("SUPER-SECRET"), sealed);
  const back = await crypto.unsealText("unit-test-key-material", sealed);
  check("SURVIVES envelope round-trips to the exact plaintext", back === secret);
  // (P1F) the formerly-dead leg is now live: the wrong key material must
  // fail closed, not silently decrypt.
  check("KILL decrypt under the wrong key material fails closed", await crypto.unsealText("wrong-key-material", sealed).then(() => false).catch(() => true));
  // tamper: flip one char of the ciphertext
  const env = JSON.parse(sealed);
  const ct = env.ct;
  env.ct = ct.slice(0, -1) + (ct.endsWith("A") ? "B" : "A");
  const tampered = await crypto.unsealText("unit-test-key-material", JSON.stringify(env)).then(() => "unsealed").catch(() => "rejected");
  check("KILL tampered envelope is rejected (AEAD)", tampered === "rejected", tampered);
  check("KILL unknown envelope version fails closed", (await crypto.unsealText("unit-test-key-material", JSON.stringify({ v: 9, iv: env.iv, ct: env.ct })).then(() => false).catch(() => true)) === true);

  const worker = (await import("../worker.mjs")).default;
  const noKekEnv = { VAULT_KEK: undefined, VAULT_TEST_DOUBLE: "0", DB: null };
  const mk = (p) => new Request("https://vault.internal" + p, { method: "POST", headers: attrs(T, A), body: JSON.stringify({ tenant: T, owner: A, name: "x", host: "h.test", kind: "bearer", value: "v" }) });
  const r1 = await worker.fetch(mk("/vault/save"), noKekEnv, {});
  const r2 = await worker.fetch(mk("/vault/secret-state"), noKekEnv, {});
  const r3 = await worker.fetch(mk("/vault/oauth/fetch"), noKekEnv, {});
  const r4 = await worker.fetch(mk("/vault/revoke"), noKekEnv, {});
  check("KILL KEK missing → save 503 vault-unreachable", r1.status === 503 && (await r1.json()).error.code === "vault-unreachable");
  check("KILL KEK missing → secret-state 503 (every call fails closed)", r2.status === 503);
  check("KILL KEK missing → oauth.fetch 503", r3.status === 503);
  check("KILL KEK missing → revoke 503", r4.status === 503);

  console.log("\n[unit] D-3 errJson logs the constructor name, never the message");
  const { default: _workerMod, errJson } = await import("../worker.mjs");
  const { VaultError } = await import("../src/vault.mjs");
  const savedErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(" "));
  try {
    errJson(new Error("P1R-PLAINTEXT-LEAK-SECRET"), "req-d3-001");
  } finally {
    console.error = savedErr;
  }
  check("KILL errJson logs the constructor name + request id, never e.message", captured.length === 1 && !captured[0].includes("P1R-PLAINTEXT-LEAK-SECRET") && captured[0].includes("Error") && captured[0].includes("req-d3-001"), captured.join(" | "));
  const before = captured.length;
  const saved2 = console.error;
  console.error = (...a) => captured.push(a.join(" "));
  try {
    errJson(new VaultError("wrong-owner", 403, "Denied."), "req-d3-002");
  } finally {
    console.error = saved2;
  }
  check("SURVIVES errJson does not log VaultErrors", captured.length === before, captured.join(" | "));

  console.log("\n[unit] D-3 a corrupted (non-object) unsealed value never escapes as a SyntaxError");
  const { createVault } = await import("../src/vault.mjs");
  const kekUnit = "unit-kek-0123456789abcdef";
  const dekUnit = "unit-dek-0123456789abcdef0123456789abcdef";
  const wrappedDek = await crypto.sealText(kekUnit, dekUnit);
  const badSealed = await crypto.sealText(dekUnit, "P1R-PLAINTEXT-LEAK-SECRET"); // a bare string, not an object
  const fakeDb = makeFakeDb({
    dillo_secret_keys: { version: 1, wrapped_dek: wrappedDek, kek_version: 1 },
    dillo_secrets: { id: "sec_corrupt", tenant_id: T, owner_id: A, name: "corrupt-oauth", kind: "oauth", provider: "google", host: "mail.test", sealed: badSealed, key_version: 1, fingerprint: null, last4: "", scopes: null, state: "ok", expires_at: null, created_at: 1, updated_at: 1 },
  });
  const vUnit = createVault(fakeDb, { VAULT_KEK: kekUnit });
  let corruptOut = null;
  try {
    await vUnit.oauth.fetch({ tenant: T, owner: A, name: "corrupt-oauth", purpose: "proof", actor: { tenant: T, owner: A, recovery: false, sessionHash: "", callerId: CONSOLE, callerSecret: CONSOLE_SECRET } });
    corruptOut = "no-error";
  } catch (e) {
    corruptOut = e instanceof VaultError ? `VaultError:${e.code}` : `raw:${e.constructor.name}`;
  }
  check("KILL corrupted/unsealed oauth value → VaultError:secret-unavailable (no raw SyntaxError)", corruptOut === "VaultError:secret-unavailable", String(corruptOut));

  console.log("\n[unit] D-1b grant mint: console-only + logged with the verified actor");
  const capDb = makeFakeDb({});
  const vGrant = createVault(capDb, { VAULT_KEK: "unit-kek-0123456789abcdef", VAULT_CONSOLE_SECRET: "unit-console-caller-secret" });
  const consoleActor = { tenant: T, owner: A, recovery: false, sessionHash: "", callerId: CONSOLE, callerSecret: "unit-console-caller-secret" };
  const mint = await vGrant.grant({ tenant: T, owner: A, caller: FLOWS, callerSecret: "unit-flows-caller-secret", name: "s", operation: "read", actor: consoleActor });
  check("SURVIVES the console (owner) mints a grant", !!mint && !!mint.grantId && mint.caller === FLOWS, JSON.stringify(mint));
  const grantInsert = capDb.statements.find((s) => s.sql.includes("INSERT INTO dillo_vault_grants"));
  check("KILL mint wrote a dillo_vault_grants row for the named caller", !!grantInsert && grantInsert.params[1] === FLOWS, JSON.stringify(grantInsert && grantInsert.params));
  const logInsert = capDb.statements.find((s) => s.sql.includes("INSERT INTO dillo_secret_access_log") && s.params[5] === "grant" && s.params[8] === "allowed");
  check("KILL mint logged with the verified actor (owner, allowed)", !!logInsert && logInsert.params[2] === A, JSON.stringify(logInsert && logInsert.params));

  let anonMint = null;
  try {
    await vGrant.grant({ tenant: T, owner: A, caller: "evil", callerSecret: "evil-caller-no-grant", name: "s", operation: "read", actor: { tenant: T, owner: A, recovery: false, sessionHash: "" } });
    anonMint = "no-error";
  } catch (e) { anonMint = e instanceof VaultError ? `VaultError:${e.code}` : `raw:${e.constructor.name}`; }
  check("KILL an anonymous bound caller cannot mint a grant (D-1b)", anonMint === "VaultError:not-granted", String(anonMint));

  let flowsMint = null;
  try {
    await vGrant.grant({ tenant: T, owner: A, caller: "evil2", callerSecret: "evil-caller-no-grant", name: "s", operation: "read", actor: { tenant: T, owner: A, recovery: false, sessionHash: "", callerId: FLOWS, callerSecret: FLOWS_SECRET } });
    flowsMint = "no-error";
  } catch (e) { flowsMint = e instanceof VaultError ? `VaultError:${e.code}` : `raw:${e.constructor.name}`; }
  check("KILL a named caller (flows) cannot mint a grant (D-1b)", flowsMint === "VaultError:not-granted", String(flowsMint));
}

// ---------- HTTP legs ----------
async function httpLegs() {
  console.log("\n[http] attestation + authorization");
  let r = await vcall("/vault/secret-state", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "nope" } });
  check("SURVIVES unknown secret → state missing (not an error)", r.status === 200 && r.json.ok === true && r.json.state === "missing", r.text);

  r = await vcall("/vault/secret-state", { tenant: T, owner: A, body: { tenant: "OTHER", owner: A, name: "nope" } });
  check("KILL wrong tenant → 403 wrong-tenant", r.status === 403 && r.json.error.code === "wrong-tenant", r.text);

  r = await vcall("/vault/secret-state", { tenant: T, owner: A, body: { tenant: T, owner: "OTHER", name: "nope" } });
  check("KILL wrong owner (attestation mismatch) → 403 wrong-owner", r.status === 403 && r.json.error.code === "wrong-owner", r.text);

  r = await vcall("/vault/secret-state", { tenant: "", owner: "", body: { tenant: T, owner: A, name: "nope" } });
  check("KILL no-session (missing attestation headers) → 401", r.status === 401 && r.json.error.code === "no-session", r.text);

  r = await vcall("/vault/secret-state", { tenant: T, owner: A, body: "{not json" });
  check("KILL non-JSON body → 400 bad-request", r.status === 400 && r.json.error.code === "bad-request", r.text);

  r = await vcall("/vault/secret-state", { tenant: T, owner: A, method: "GET" });
  check("KILL method confusion (GET) → 405", r.status === 405, r.text);

  r = await vcall("/vault/does-not-exist", { tenant: T, owner: A, body: { tenant: T, owner: A } });
  check("KILL unknown route → 404", r.status === 404, r.text);

  r = await vcall("/vault/present", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "x" } });
  check("KILL present from a non-binding caller → 403 not-granted", r.status === 403 && r.json.error.code === "not-granted", r.text);

  const big = "x".repeat(70 * 1024);
  r = await vcall("/vault/save", { tenant: T, owner: A, body: big });
  check("KILL oversized payload → 413", r.status === 413, String(r.status));

  console.log("\n[http] owner isolation");
  const aliceKey = await save(T, A, { name: "alice-key", kind: "bearer", host: "api.a.test", value: "ALICE-VALUE-1234" });
  await save(T, B, { name: "bob-key", kind: "bearer", host: "api.b.test", value: "BOB-VALUE-9999" });

  r = await vcall("/vault/secret-state", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "bob-key" } });
  check("KILL owner A reads B's secret-state → 403 wrong-owner", r.status === 403 && r.json.error.code === "wrong-owner", r.text);

  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: "does-not-exist" } });
  check("KILL get by foreign id → 403 not-granted (no enumeration)", r.status === 403 && r.json.error.code === "not-granted", r.text);

  r = await vcall("/vault/secret-state", { tenant: T, owner: B, body: { tenant: T, owner: B, name: "bob-key" } });
  check("SURVIVES owner B reads own secret-state ok", r.status === 200 && r.json.state === "ok", r.text);

  const own = await save(T, A, { name: "alice-read", kind: "bearer", host: "api.a.test", value: "ALICE-READ-ME-55" });
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: own.json.secretId } });
  check("SURVIVES the console (owner) reads its own secret by id (decrypted in memory)", r.status === 200 && r.json.value === "ALICE-READ-ME-55", r.text);
  r = await vcall("/vault/get", { tenant: T, owner: B, headers: consoleHeaders, body: { tenant: T, owner: B, secretId: own.json.secretId } });
  check("KILL owner B (console) reads A's secret by id → 403 not-granted (owner bound IN THE QUERY — envelope never selected, D-5)", r.status === 403 && r.json.error.code === "not-granted", r.text);

  console.log("\n[http] D-2 cross-owner overwrite refused");
  const hijack = await save(T, B, { name: "alice-key", kind: "bearer", host: "api.b.test", value: "B-HIJACK-VALUE" });
  check("KILL owner B's save over A's (tenant, name) → refused (403 wrong-owner)", hijack.status === 403 && hijack.json.error.code === "wrong-owner", hijack.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: aliceKey.json.secretId } });
  check("SURVIVES A's secret still reads after B's hijack attempt", r.status === 200 && r.json.value === "ALICE-VALUE-1234", r.text);

  console.log("\n[http] revoke + replay + rotation");
  const revokeMe = await save(T, A, { name: "revokeme", kind: "bearer", host: "api.r.test", value: "REVOKE-ME-VALUE" });
  r = await vcall("/vault/revoke", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "revokeme" } });
  check("SURVIVES revoke → {state:revoked}", r.status === 200 && r.json.state === "revoked", r.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: revokeMe.json.secretId } });
  check("KILL get on a revoked secret → 409 revoked (crypto-shredded, not readable)", r.status === 409 && r.json.error.code === "revoked", r.text);
  const revokedFace = await vcall("/vault/secret-state", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "revokeme" } });
  check("SURVIVES revoked secret-state reports revoked", revokedFace.json.state === "revoked", revokedFace.text);
  r = await vcall("/vault/revoke", { tenant: T, owner: B, body: { tenant: T, owner: B, name: "revokeme" } });
  check("KILL another owner revoking A's secret → 403 wrong-owner", r.status === 403 && r.json.error.code === "wrong-owner", r.text);

  const rot = await save(T, A, { name: "rotate-me", kind: "bearer", host: "api.rot.test", value: "ROTATE-ME-VALUE" });
  r = await vcall("/vault/rotate", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "rotate-me" } });
  check("SURVIVES rotate → new keyVersion, state ok", r.status === 200 && r.json.state === "ok" && Number.isInteger(r.json.keyVersion), r.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: rot.json.secretId } });
  check("SURVIVES rotated secret still decrypts to the same value", r.status === 200 && r.json.value === "ROTATE-ME-VALUE", r.text);

  console.log("\n[http] D-4 rotate one secret must not brick a sibling");
  const sib1 = await save(T, A, { name: "sib-1", kind: "bearer", host: "api.s1.test", value: "SIB-ONE-VALUE" });
  const sib2 = await save(T, A, { name: "sib-2", kind: "bearer", host: "api.s2.test", value: "SIB-TWO-VALUE" });
  r = await vcall("/vault/rotate", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "sib-2" } });
  check("SURVIVES sib-2 rotates to a new key version", r.status === 200 && Number.isInteger(r.json.keyVersion), r.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: sib2.json.secretId } });
  check("SURVIVES sib-2 readable after its own rotate", r.status === 200 && r.json.value === "SIB-TWO-VALUE", r.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: sib1.json.secretId } });
  check("SURVIVES sib-1 (same tenant) still decrypts after sib-2 rotated its DEK", r.status === 200 && r.json.value === "SIB-ONE-VALUE", r.text);

  console.log("\n[http] oauth dance (mock grants — fixtures, never a real consent)");
  await save("house", "house", { name: "oauth-app:google", kind: "oauth-app", host: "oauth2.googleapis.com", value: { clientId: "mock-client-id", clientSecret: "mock-client-secret", redirectUri: "https://vault.internal/oauth/google/callback" } });
  r = await vcall("/vault/oauth/start", { tenant: T, owner: A, body: { tenant: T, owner: A, provider: "google", name: "gcal" } });
  check("SURVIVES oauth.start returns an authorizeUrl (mock app registered)", r.status === 200 && /accounts\.google\.com/.test(r.json.authorizeUrl), r.text);
  const state = new URL(r.json.authorizeUrl).searchParams.get("state");
  check("SURVIVES authorizeUrl carries a state", !!state);
  const cb = await fetch(base + `/oauth/google/callback?code=mock-code&state=${encodeURIComponent(state)}`);
  check("SURVIVES callback exchanges the mock grant → Connected page", cb.status === 200 && (await cb.text()).includes("Connected"));
  r = await vcall("/vault/oauth/status", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "gcal" } });
  check("SURVIVES oauth.status → state ok after connect", r.status === 200 && r.json.state === "ok", r.text);
  r = await vcall("/vault/oauth/fetch", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, name: "gcal", purpose: "proof" } });
  check("SURVIVES oauth.fetch mints a transient token", r.status === 200 && typeof r.json.accessToken === "string" && r.json.accessToken.length > 0, r.text);
  const cb2 = await fetch(base + `/oauth/google/callback?code=mock-code&state=${encodeURIComponent(state)}`);
  check("KILL replayed oauth state is refused (single-use)", cb2.status === 400);

  console.log("\n[http] D-2 oauth.start cannot hijack a connection name");
  r = await vcall("/vault/oauth/start", { tenant: T, owner: B, body: { tenant: T, owner: B, provider: "google", name: "gcal" } });
  check("KILL owner B's oauth.start under A's name → refused (403 wrong-owner)", r.status === 403 && r.json.error.code === "wrong-owner", r.text);

  console.log("\n[http] D-3 non-object oauth value rejected at save");
  r = await save(T, A, { name: "bad-oauth", kind: "oauth", host: "mail.test", value: "P1R-NOT-AN-OBJECT" });
  check("KILL non-object oauth value rejected at save (400 bad-request)", r.status === 400 && r.json.error.code === "bad-request", r.text);

  console.log("\n[http] D-1 per-caller grant boundary + NEVER_PRESENTABLE");
  // D-1a: the console (owner) reads its own secrets as the reserved
  // `console` caller, its grants minted at connect (save / oauth.complete).
  // Flows is a separate named caller with its own secret; its grant is
  // minted here by the console (D-1b).
  r = await vcall("/vault/grant", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, caller: FLOWS, callerSecret: FLOWS_SECRET, name: "gcal", operation: "oauth-fetch" } });
  check("SURVIVES the console mints a flows grant for gcal (oauth-fetch)", r.status === 200 && r.json.grantId && r.json.caller === FLOWS, r.text);
  r = await vcall("/vault/oauth/fetch", { tenant: T, owner: A, headers: flowsHeaders, body: { tenant: T, owner: A, name: "gcal", purpose: "granted" } });
  check("SURVIVES named caller WITH a grant for gcal fetches it", r.status === 200 && typeof r.json.accessToken === "string", r.text);
  r = await vcall("/vault/oauth/fetch", { tenant: T, owner: A, headers: flowsHeaders, body: { tenant: T, owner: A, name: "bob-key", purpose: "not-granted" } });
  check("KILL named caller with a grant for one secret cannot fetch another", r.status === 403 && r.json.error.code === "not-granted", r.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: { "x-vault-caller": "rogue", "x-vault-caller-secret": "rogue-caller-no-grant" }, body: { tenant: T, owner: A, secretId: aliceKey.json.secretId } });
  check("KILL a NAMED caller without a grant → denied (403 not-granted)", r.status === 403 && r.json.error.code === "not-granted", r.text);
  r = await vcall("/vault/oauth/fetch", { tenant: T, owner: A, headers: { "x-vault-caller": "flows", "x-vault-caller-secret": "WRONG-SECRET" }, body: { tenant: T, owner: A, name: "gcal", purpose: "bad-secret" } });
  check("KILL a named caller with the wrong secret is denied (grant checked in the query)", r.status === 403 && r.json.error.code === "not-granted", r.text);

  console.log("\n[http] D-1a caller identity is mandatory on every value path");
  r = await vcall("/vault/get", { tenant: T, owner: A, body: { tenant: T, owner: A, secretId: aliceKey.json.secretId } });
  check("KILL /vault/get with NO caller header → 403 not-granted", r.status === 403 && r.json.error.code === "not-granted", r.text);
  r = await vcall("/vault/oauth/fetch", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "gcal", purpose: "anon" } });
  check("KILL /vault/oauth/fetch with NO caller header → 403 not-granted", r.status === 403 && r.json.error.code === "not-granted", r.text);
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: { "x-vault-caller": A, "x-vault-caller-secret": "owner-caller-no-grant" }, body: { tenant: T, owner: A, secretId: aliceKey.json.secretId } });
  check("KILL /vault/get with x-vault-caller == owner id (the old escape, no grant) → 403 not-granted", r.status === 403 && r.json.error.code === "not-granted", r.text);

  console.log("\n[http] D-1b grant minting requires proof of the owner");
  r = await vcall("/vault/grant", { tenant: T, owner: A, body: { tenant: T, owner: A, caller: "evil", callerSecret: "evil-caller-fixture", name: "gcal", operation: "oauth-fetch" } });
  check("KILL anonymous bound caller mints a grant → 403 not-granted", r.status === 403 && r.json.error.code === "not-granted", r.text);
  r = await vcall("/vault/grant", { tenant: T, owner: A, headers: flowsHeaders, body: { tenant: T, owner: A, caller: "evil2", callerSecret: "evil-caller-fixture", name: "gcal", operation: "oauth-fetch" } });
  check("KILL the flows caller mints a grant → 403 not-granted", r.status === 403 && r.json.error.code === "not-granted", r.text);
  r = await vcall("/vault/grant", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, caller: FLOWS, callerSecret: FLOWS_SECRET, name: "alice-read", operation: "read" } });
  check("SURVIVES the console mints a read grant for alice-read (200)", r.status === 200 && r.json.grantId && r.json.operation === "read", r.text);

  const vs = await save(T, A, { name: "verify-secret-1", kind: "verify-secret", host: "verify.test", value: "VS-PRESENT-NEVER" });
  r = await vcall("/vault/get", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, secretId: vs.json.secretId } });
  check("KILL NEVER_PRESENTABLE kind is never returned by get (verify-secret)", r.status === 403 && r.json.error.code === "not-presentable", r.text);

  console.log("\n[http] session-hash opacity + concurrency");
  const s1 = await vcall("/vault/secret-state", { tenant: T, owner: A, sessionHash: "replay-hash-aaaa", body: { tenant: T, owner: A, name: "alice-key" } });
  const s2 = await vcall("/vault/secret-state", { tenant: T, owner: A, sessionHash: "replay-hash-aaaa", body: { tenant: T, owner: A, name: "alice-key" } });
  check("WOUND replayed session hash grants nothing new (opaque; same owner, same state)", s1.status === 200 && s2.status === 200 && s1.json.state === s2.json.state);
  r = await vcall("/vault/secret-state", { tenant: T, owner: B, sessionHash: "replay-hash-aaaa", body: { tenant: T, owner: B, name: "alice-key" } });
  check("KILL replayed session hash with wrong owner → 403 wrong-owner", r.status === 403 && r.json.error.code === "wrong-owner", r.text);

  await save(T, A, { name: "race-oauth", kind: "oauth", host: "mail.test", value: { accessToken: "RACE-TOKEN", refreshToken: "RACE-REFRESH", expiresAt: Date.now() + 3600e3, account: "a@example.test", tokenType: "Bearer" } });
  const [rev, fet] = await Promise.all([
    vcall("/vault/revoke", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "race-oauth" } }),
    vcall("/vault/oauth/fetch", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, name: "race-oauth", purpose: "race" } }),
  ]);
  const afterRace = await vcall("/vault/oauth/fetch", { tenant: T, owner: A, headers: consoleHeaders, body: { tenant: T, owner: A, name: "race-oauth", purpose: "race" } });
  check("KILL concurrent revoke+fetch leaves the secret revoked (fetch after race → revoked/needs-reconnect)", afterRace.status === 409 && (afterRace.json.error.code === "revoked" || afterRace.json.error.code === "needs-reconnect"), afterRace.text);

  console.log("\n[http] no value in any response");
  r = await save(T, A, { name: "echo-check", kind: "bearer", host: "api.e.test", value: "DO-NOT-ECHO-VALUE-77" });
  check("SURVIVES save response never echoes the value", !JSON.stringify(r.json).includes("DO-NOT-ECHO-VALUE-77"), r.text);
  const echoState = await vcall("/vault/secret-state", { tenant: T, owner: A, body: { tenant: T, owner: A, name: "echo-check" } });
  check("SURVIVES secret-state never echoes the value", !echoState.text.includes("DO-NOT-ECHO-VALUE-77"), echoState.text);
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

function killTree(child) {
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function main() {
  let child = null;
  if (!target) {
    const kek = randomBytes(32).toString("base64");
    // Apply the Vault's DDL to the local miniflare D1 (wrangler dev reads
    // the same persisted store; migrations are NOT auto-applied by dev).
    const mig = await run("npx", ["--yes", "wrangler", "d1", "migrations", "apply", "DB", "--local"], vaultDir);
    check("SURVIVES local D1 migrations applied", mig.code === 0, (mig.out.match(/commands executed successfully/) || [""])[0]);
    console.log(`spawning wrangler dev on :${port} (throwaway KEK, throwaway console secret, mock grants)`);
    child = spawn("npx", ["--yes", "wrangler", "dev", "--port", String(port), "--var", `VAULT_KEK:${kek}`, "--var", `VAULT_CONSOLE_SECRET:${CONSOLE_SECRET}`, "--var", "VAULT_TEST_DOUBLE:1"], {
      cwd: vaultDir, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    });
    child.stdout.on("data", (d) => process.env.VAULT_DEV_DEBUG ? process.stdout.write(d) : null);
    child.stderr.on("data", (d) => process.env.VAULT_DEV_DEBUG ? process.stderr.write(d) : null);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + "/health"); if (r.ok) { ready = true; break; } } catch {}
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!ready) {
      console.error("FAIL: wrangler dev did not become ready");
      killTree(child);
      process.exit(1);
    }
  }

  const health = await fetch(base + "/health");
  const h = await health.json();
  check("SURVIVES /health ok + names the service", health.ok && h.service === "29court-vault", JSON.stringify(h));

  await unitLegs();
  await httpLegs();

  const pass = checks.filter((c) => c[1]).length;
  console.log(`\nDillo Vault proof: ${pass}/${checks.length}`);
  killTree(child);
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((e) => { console.error("proof crashed:", e); process.exit(1); });
