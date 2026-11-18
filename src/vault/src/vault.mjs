// Dillo Vault — core (VAULT-SPEC build). A Dillo primitive: the secrets
// store every integration Flows brokers depends on. Envelope encryption
// under a master KEK read by name only (`vault-master-kek` binding); no
// KEK material, DEK, token, or plaintext lives in this module, a log, or
// a return shape. Authorization is enforced in the query (owner match),
// not checked after the fact. Every mint/read/rotate/revoke is logged.
//
// This module is reached only over the in-account service binding
// SVC_VAULT; the Worker (worker.mjs) is its one HTTP front door. The
// consumer contract it answers is the Flows-published one (headers
// x-vault-tenant / x-vault-owner / x-vault-recovery / x-vault-session-hash;
// endpoints /vault/secret-state, /vault/present, /vault/oauth/fetch,
// /vault/oauth/status, /vault/revoke) plus VAULT-SPEC's create/read/
// rotate/mint additions (/vault/save, /vault/get, /vault/rotate,
// /vault/oauth/*).
import {
  sealText, unsealText, sha256Hex, fingerprintOf, last4Of,
  randomBytes, randomHex, b64urlEncode,
} from "./crypto.mjs";
import { getProvider } from "./providers.mjs";

export const HOUSE_TENANT = "house";
export const HOUSE_OWNER = "house";
export const STATE_TTL_MS = 10 * 60 * 1000; // oauth state single-use TTL
export const REFRESH_WINDOW_MS = 60 * 1000; // proactive refresh window
export const LEASE_TTL_MS = 30 * 1000; // refresh lease

const KNOWN_KINDS = new Set(["oauth", "api-key", "bearer", "basic", "verify-secret", "mock", "oauth-app"]);
const NEVER_PRESENTABLE = new Set(["oauth-app", "verify-secret"]);
const CONSOLE_CALLER = "console"; // reserved caller id for the owner's own console (D-1a/D-1b)

export class VaultError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

function newId(prefix) {
  return `${prefix}_${randomHex(12)}`;
}

export function createVault(db, env, opts = {}) {
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetchImpl || fetch;
  const testDouble = opts.testDouble || null;

  function kekMaterial() {
    const k = env.VAULT_KEK;
    if (!k || typeof k !== "string" || k.length < 16) {
      // Absent KEK ⇒ every call fails closed. The KEK arrives only as a
      // Secrets Store binding, by reference; never a reason to store
      // unsealed.
      throw new VaultError("vault-unreachable", 503, "vault key unavailable");
    }
    return k;
  }

  async function logAccess(e) {
    // One row per attempt. An intent write that fails fails the call
    // closed. Never carries a value, envelope, token, code, or verifier.
    await db
      .prepare(
        `INSERT INTO dillo_secret_access_log
         (at, tenant_id, actor_id, session_hash, secret_id, operation, purpose, key_version, decision, reason, fingerprint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        now(), e.tenantId, e.actorId, e.sessionHash || null, e.secretId || "",
        e.operation, e.purpose || null, e.keyVersion ?? null,
        e.decision, e.reason || null, e.fingerprint || null,
      )
      .run();
  }

  async function logDenied(tenantId, actor, secretId, operation, reason, purpose) {
    try {
      await logAccess({
        tenantId, actorId: actor?.owner || "unknown", sessionHash: actor?.sessionHash || null,
        secretId, operation, purpose: purpose || null, decision: "denied", reason,
      });
    } catch {
      // A denied attempt that leaves no record did not happen — but a
      // logging failure on an already-denied call must not mask the
      // denial itself; the denial stands.
    }
  }

  // --- attestation (interim chain) ---------------------------------------
  // `actor` is attested by the calling worker AFTER its own requireSession:
  // {tenant, owner, recovery, sessionHash}. The Vault never sees the
  // session token itself — sessionHash is its SHA-256, opaque here.
  function checkActor(actor, { tenant, owner, allowRecovery = false } = {}) {
    if (!actor || !actor.tenant || !actor.owner) {
      throw new VaultError("no-session", 401, "Not signed in.");
    }
    if (tenant !== undefined && actor.tenant !== tenant) {
      throw new VaultError("wrong-tenant", 403, "Denied.");
    }
    if (owner !== undefined && actor.owner !== owner) {
      throw new VaultError("wrong-owner", 403, "Denied.");
    }
    if (!allowRecovery && actor.recovery) {
      throw new VaultError("recovery-session", 403, "Denied.");
    }
    return actor;
  }

  // --- keys ----------------------------------------------------------------
  // Per-tenant DEK, wrapped by the master KEK. The DEK is a fresh random
  // 32-byte value per tenant version; the KEK wraps it; the secret's
  // key_version references the DEK row. Never a bare DEK or master key in
  // storage.
  async function ensureTenantDek(tenantId) {
    const existing = await getTenantDek(tenantId).catch(() => null);
    if (existing) return existing;
    return mintTenantDek(tenantId);
  }

  async function getTenantDek(tenantId, version) {
    const kek = kekMaterial();
    let row;
    if (version != null) {
      row = await db
        .prepare(`SELECT version, wrapped_dek, kek_version FROM dillo_secret_keys WHERE tenant_id = ?1 AND version = ?2`)
        .bind(tenantId, version).first();
    } else {
      row = await db
        .prepare(`SELECT version, wrapped_dek, kek_version FROM dillo_secret_keys WHERE tenant_id = ?1 AND retired_at IS NULL ORDER BY version DESC LIMIT 1`)
        .bind(tenantId).first();
    }
    if (!row) throw new VaultError("key-version-unknown", 503, "secret-unavailable");
    const dek = await unsealText(kek, row.wrapped_dek).catch(() => {
      throw new VaultError("key-version-unknown", 503, "secret-unavailable");
    });
    return { version: row.version, kekVersion: row.kek_version, dek };
  }

  async function mintTenantDek(tenantId) {
    const kek = kekMaterial();
    const dek = randomHex(32);
    const wrapped = await sealText(kek, dek);
    const nextRow = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS m FROM dillo_secret_keys`).bind().first();
    const nextVersion = (nextRow?.m ?? 0) + 1;
    try {
      await db
        .prepare(`INSERT INTO dillo_secret_keys (version, tenant_id, wrapped_dek, kek_version, algorithm, created_at, created_by)
                  VALUES (?1, ?2, ?3, ?4, 'AES-GCM-256', ?5, 'deploy')`)
        .bind(nextVersion, tenantId, wrapped, 1, now()).run();
    } catch {
      const again = await db
        .prepare(`SELECT version, wrapped_dek, kek_version FROM dillo_secret_keys WHERE tenant_id = ?1 AND retired_at IS NULL ORDER BY version DESC LIMIT 1`)
        .bind(tenantId).first();
      if (!again) throw new VaultError("vault-unreachable", 503, "cannot-seal — vault key unavailable");
      return { version: again.version, kekVersion: again.kek_version, dek: await unsealText(kek, again.wrapped_dek) };
    }
    return { version: nextVersion, kekVersion: 1, dek };
  }

  // Unseal + parse an object value. A non-object plaintext (or corrupt
  // envelope) fails closed as VaultError("secret-unavailable") — never a
  // raw V8 SyntaxError whose message embeds the plaintext prefix (D-3).
  async function parseUnsealedObject(dek, sealed) {
    const text = await unsealText(dek, sealed).catch(() => {
      throw new VaultError("secret-unavailable", 503, "secret-unavailable");
    });
    try {
      const value = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not-an-object");
      }
      return value;
    } catch {
      throw new VaultError("secret-unavailable", 503, "secret-unavailable");
    }
  }

  function publicFace(row, extra = {}) {
    return {
      secretId: row.id, name: row.name, tenant: row.tenant_id, kind: row.kind,
      provider: row.provider || null, host: row.host, fingerprint: row.fingerprint || null,
      last4: row.last4 || null, scopes: row.scopes || null, state: row.state,
      keyVersion: row.key_version, createdAt: row.created_at, updatedAt: row.updated_at,
      ...extra,
    };
  }

  async function findSecret(tenantId, { name, secretId } = {}) {
    if (secretId) {
      return db.prepare(`SELECT * FROM dillo_secrets WHERE id = ?1 AND tenant_id = ?2`).bind(secretId, tenantId).first();
    }
    return db.prepare(`SELECT * FROM dillo_secrets WHERE tenant_id = ?1 AND name = ?2`).bind(tenantId, name).first();
  }

  // Value paths: owner bound IN THE QUERY (VAULT-SPEC §Security, D-5) AND
  // caller identity mandatory (D-1a). A named caller — a bound Worker that
  // presents x-vault-caller — must hold a matching dillo_vault_grants row,
  // enforced in the SAME SELECT, so the sealed envelope is never selected
  // without a grant. The owner's own console is itself a named caller
  // (`console`) with its own secret; its read/fetch grants are minted at
  // connect time (save / oauth.complete).
  function consoleSecret() {
    const s = env.VAULT_CONSOLE_SECRET;
    if (!s || typeof s !== "string" || s.length < 16) return null;
    return s;
  }

  async function isConsoleCaller(actor) {
    const id = (actor && actor.callerId) || "";
    const secret = (actor && actor.callerSecret) || "";
    const cs = consoleSecret();
    if (id !== CONSOLE_CALLER || !secret || !cs) return false;
    return (await sha256Hex(secret)) === (await sha256Hex(cs));
  }

  async function resolveCaller(actor, operation) {
    // D-1a: caller identity is mandatory on every value path. No caller
    // header (or no caller secret) ⇒ 403 not-granted, before any SELECT.
    // The old `id === owner` escape is gone: the owner's console reads as
    // the reserved `console` caller, authenticated by its caller secret.
    const id = (actor && actor.callerId) || "";
    const secret = (actor && actor.callerSecret) || "";
    if (!id || !secret) {
      throw new VaultError("not-granted", 403, "Denied.");
    }
    return { id, secretHash: await sha256Hex(secret), operation };
  }

  async function findSecretOwned(tenantId, ownerId, { name, secretId }, caller) {
    const sel = secretId ? `id = ?1 AND tenant_id = ?2 AND owner_id = ?3` : `tenant_id = ?1 AND owner_id = ?2 AND name = ?3`;
    const bind = secretId ? [secretId, tenantId, ownerId] : [tenantId, ownerId, name];
    if (caller) {
      // D-1a: the ONLY value-read path — the grant EXISTS subquery runs in
      // the SAME SELECT, so the envelope is never selected without a grant.
      const where = secretId ? `s.id = ?1 AND s.tenant_id = ?2 AND s.owner_id = ?3` : `s.tenant_id = ?1 AND s.owner_id = ?2 AND s.name = ?3`;
      return db.prepare(
        `SELECT s.* FROM dillo_secrets s WHERE ${where}
           AND EXISTS (SELECT 1 FROM dillo_vault_grants g
             WHERE g.caller_id = ?4 AND g.caller_secret_hash = ?5
               AND g.tenant_id = s.tenant_id AND g.owner_id = s.owner_id
               AND g.secret_name = s.name AND g.operation = ?6)`,
      ).bind(...bind, caller.id, caller.secretHash, caller.operation).first();
    }
    // Owner-bound, non-value paths (rotate) only — never a value read.
    return db.prepare(`SELECT * FROM dillo_secrets WHERE ${sel}`).bind(...bind).first();
  }

  // Cross-owner write guard (D-2): a save/oauth-start/complete must never
  // overwrite a (tenant, name) owned by another owner.
  async function assertNotHijack(tenantId, name, ownerId) {
    const existing = await db
      .prepare(`SELECT id, owner_id FROM dillo_secrets WHERE tenant_id = ?1 AND name = ?2`)
      .bind(tenantId, name).first();
    if (existing && existing.owner_id !== ownerId) {
      throw new VaultError("wrong-owner", 403, "Denied.");
    }
  }

  // D-3: oauth / oauth-app values must be structural objects (never a bare
  // string whose JSON.parse would leak a prefix). Rejected here, at save.
  function validateSecretValue(kind, value) {
    const isObj = typeof value === "object" && value !== null && !Array.isArray(value);
    if (kind === "oauth") {
      if (!isObj || typeof value.accessToken !== "string" || !value.accessToken) {
        throw new VaultError("bad-request", 400, "oauth value must be an object with an accessToken");
      }
    } else if (kind === "oauth-app") {
      if (!isObj || typeof value.clientId !== "string" || typeof value.clientSecret !== "string" || typeof value.redirectUri !== "string") {
        throw new VaultError("bad-request", 400, "oauth-app value must be an object with clientId, clientSecret, redirectUri");
      }
    }
  }

  // Broker-internal read of a house app registration. Callable ONLY from
  // this module's own oauth.start/complete/refresh paths. Returns the pair
  // in memory only; the caller never logs, stores, or returns it.
  async function readAppRegistration(provider) {
    const row = await db
      .prepare(`SELECT * FROM dillo_secrets WHERE tenant_id = ?1 AND owner_id = ?2 AND name = ?3 AND kind = 'oauth-app'`)
      .bind(HOUSE_TENANT, HOUSE_OWNER, `oauth-app:${provider}`).first();
    if (!row || !row.sealed) return null;
    try {
      const { dek } = await getTenantDek(HOUSE_TENANT, row.key_version);
      const value = await parseUnsealedObject(dek, row.sealed);
      return { row, clientId: value.clientId, clientSecret: value.clientSecret, redirectUri: value.redirectUri };
    } catch {
      return null;
    }
  }

  // --- save ---------------------------------------------------------------
  async function save({ tenant, owner, name, kind, host, value, provider, scopes, actor }) {
    if (!owner) throw new VaultError("owner-required", 400, "owner is required");
    if (!tenant || !name || !host || value === undefined || value === null) {
      throw new VaultError("bad-request", 400, "tenant, name, host and value are required");
    }
    if (!KNOWN_KINDS.has(kind)) throw new VaultError("bad-request", 400, "unknown kind");
    validateSecretValue(kind, value);
    if (host.includes("*")) throw new VaultError("bad-request", 400, "host must be exact, no wildcards");
    if (kind === "oauth-app" && (tenant !== HOUSE_TENANT || owner !== HOUSE_OWNER)) {
      await logDenied(tenant, actor, "", "create", "not-granted");
      throw new VaultError("not-granted", 403, "Denied.");
    }
    try {
      checkActor(actor, { tenant, owner });
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "create", e.code);
      throw e;
    }
    try {
      await assertNotHijack(tenant, name, owner);
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "create", e.code);
      throw e;
    }
    const valueStr = typeof value === "string" ? value : JSON.stringify(value);
    const { version, dek } = await ensureTenantDek(tenant);
    const sealed = await sealText(dek, valueStr);
    const fp = await fingerprintOf(valueStr);
    const id = newId("sec");
    const t = now();
    const scopesStr = Array.isArray(scopes) ? scopes.join(",") : (scopes || null);
    await db.batch([
      db.prepare(`DELETE FROM dillo_secrets WHERE tenant_id = ?1 AND name = ?2`).bind(tenant, name),
      db.prepare(`INSERT INTO dillo_secrets
        (id, tenant_id, owner_id, name, kind, provider, host, sealed, key_version, fingerprint, last4, scopes, state, expires_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ok', ?13, ?14, ?15)`)
        .bind(id, tenant, owner, name, kind, provider || null, host, sealed, version, fp, last4Of(valueStr), scopesStr,
          typeof value === "object" && value !== null && typeof value.expiresAt === "number" ? value.expiresAt : null, t, t),
    ]);
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: id,
      operation: "create", keyVersion: version, decision: "allowed", fingerprint: fp,
    });
    await mintConsoleGrants(tenant, owner, name);
    const extra = {};
    if (kind === "oauth-app" && typeof value === "object" && value !== null) extra.clientId = value.clientId || null;
    return publicFace({
      id, tenant_id: tenant, owner_id: owner, name, kind, provider, host, fingerprint: fp,
      last4: last4Of(valueStr), scopes: scopesStr, state: "ok", key_version: version, created_at: t, updated_at: t,
    }, extra);
  }

  // --- status (metadata only; never refreshes, never decrypts) -----------
  async function secretState({ tenant, owner, name, actor }) {
    try {
      checkActor(actor, { tenant, owner, allowRecovery: true });
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "fetch", e.code);
      throw e;
    }
    const row = await findSecret(tenant, { name });
    if (!row) return { state: "missing", checkedAt: now() };
    if (row.owner_id !== owner) {
      await logDenied(tenant, actor, row.id, "fetch", "wrong-owner");
      throw new VaultError("wrong-owner", 403, "Denied.");
    }
    return { state: row.state, fingerprint: row.fingerprint || null, last4: row.last4 || null, checkedAt: now() };
  }

  // --- get (read by id, VAULT-SPEC) --------------------------------------
  // Decrypted in memory, only for the owning user, logged. Never returned
  // to anyone else, to a log, or to an error message.
  async function get({ tenant, owner, secretId, actor }) {
    let caller;
    try {
      checkActor(actor, { tenant, owner });
      caller = await resolveCaller(actor, "read");
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, secretId || "", "read", e.code);
      throw e;
    }
    const row = await findSecretOwned(tenant, owner, { secretId }, caller);
    if (!row) {
      await logDenied(tenant, actor, secretId || "", "read", "not-granted");
      throw new VaultError("not-granted", 403, "Denied.");
    }
    if (NEVER_PRESENTABLE.has(row.kind)) {
      await logDenied(tenant, actor, row.id, "read", "not-presentable");
      throw new VaultError("not-presentable", 403, "Denied.");
    }
    if (row.state !== "ok") {
      await logDenied(tenant, actor, row.id, "read", row.state === "revoked" ? "revoked" : "needs-reconnect");
      throw new VaultError(row.state === "revoked" ? "revoked" : "needs-reconnect", 409, "Denied.");
    }
    const { dek } = await getTenantDek(tenant, row.key_version);
    const value = await unsealText(dek, row.sealed).catch(() => {
      throw new VaultError("secret-unavailable", 503, "secret-unavailable");
    });
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: row.id,
      operation: "read", keyVersion: row.key_version, decision: "allowed", fingerprint: row.fingerprint,
    });
    return { secretId: row.id, name: row.name, kind: row.kind, value };
  }

  // --- present -------------------------------------------------------------
  // Over the service binding, presentForCall is refused BY CONTRACT: the
  // in-process presentation would need the caller's outbound executor,
  // which HTTP cannot carry. oauth.fetch is the one value-carrying path.
  async function present() {
    throw new VaultError("not-granted", 403, "presentForCall runs in-process; use oauth.fetch over this binding.");
  }

  // --- revoke (crypto-shredding) -----------------------------------------
  async function revoke({ tenant, owner, name, actor }) {
    try {
      checkActor(actor, { tenant, owner });
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "revoke", e.code);
      throw e;
    }
    const row = await findSecret(tenant, { name });
    if (!row) throw new VaultError("needs-reconnect", 409, "No connection. Sign in again.");
    if (row.owner_id !== owner) {
      await logDenied(tenant, actor, row.id, "revoke", "wrong-owner");
      throw new VaultError("wrong-owner", 403, "Denied.");
    }
    const t = now();
    await db.prepare(`UPDATE dillo_secrets SET sealed = NULL, state = 'revoked', revoked_at = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(t, t, row.id).run();
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: row.id,
      operation: "revoke", keyVersion: row.key_version, decision: "allowed", fingerprint: row.fingerprint,
    });
    return { secretId: row.id, state: "revoked" };
  }

  // --- rotate (VAULT-SPEC: new version, old retired, never deleted) ------
  async function rotate({ tenant, owner, name, actor }) {
    try {
      checkActor(actor, { tenant, owner });
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "rotate", e.code);
      throw e;
    }
    const row = await findSecretOwned(tenant, owner, { name });
    if (!row || !row.sealed) throw new VaultError("needs-reconnect", 409, "No connection. Sign in again.");
    // Re-seal the SAME value under a fresh DEK (new key version); reads
    // unseal by the row's own key_version, so a retired DEK remains
    // recoverable and siblings are never bricked (D-4).
    const oldDek = await getTenantDek(tenant, row.key_version);
    const valueStr = await unsealText(oldDek.dek, row.sealed).catch(() => {
      throw new VaultError("secret-unavailable", 503, "secret-unavailable");
    });
    const { version: newVersion, dek: newDek } = await mintTenantDek(tenant);
    const sealed = await sealText(newDek, valueStr);
    const t = now();
    await db.prepare(`UPDATE dillo_secrets SET sealed = ?1, key_version = ?2, updated_at = ?3 WHERE id = ?4`).bind(sealed, newVersion, t, row.id).run();
    // Retire the old DEK only when no live row still references it.
    const stillRef = await db.prepare(`SELECT COUNT(*) AS c FROM dillo_secrets WHERE tenant_id = ?1 AND key_version = ?2 AND state != 'revoked'`).bind(tenant, row.key_version).first();
    if (!stillRef || stillRef.c === 0) {
      await db.prepare(`UPDATE dillo_secret_keys SET retired_at = ?1 WHERE tenant_id = ?2 AND version = ?3 AND retired_at IS NULL`).bind(t, tenant, row.key_version).run();
    }
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: row.id,
      operation: "rotate", keyVersion: newVersion, decision: "allowed", fingerprint: row.fingerprint,
    });
    return { secretId: row.id, state: "ok", keyVersion: newVersion };
  }

  // --- oauth.start ---------------------------------------------------------
  async function oauthStart({ tenant, owner, provider, name, scopes, actor }) {
    try {
      checkActor(actor, { tenant, owner });
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "oauth-start", e.code);
      throw e;
    }
    try {
      await assertNotHijack(tenant, name, owner);
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "oauth-start", e.code);
      throw e;
    }
    const reg = getProvider(provider);
    if (!reg) throw new VaultError("bad-request", 400, "unknown provider");
    const app = await readAppRegistration(provider);
    if (!app) {
      await logDenied(tenant, actor, "", "oauth-start", "app-not-registered");
      throw new VaultError("provider-not-set-up", 501, "provider not set up");
    }
    const verifier = b64urlEncode(randomBytes(32));
    const state = b64urlEncode(randomBytes(16));
    const nonce = b64urlEncode(randomBytes(16));
    const stateHash = await sha256Hex(state);
    const nonceHash = await sha256Hex(nonce);
    const challenge = b64urlEncode(await sha256Bytes(verifier));
    const verifierSealed = await sealText((await ensureTenantDek(tenant)).dek, verifier);
    const t = now();
    const expiresAt = t + STATE_TTL_MS;
    const scopesStr = (Array.isArray(scopes) && scopes.length ? scopes : reg.defaultScopes).join(",");
    await db.prepare(`INSERT INTO dillo_oauth_states
      (state_hash, tenant_id, owner_id, provider, name, scopes, nonce_hash, verifier_sealed, redirect_uri, created_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
      .bind(stateHash, tenant, owner, provider, name, scopesStr, nonceHash, verifierSealed, app.redirectUri, t, expiresAt).run();
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: "",
      operation: "oauth-start", purpose: `provider:${provider}`, decision: "allowed", fingerprint: null,
    });
    const url = new URL(reg.authorizeUrl);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", app.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopesStr.split(",").join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return { authorizeUrl: url.toString(), expiresAt };
  }

  // --- oauth.complete (callback) ------------------------------------------
  async function oauthComplete({ provider, code, state, error }) {
    const reg = getProvider(provider);
    if (!reg) return { ok: false, code: "bad-request", status: 400 };
    const stateHash = state ? await sha256Hex(state) : "";
    if (error) {
      if (stateHash) await db.prepare(`DELETE FROM dillo_oauth_states WHERE state_hash = ?1`).bind(stateHash).run();
      const reason = error === "access_denied" ? "user-denied" : "provider-error";
      try { await logAccess({ tenantId: "", actorId: "", secretId: "", operation: "oauth-callback", decision: "denied", reason }); } catch { /* denial stands */ }
      return { ok: false, code: reason, status: 400 };
    }
    if (!code || !state) return { ok: false, code: "state-unknown-or-expired", status: 400 };
    const row = await db.prepare(`SELECT * FROM dillo_oauth_states WHERE state_hash = ?1`).bind(stateHash).first();
    if (!row) {
      try { await logAccess({ tenantId: "", actorId: "", secretId: "", operation: "oauth-callback", decision: "denied", reason: "state-unknown-or-expired" }); } catch {}
      return { ok: false, code: "state-unknown-or-expired", status: 400 };
    }
    if (now() > row.expires_at) {
      await db.prepare(`DELETE FROM dillo_oauth_states WHERE state_hash = ?1`).bind(stateHash).run();
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "state-unknown-or-expired" }); } catch {}
      return { ok: false, code: "state-unknown-or-expired", status: 400 };
    }
    // Single-use: delete immediately after a successful read, before the
    // exchange.
    await db.prepare(`DELETE FROM dillo_oauth_states WHERE state_hash = ?1`).bind(stateHash).run();
    const app = await readAppRegistration(provider);
    if (!app) {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "app-not-registered" }); } catch {}
      return { ok: false, code: "provider-not-set-up", status: 501 };
    }
    if (row.redirect_uri !== app.redirectUri) {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "redirect-mismatch" }); } catch {}
      return { ok: false, code: "redirect-mismatch", status: 400 };
    }
    const { dek } = await getTenantDek(row.tenant_id);
    let verifier;
    try {
      verifier = await unsealText(dek, row.verifier_sealed);
    } catch {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "vault-unreachable" }); } catch {}
      return { ok: false, code: "vault-unreachable", status: 503 };
    }
    let tok;
    try {
      if (testDouble) {
        tok = testDouble.tokenResponse;
      } else {
        const res = await fetchImpl(reg.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code, client_id: app.clientId, client_secret: app.clientSecret,
            redirect_uri: app.redirectUri, grant_type: "authorization_code", code_verifier: verifier,
          }),
        });
        if (!res.ok) {
          try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "token-exchange-failed", purpose: `callback:token_status=${res.status}` }); } catch {}
          return { ok: false, code: "token-exchange-failed", status: 502 };
        }
        tok = await res.json();
      }
    } catch {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "token-exchange-failed" }); } catch {}
      return { ok: false, code: "token-exchange-failed", status: 502 };
    }
    if (!tok || !tok.access_token) {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "token-exchange-failed" }); } catch {}
      return { ok: false, code: "token-exchange-failed", status: 502 };
    }
    let account = null;
    try {
      if (testDouble) {
        account = testDouble.userinfoResponse.email;
      } else {
        const ures = await fetchImpl(reg.userinfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        if (!ures.ok) throw new Error("userinfo-failed");
        account = (await ures.json()).email || null;
      }
    } catch {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "userinfo-failed" }); } catch {}
      return { ok: false, code: "userinfo-failed", status: 502 };
    }
    if (!account) {
      try { await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, secretId: "", operation: "oauth-callback", decision: "denied", reason: "userinfo-failed" }); } catch {}
      return { ok: false, code: "userinfo-failed", status: 502 };
    }
    const t = now();
    const expiresAt = typeof tok.expires_in === "number" ? t + tok.expires_in * 1000 : null;
    const scopesGranted = typeof tok.scope === "string" && tok.scope ? tok.scope.split(" ") : (row.scopes || "").split(",").filter(Boolean);
    const tokenSet = { accessToken: tok.access_token, refreshToken: tok.refresh_token || null, expiresAt, account, scopes: scopesGranted, tokenType: "Bearer" };
    const sealed = await sealText(dek, JSON.stringify(tokenSet));
    const fp = await fingerprintOf(tok.refresh_token || account);
    const id = newId("sec");
    // D-2: the callback writes under the state row's owner; refuse a
    // cross-owner overwrite of a (tenant, name) claimed by another owner.
    const hijack = await db.prepare(`SELECT owner_id FROM dillo_secrets WHERE tenant_id = ?1 AND name = ?2`).bind(row.tenant_id, row.name).first();
    if (hijack && hijack.owner_id !== row.owner_id) {
      await logDenied(row.tenant_id, { owner: row.owner_id }, "", "oauth-connect", "wrong-owner");
      return { ok: false, code: "wrong-owner", status: 403 };
    }
    await db.batch([
      db.prepare(`DELETE FROM dillo_secrets WHERE tenant_id = ?1 AND name = ?2`).bind(row.tenant_id, row.name),
      db.prepare(`INSERT INTO dillo_secrets
        (id, tenant_id, owner_id, name, kind, provider, host, sealed, key_version, fingerprint, last4, scopes, state, expires_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'oauth', ?5, ?6, ?7, ?8, ?9, '', ?10, 'ok', ?11, ?12, ?13)`)
        .bind(id, row.tenant_id, row.owner_id, row.name, provider, reg.tokenHost, sealed, (await getTenantDek(row.tenant_id)).version, fp, scopesGranted.join(","), expiresAt, t, t),
    ]);
    await logAccess({
      tenantId: row.tenant_id, actorId: row.owner_id, secretId: id,
      operation: "oauth-connect", keyVersion: (await getTenantDek(row.tenant_id)).version, decision: "allowed", fingerprint: fp,
    });
    await mintConsoleGrants(row.tenant_id, row.owner_id, row.name);
    return { ok: true, account, name: row.name, scopes: scopesGranted };
  }

  // --- refresh (single-flight lease) --------------------------------------
  async function takeLease(secretId, holder) {
    const leaseId = newId("lease");
    const expiresAt = now() + LEASE_TTL_MS;
    try {
      await db.prepare(`INSERT INTO dillo_oauth_refresh_locks (secret_id, lease_id, holder, expires_at) VALUES (?1, ?2, ?3, ?4)`)
        .bind(secretId, leaseId, holder, expiresAt).run();
      return leaseId;
    } catch {
      const existing = await db.prepare(`SELECT * FROM dillo_oauth_refresh_locks WHERE secret_id = ?1`).bind(secretId).first();
      if (!existing) return takeLease(secretId, holder);
      if (existing.expires_at <= now()) {
        await db.prepare(`DELETE FROM dillo_oauth_refresh_locks WHERE secret_id = ?1 AND expires_at <= ?2`).bind(secretId, now()).run();
        try {
          await db.prepare(`INSERT INTO dillo_oauth_refresh_locks (secret_id, lease_id, holder, expires_at) VALUES (?1, ?2, ?3, ?4)`)
            .bind(secretId, leaseId, holder, expiresAt).run();
          return leaseId;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async function releaseLease(secretId, leaseId) {
    await db.prepare(`DELETE FROM dillo_oauth_refresh_locks WHERE secret_id = ?1 AND lease_id = ?2`).bind(secretId, leaseId).run();
  }

  async function refreshWithLease(row, { purpose, actor }) {
    const reg = getProvider(row.provider);
    const holder = purpose || "broker";
    const leaseId = await takeLease(row.id, holder);
    if (!leaseId) {
      await logAccess({
        tenantId: row.tenant_id, actorId: row.owner_id, sessionHash: actor?.sessionHash || null, secretId: row.id,
        operation: "oauth-refresh", purpose, keyVersion: row.key_version, decision: "denied", reason: "refresh-in-progress", fingerprint: row.fingerprint,
      });
      throw new VaultError("refresh-in-progress", 409, "refresh in progress — retry the fetch");
    }
    try {
      const { dek } = await getTenantDek(row.tenant_id, row.key_version);
      const oldSet = await parseUnsealedObject(dek, row.sealed);
      if (!oldSet.refreshToken) {
        await db.prepare(`UPDATE dillo_secrets SET state = 'needs-reconnect', updated_at = ?1 WHERE id = ?2`).bind(now(), row.id).run();
        throw new VaultError("refresh-expired", 409, "Your sign-in ran out. Sign in again.");
      }
      if (oldSet.refreshTokenExpiresAt && now() >= oldSet.refreshTokenExpiresAt - REFRESH_WINDOW_MS) {
        await db.prepare(`UPDATE dillo_secrets SET state = 'needs-reconnect', updated_at = ?1 WHERE id = ?2`).bind(now(), row.id).run();
        throw new VaultError("refresh-expired", 409, "Your sign-in ran out. Sign in again.");
      }
      const app = await readAppRegistration(row.provider);
      if (!app) throw new VaultError("provider-not-set-up", 501, "provider not set up");
      let tok;
      if (testDouble) {
        tok = testDouble.tokenResponse;
      } else {
        const res = await fetchImpl(reg.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token", refresh_token: oldSet.refreshToken,
            client_id: app.clientId, client_secret: app.clientSecret,
          }),
        });
        if (!res.ok) {
          const invalidGrant = res.status === 400;
          if (invalidGrant) {
            await db.prepare(`UPDATE dillo_secrets SET sealed = NULL, state = 'needs-reconnect', updated_at = ?1 WHERE id = ?2`).bind(now(), row.id).run();
            await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, sessionHash: actor?.sessionHash || null, secretId: row.id, operation: "oauth-refresh", purpose, keyVersion: row.key_version, decision: "denied", reason: "refresh-expired", fingerprint: row.fingerprint });
            throw new VaultError("refresh-expired", 409, "Your sign-in ran out. Sign in again.");
          }
          await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, sessionHash: actor?.sessionHash || null, secretId: row.id, operation: "oauth-refresh", purpose, keyVersion: row.key_version, decision: "denied", reason: "refresh-transient", fingerprint: row.fingerprint });
          throw new VaultError("refresh-transient", 502, "The provider did not complete the connection — try again.");
        }
        tok = await res.json();
      }
      if (!tok || !tok.access_token) throw new VaultError("refresh-transient", 502, "The provider did not complete the connection — try again.");
      const t = now();
      const newSet = {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || oldSet.refreshToken,
        expiresAt: typeof tok.expires_in === "number" ? t + tok.expires_in * 1000 : oldSet.expiresAt,
        account: oldSet.account, scopes: oldSet.scopes, tokenType: "Bearer",
      };
      if (typeof tok.refresh_token_expires_in === "number") newSet.refreshTokenExpiresAt = t + tok.refresh_token_expires_in * 1000;
      else if (oldSet.refreshTokenExpiresAt) newSet.refreshTokenExpiresAt = oldSet.refreshTokenExpiresAt;
      const newSealed = await sealText(dek, JSON.stringify(newSet));
      const res2 = await db.prepare(`UPDATE dillo_secrets SET sealed = ?1, expires_at = ?2, updated_at = ?3 WHERE id = ?4 AND sealed = ?5`)
        .bind(newSealed, newSet.expiresAt, t, row.id, row.sealed).run();
      const changes = res2?.meta?.changes ?? 1;
      if (changes === 0) {
        await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, sessionHash: actor?.sessionHash || null, secretId: row.id, operation: "oauth-refresh", purpose, keyVersion: row.key_version, decision: "denied", reason: "refresh-lost-race", fingerprint: row.fingerprint });
        throw new VaultError("refresh-lost-race", 409, "refresh lost a race — retry the fetch");
      }
      await logAccess({ tenantId: row.tenant_id, actorId: row.owner_id, sessionHash: actor?.sessionHash || null, secretId: row.id, operation: "oauth-refresh", purpose, keyVersion: row.key_version, decision: "allowed", fingerprint: row.fingerprint });
      return { accessToken: newSet.accessToken, expiresAt: newSet.expiresAt, account: newSet.account, tokenType: "Bearer", refreshed: true };
    } finally {
      await releaseLease(row.id, leaseId);
    }
  }

  // --- oauth.fetch (mint a transient token for one run) -------------------
  async function oauthFetch({ tenant, owner, name, purpose, actor }) {
    let caller;
    try {
      checkActor(actor, { tenant, owner });
      caller = await resolveCaller(actor, "oauth-fetch");
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "oauth-fetch", e.code, purpose);
      throw e;
    }
    const row = await findSecretOwned(tenant, owner, { name }, caller);
    if (!row || row.kind !== "oauth") {
      await logDenied(tenant, actor, "", "oauth-fetch", "not-granted", purpose);
      throw new VaultError("not-granted", 403, "Denied.");
    }
    if (row.state !== "ok") {
      await logDenied(tenant, actor, row.id, "oauth-fetch", row.state === "revoked" ? "revoked" : "needs-reconnect", purpose);
      throw new VaultError(row.state === "revoked" ? "revoked" : "needs-reconnect", 409, "Your sign-in ran out. Sign in again.");
    }
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: row.id,
      operation: "oauth-fetch", purpose: purpose || null, keyVersion: row.key_version, decision: "allowed", reason: "intent-admitted", fingerprint: row.fingerprint,
    });
    const { dek } = await getTenantDek(tenant, row.key_version);
    const set = await parseUnsealedObject(dek, row.sealed);
    // expiresAt NULL → return the stored token, NO refresh, ZERO provider calls.
    if (set.expiresAt === null || set.expiresAt === undefined) {
      return { accessToken: set.accessToken, expiresAt: set.expiresAt ?? null, account: set.account, tokenType: "Bearer" };
    }
    if (now() < set.expiresAt - REFRESH_WINDOW_MS) {
      return { accessToken: set.accessToken, expiresAt: set.expiresAt, account: set.account, tokenType: "Bearer" };
    }
    const fresh = await refreshWithLease(row, { purpose, actor });
    return fresh;
  }

  // --- oauth.status (read-only; NEVER triggers a refresh) ------------------
  async function oauthStatus({ tenant, owner, name, actor }) {
    return secretState({ tenant, owner, name, actor });
  }

  // Connect-time minting (D-1a): the connect dance (save / oauth.complete)
  // IS the owner's act, so the owner's own console read/fetch grants are
  // minted here. The console caller is authenticated by the provisioned
  // VAULT_CONSOLE_SECRET; only its SHA-256 lands in the grants table.
  async function mintConsoleGrants(tenant, owner, name) {
    const cs = consoleSecret();
    if (!cs) return; // no console secret provisioned ⇒ console reads fail closed
    const secretHash = await sha256Hex(cs);
    const t = now();
    for (const operation of ["read", "oauth-fetch"]) {
      const exists = await db.prepare(
        `SELECT 1 AS x FROM dillo_vault_grants WHERE caller_id = ?1 AND caller_secret_hash = ?2 AND tenant_id = ?3 AND owner_id = ?4 AND secret_name = ?5 AND operation = ?6`,
      ).bind(CONSOLE_CALLER, secretHash, tenant, owner, name, operation).first();
      if (!exists) {
        await db.prepare(
          `INSERT INTO dillo_vault_grants (id, caller_id, caller_secret_hash, tenant_id, owner_id, secret_name, operation, granted_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(newId("grant"), CONSOLE_CALLER, secretHash, tenant, owner, name, operation, owner, t).run();
      }
    }
  }

  // --- grant (the owner's console mints a caller capability, D-1) ----------
  // D-1b: minting requires proof of the owner — only the provisioned console
  // caller (authenticated by its caller secret) may mint. An anonymous bound
  // caller and Flows (or any other named caller) are refused. The mint is
  // logged with the verified actor (the owner).
  async function grant({ tenant, owner, caller, callerSecret, name, operation, actor }) {
    try {
      checkActor(actor, { tenant, owner });
    } catch (e) {
      if (e instanceof VaultError) await logDenied(tenant, actor, "", "grant", e.code);
      throw e;
    }
    if (!(await isConsoleCaller(actor))) {
      await logDenied(tenant, actor, "", "grant", "not-granted");
      throw new VaultError("not-granted", 403, "Denied.");
    }
    if (!caller || !callerSecret || !name || !operation) {
      throw new VaultError("bad-request", 400, "caller, callerSecret, name and operation are required");
    }
    if (operation !== "read" && operation !== "oauth-fetch") {
      throw new VaultError("bad-request", 400, "unknown operation");
    }
    const secretHash = await sha256Hex(callerSecret);
    const id = newId("grant");
    const t = now();
    await db.prepare(`INSERT INTO dillo_vault_grants
      (id, caller_id, caller_secret_hash, tenant_id, owner_id, secret_name, operation, granted_by, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(id, caller, secretHash, tenant, owner, name, operation, owner, t).run();
    await logAccess({
      tenantId: tenant, actorId: owner, sessionHash: actor?.sessionHash || null, secretId: "",
      operation: "grant", purpose: `caller:${caller} secret:${name} op:${operation}`, decision: "allowed", fingerprint: null,
    });
    return { grantId: id, caller, secretName: name, operation };
  }

  return {
    save, secretState, get, present, revoke, rotate, grant,
    oauth: { start: oauthStart, complete: oauthComplete, fetch: oauthFetch, status: oauthStatus },
    readAppRegistration,
  };
}

async function sha256Bytes(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}
