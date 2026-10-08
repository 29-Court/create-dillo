import { INTERNAL_TABLES } from "../backend.js";
import {} from "./environment.js";
import { HttpError, json } from "./http.js";
import { sha256 } from "./helpers/crypto.js";
import { base64Url, makeId, randomBytes } from "./helpers/id.js";
import { now } from "./records.js";
import { readJson } from "./validation.js";
import { enforceRateLimit, requireUserSession } from "./auth.js";
import { apiKeyScopes, issueApiKey, recordApiKeyAudit } from "./api-keys.js";
const TOKEN = /^enr_[A-Za-z0-9_-]{22}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[A-Za-z0-9_-]{1,64}$/;
const CLASSES = /* @__PURE__ */ new Set(["muse", "grok", "generic"]);
const NUMERIC_USAGE = ["tokens_in", "tokens_out", "tokens_total", "cost_usd_reported", "duration_ms"];
const ERROR_PHRASE = "there's an error";
function changed(result) {
  return result.meta?.changes ?? 0;
}
function originOf(request) {
  return new URL(request.url).origin;
}
function jsonNoStore(data, status = 200) {
  const response = json(data, status);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
function errorPhrase() {
  return new Response(`${ERROR_PHRASE}
`, {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
function errorJson() {
  return jsonNoStore({ error: ERROR_PHRASE }, 404);
}
function waiting(status) {
  return jsonNoStore({ error: "waiting for the owner", status }, 409);
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
function storedScopes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
function isSubset(candidate, allowed) {
  const have = new Set(allowed);
  return candidate.every((scope) => have.has(scope));
}
function shellQuote(value) {
  if (value.includes("'")) throw new HttpError(500, "INTERNAL_ERROR", "Enrollment script value is not shell-safe.");
  return `'${value}'`;
}
function storeFor(agentClass) {
  if (agentClass === "grok") {
    return {
      method: "file",
      path: "~/.armadillo/bridge.json",
      mode: "0600",
      skillPath: "~/.grok/skills/armadillo-bridge/SKILL.md"
    };
  }
  if (agentClass === "muse") {
    return {
      method: "file",
      path: "~/.armadillo/bridge.json",
      mode: "0600",
      skillPath: ".agents/skills/armadillo-bridge/SKILL.md"
    };
  }
  return { method: "human", path: "", mode: "", skillPath: "" };
}
function endpointsFor(origin) {
  return {
    enroll: `${origin}/v1/bridge/enroll`,
    intents: `${origin}/v1/bridge/intents`,
    inbox: `${origin}/v1/bridge/inbox`
  };
}
function skillDocument(agentClass) {
  const home = agentClass === "grok" ? "Save this file at ~/.grok/skills/armadillo-bridge/SKILL.md. If your platform can deliver a webhook, give the owner your callback URL. Otherwise poll GET /v1/bridge/inbox about every 15 minutes." : "Save this file at .agents/skills/armadillo-bridge/SKILL.md from the project root. Muse loads it only when that workspace is trusted. muse exec is one shot, so schedule a poll of GET /v1/bridge/inbox about every 15 minutes with cron or launchd.";
  return `---
name: armadillo-bridge
description: Call Armadillo with the credential stored outside the chat.
---

# Armadillo bridge

Read the credential from ~/.armadillo/bridge.json. Never print it.
POST /v1/bridge/intents with the bearer token and a job_id you generated. 200 means accepted. It does not mean the work finished.
${home}
Ack with the same job_id and a usage block. Confidence is reported, estimated, or unavailable. If you do not have a number, use unavailable and omit the numbers. Never invent a number.
If a call fails, or a stored credential comes back 401 or 403, say there's an error and stop.
`;
}
function installScript(agentClass, origin, token) {
  const enroll = `${origin}/v1/bridge/enroll`;
  const skillWrite = agentClass === "generic" ? "" : `
let skillPath = ${JSON.stringify(storeFor(agentClass).skillPath)};
if (skillPath.startsWith("~/")) skillPath = join(homedir(), skillPath.slice(2));
await mkdir(dirname(skillPath), { recursive: true });
await writeFile(skillPath, ${JSON.stringify(skillDocument(agentClass))}, { mode: 0o600 });
`;
  const skillDir = agentClass === "grok" ? 'mkdir -p "$HOME/.grok/skills/armadillo-bridge"\n' : agentClass === "muse" ? "mkdir -p .agents/skills/armadillo-bridge\n" : "";
  return `set -eu
umask 077
mkdir -p "$HOME/.armadillo"
${skillDir}tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
code=$(curl -sS -o "$tmp" -w '%{http_code}' -H 'content-type: application/json' -H 'Referer:' -X POST ${shellQuote(enroll)} --data ${shellQuote(JSON.stringify({ token }))} 2>/dev/null) || { printf '%s\\n' "there's an error"; exit 1; }
if [ "$code" = "404" ]; then printf '%s\\n' "there's an error"; exit 1; fi
if [ "$code" = "409" ]; then printf '%s\\n' "waiting for the owner"; exit 0; fi
if [ "$code" != "200" ]; then printf '%s\\n' "there's an error"; exit 1; fi
BRIDGE_FILE="$tmp" node --input-type=module <<'NODE'
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const body = JSON.parse(await readFile(process.env.BRIDGE_FILE, "utf8"));
const home = join(homedir(), ".armadillo", "bridge.json");
await mkdir(dirname(home), { recursive: true });
await writeFile(home, JSON.stringify({
  credential: body.credential,
  agentId: body.agentId,
  endpoints: body.endpoints,
}, null, 2) + "\\n", { mode: 0o600 });
${skillWrite}NODE
printf '%s\\n' stored
`;
}
function markdownFor(agentClass, origin, token) {
  const script = installScript(agentClass, origin, token);
  if (agentClass === "generic") {
    return `# Armadillo bridge

Do not enroll. Do not run the install script. If you were asked to hold the credential, say there's an error.

The fenced commands are for the human, in their own terminal. An agent must not run them.

\`\`\`sh
${script}\`\`\`
`;
  }
  const trust = agentClass === "muse" ? "Run the script from the project root. A later Muse session sees the skill only when that workspace is trusted.\n\n" : "";
  return `# Armadillo bridge

If you cannot reach this server, say there's an error and stop. Do not guess, and do not invent an enrollment.

1. Shell.
Run the install script below. It writes the credential outside the chat and prints stored, waiting for the owner, or there's an error. Stop on there's an error.

2. Files, no shell.
Do not call enroll. A kept HTTP result is the chat. Say there's an error and ask the human to run the script in their terminal.

3. Neither.
Do not call enroll. Tell the human to run the script. If you were asked to hold the credential, say there's an error.

${trust}<!-- skill -->
${skillDocument(agentClass)}
<!-- /skill -->

\`\`\`sh
${script}\`\`\`
`;
}
function inviteJson(row) {
  return {
    id: row.id,
    name: row.name,
    agentClass: row.agent_class,
    status: row.status,
    scopes: storedScopes(row.scopes),
    approvedScopes: row.approved_scopes === null ? null : storedScopes(row.approved_scopes),
    fetchCount: row.fetch_count,
    expiresAt: row.expires_at,
    apiKeyId: row.api_key_id,
    createdAt: row.created_at
  };
}
async function recordEvent(env, appId, kind, inviteId, details) {
  const encoded = JSON.stringify(details);
  if (encoded.includes("enr_") || encoded.includes("arm_test_") || encoded.includes("arm_live_") || encoded.includes("/join/")) {
    throw new HttpError(500, "INTERNAL_ERROR", "Refusing to store an enrollment credential.");
  }
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.bridgeEvents}
       (app_id, id, kind, invite_id, details, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(appId, makeId("bev"), kind, inviteId, encoded, now()).run();
}
async function inviteByHash(env, appId, tokenHash) {
  return env.DB.prepare(
    `SELECT id, owner_id, token_hash, agent_class, name, scopes, status, fetch_count, expires_at,
            api_key_id, approved_scopes, created_at, updated_at
       FROM ${INTERNAL_TABLES.bridgeInvites}
      WHERE app_id = ?1 AND token_hash = ?2
      LIMIT 1`
  ).bind(appId, tokenHash).first();
}
async function inviteById(env, appId, id, ownerId) {
  return env.DB.prepare(
    `SELECT id, owner_id, token_hash, agent_class, name, scopes, status, fetch_count, expires_at,
            api_key_id, approved_scopes, created_at, updated_at
       FROM ${INTERNAL_TABLES.bridgeInvites}
      WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3
      LIMIT 1`
  ).bind(appId, id, ownerId).first();
}
async function inviteFresh(env, appId, id) {
  return env.DB.prepare(
    `SELECT id, owner_id, token_hash, agent_class, name, scopes, status, fetch_count, expires_at,
            api_key_id, approved_scopes, created_at, updated_at
       FROM ${INTERNAL_TABLES.bridgeInvites}
      WHERE app_id = ?1 AND id = ?2
      LIMIT 1`
  ).bind(appId, id).first();
}
function joinRejection(row, requestedClass, timestamp) {
  if (requestedClass && requestedClass !== row.agent_class) return "class";
  if (row.status !== "issued" && row.status !== "pending") return "closed";
  if (row.expires_at <= timestamp) return "expired";
  if (row.fetch_count >= 3) return "exhausted";
  return null;
}
async function rejectJoin(env, appId, inviteId, reason) {
  await recordEvent(env, appId, "join_rejected", inviteId, { reason });
  return errorPhrase();
}
function serveJoin(request, row, token) {
  const origin = originOf(request);
  const markdown = markdownFor(row.agent_class, origin, token);
  if (request.headers.get("accept")?.includes("application/json")) {
    const store = storeFor(row.agent_class);
    return jsonNoStore({
      enrollmentId: row.id,
      agentClass: row.agent_class,
      status: row.status,
      expiresAt: row.expires_at,
      claimToken: token,
      errorPhrase: ERROR_PHRASE,
      endpoints: endpointsFor(origin),
      store,
      markdown
    });
  }
  return new Response(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
async function bridgeJoinRoute(request, env, appId, token) {
  await enforceRateLimit(request, env, appId, "bridge-join", 60, 60);
  if (token.length > 200 || !TOKEN.test(token)) return errorPhrase();
  const timestamp = now();
  const row = await inviteByHash(env, appId, await sha256(token));
  if (!row) return errorPhrase();
  const requestedClass = new URL(request.url).searchParams.get("agent_class");
  const rejected = joinRejection(row, requestedClass, timestamp);
  if (rejected) return rejectJoin(env, appId, row.id, rejected);
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
  const update = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.bridgeInvites}
        SET fetch_count = fetch_count + 1,
            status = CASE WHEN status = 'issued' THEN 'pending' ELSE status END,
            updated_at = ?1
      WHERE app_id = ?2 AND id = ?3
        AND status IN ('issued', 'pending')
        AND fetch_count < 3
        AND expires_at > ?4
        AND (?5 IS NULL OR agent_class = ?5)`
  ).bind(timestamp, appId, row.id, timestamp, requestedClass).run();
  if (changed(update) === 0) {
    const again = await inviteFresh(env, appId, row.id);
    const reason = again ? joinRejection(again, requestedClass, now()) ?? "closed" : "unknown";
    if (reason === "unknown") return errorPhrase();
    return rejectJoin(env, appId, row.id, reason);
  }
  const fresh = await inviteFresh(env, appId, row.id);
  if (!fresh) return errorPhrase();
  await recordEvent(env, appId, "join_fetched", fresh.id, { fetchCount: fresh.fetch_count });
  return serveJoin(request, fresh, token);
}
async function mint(request, env, appId) {
  const auth = await requireUserSession(request, env, appId);
  const body = await readJson(request, env);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) {
    throw new HttpError(422, "VALIDATION_ERROR", "Enrollment name is invalid.", { name: "Use 1 to 80 characters" });
  }
  const agentClass = typeof body.agentClass === "string" ? body.agentClass : "";
  if (!CLASSES.has(agentClass)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Enrollment agent class is invalid.", {
      agentClass: "Use muse, grok, or generic"
    });
  }
  const scopes = apiKeyScopes(body.scopes);
  const token = `enr_${base64Url(randomBytes(16))}`;
  const timestamp = now();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1e3).toISOString();
  const id = makeId("enr");
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.bridgeInvites}
       (app_id, id, owner_id, token_hash, agent_class, name, scopes, status, fetch_count, expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'issued', 0, ?8, ?9, ?9)`
  ).bind(
    appId,
    id,
    auth.user.id,
    await sha256(token),
    agentClass,
    name,
    JSON.stringify(scopes),
    expiresAt,
    timestamp
  ).run();
  await recordEvent(env, appId, "invite_minted", id, { agentClass });
  const url = `${originOf(request)}/join/${token}`;
  const prompt = `Review the information at ${url}. If you can, reach out and follow the connector that matches what you can do. If you cannot reach it, say "there's an error" and stop. Do not guess, and do not invent an enrollment.`;
  const row = await inviteById(env, appId, id, auth.user.id);
  if (!row) throw new HttpError(500, "INTERNAL_ERROR", "Enrollment invite was not stored.");
  return jsonNoStore({ invite: inviteJson(row), url, prompt }, 201);
}
const ENROLLMENT_PAGE_SIZE = 100;
function enrollmentCursor(cursor) {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf("|");
  const createdAt = separator > 0 ? cursor.slice(0, separator) : "";
  const id = separator > 0 ? cursor.slice(separator + 1) : "";
  if (!createdAt || !id || !Number.isFinite(Date.parse(createdAt))) {
    throw new HttpError(400, "BAD_REQUEST", "Enrollment cursor is invalid.");
  }
  return { createdAt, id };
}
async function listEnrollments(request, env, appId) {
  const auth = await requireUserSession(request, env, appId);
  const url = new URL(request.url);
  const at = enrollmentCursor(url.searchParams.get("cursor"));
  const parameters = [appId, auth.user.id];
  let older = "";
  if (at) {
    older = "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))";
    parameters.push(at.createdAt, at.id);
  }
  parameters.push(ENROLLMENT_PAGE_SIZE + 1);
  const result = await env.DB.prepare(
    `SELECT id, owner_id, token_hash, agent_class, name, scopes, status, fetch_count, expires_at,
            api_key_id, approved_scopes, created_at, updated_at
       FROM ${INTERNAL_TABLES.bridgeInvites}
      WHERE app_id = ?1 AND owner_id = ?2
        ${older}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(...parameters).all();
  const rows = result.results ?? [];
  const page = rows.slice(0, ENROLLMENT_PAGE_SIZE);
  const last = page.at(-1);
  return json({
    enrollments: page.map(inviteJson),
    nextCursor: rows.length > ENROLLMENT_PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null
  });
}
async function approve(request, env, appId, id) {
  const auth = await requireUserSession(request, env, appId);
  const current = await inviteById(env, appId, id, auth.user.id);
  if (!current) throw new HttpError(404, "NOT_FOUND", "Enrollment not found.");
  const body = await readJson(request, env);
  const scopes = body.scopes === void 0 ? storedScopes(current.scopes) : apiKeyScopes(body.scopes);
  if (!isSubset(scopes, storedScopes(current.scopes))) {
    throw new HttpError(422, "VALIDATION_ERROR", "Approved scopes cannot widen the invite.", {
      scopes: "Choose a subset of the invite scopes"
    });
  }
  const timestamp = now();
  const update = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.bridgeInvites}
        SET status = 'approved', approved_scopes = ?1, updated_at = ?2
      WHERE app_id = ?3 AND id = ?4 AND owner_id = ?5 AND status = 'pending'`
  ).bind(JSON.stringify(scopes), timestamp, appId, id, auth.user.id).run();
  if (changed(update) === 0) throw new HttpError(409, "CONFLICT", "This enrollment cannot be approved.");
  await recordEvent(env, appId, "approved", id, {});
  const row = await inviteById(env, appId, id, auth.user.id);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Enrollment not found.");
  return json({ enrollment: inviteJson(row) });
}
async function deny(request, env, appId, id) {
  const auth = await requireUserSession(request, env, appId);
  const timestamp = now();
  const update = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.bridgeInvites}
        SET status = 'denied', updated_at = ?1
      WHERE app_id = ?2 AND id = ?3 AND owner_id = ?4 AND status = 'pending'`
  ).bind(timestamp, appId, id, auth.user.id).run();
  if (changed(update) === 0) throw new HttpError(409, "CONFLICT", "This enrollment cannot be denied.");
  await recordEvent(env, appId, "denied", id, {});
  return json({ status: "denied" });
}
async function revoke(request, env, appId, id) {
  const auth = await requireUserSession(request, env, appId);
  const current = await inviteById(env, appId, id, auth.user.id);
  if (!current) throw new HttpError(404, "NOT_FOUND", "Enrollment not found.");
  const timestamp = now();
  const revocable = current.status === "paused" || current.status === "active" || current.status === "approved" && current.api_key_id === null;
  if (!revocable) throw new HttpError(409, "CONFLICT", "This enrollment cannot be revoked.");
  const statements = [
    env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.bridgeInvites}
          SET status = 'revoked', updated_at = ?1
        WHERE app_id = ?2 AND id = ?3 AND owner_id = ?4
          AND (status IN ('paused', 'active') OR (status = 'approved' AND api_key_id IS NULL))`
    ).bind(timestamp, appId, id, auth.user.id)
  ];
  if (current.api_key_id) {
    statements.push(env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.apiKeys}
          SET revoked_at = ?1
        WHERE app_id = ?2 AND id = ?3 AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM ${INTERNAL_TABLES.bridgeInvites}
             WHERE app_id = ?2 AND id = ?4 AND status = 'revoked' AND updated_at = ?1
          )`
    ).bind(timestamp, appId, current.api_key_id, id));
    statements.push(env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.apiKeyAudit}
         (app_id, id, key_id, actor_id, event_type, details, created_at)
       SELECT ?1, ?2, ?3, ?4, 'revoked', ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM ${INTERNAL_TABLES.bridgeInvites}
           WHERE app_id = ?1 AND id = ?7 AND status = 'revoked' AND updated_at = ?6
        )`
    ).bind(appId, makeId("key_audit"), current.api_key_id, auth.user.id, JSON.stringify({}), timestamp, id));
  }
  await env.DB.batch(statements);
  const fresh = await inviteById(env, appId, id, auth.user.id);
  if (fresh?.status !== "revoked") throw new HttpError(409, "CONFLICT", "This enrollment cannot be revoked.");
  await recordEvent(env, appId, "revoked", id, {});
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
async function ownerPage(request, env, appId) {
  const auth = await requireUserSession(request, env, appId);
  const rows = await env.DB.prepare(
    `SELECT id, owner_id, token_hash, agent_class, name, scopes, status, fetch_count, expires_at,
            api_key_id, approved_scopes, created_at, updated_at
       FROM ${INTERNAL_TABLES.bridgeInvites}
      WHERE app_id = ?1 AND owner_id = ?2
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(appId, auth.user.id, ENROLLMENT_PAGE_SIZE + 1).all();
  const all = rows.results ?? [];
  const shown = all.slice(0, ENROLLMENT_PAGE_SIZE);
  const items = shown.map(
    (row) => `<li><code>${escapeHtml(row.id)}</code> ${escapeHtml(row.name)} ${escapeHtml(row.agent_class)} ${escapeHtml(row.status)}</li>`
  ).join("");
  const cutoff = all.length > ENROLLMENT_PAGE_SIZE ? `<p>This list is incomplete: it shows the newest ${ENROLLMENT_PAGE_SIZE} enrollments and more exist. Page through every enrollment with GET /v1/bridge/enrollments and its <code>cursor</code>.</p>` : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Armadillo bridge</title></head>
<body>
<h1>Bridge enrollments</h1>
<p>A cookie-authenticated owner can POST JSON to /v1/bridge/invites.</p>
${cutoff}<ul>${items}</ul>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
async function abandonKey(env, appId, keyId, ownerId) {
  const timestamp = now();
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.apiKeys}
        SET revoked_at = ?1
      WHERE app_id = ?2 AND id = ?3 AND revoked_at IS NULL`
  ).bind(timestamp, appId, keyId).run();
  await recordApiKeyAudit(env, appId, keyId, ownerId, "revoked", { reason: "exchange_lost" });
}
async function exchange(request, env, appId) {
  await enforceRateLimit(request, env, appId, "bridge-enroll", 60, 60);
  const body = await readJson(request, env);
  const token = typeof body.token === "string" ? body.token : "";
  if (token.length > 200 || !TOKEN.test(token)) return errorJson();
  const row = await inviteByHash(env, appId, await sha256(token));
  if (!row) return errorJson();
  const timestamp = now();
  if (row.expires_at <= timestamp) {
    await recordEvent(env, appId, "enroll_rejected", row.id, { reason: "expired" });
    return errorJson();
  }
  if (row.status === "denied" || row.status === "revoked") {
    await recordEvent(env, appId, "enroll_rejected", row.id, { reason: "closed" });
    return errorJson();
  }
  if (row.status === "issued" || row.status === "pending" || row.status === "paused" || row.status === "active") {
    return waiting(row.status === "issued" ? "pending" : row.status);
  }
  if (row.status !== "approved" || row.api_key_id) return errorJson();
  const scopes = apiKeyScopes(storedScopes(row.approved_scopes));
  const issued = await issueApiKey(env, appId, row.owner_id, {
    name: `bridge:${row.name}`,
    description: null,
    scopes,
    expiresAt: null
  });
  const boundAt = now();
  const update = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.bridgeInvites}
        SET status = 'paused', api_key_id = ?1, updated_at = ?2
      WHERE app_id = ?3 AND id = ?4
        AND status = 'approved' AND api_key_id IS NULL AND expires_at > ?2`
  ).bind(issued.apiKey.id, boundAt, appId, row.id).run();
  if (changed(update) === 0) {
    await abandonKey(env, appId, issued.apiKey.id, row.owner_id);
    const again = await inviteFresh(env, appId, row.id);
    if (!again || again.expires_at <= now() || again.status === "denied" || again.status === "revoked") {
      await recordEvent(env, appId, "enroll_rejected", row.id, { reason: again && again.expires_at <= now() ? "expired" : "closed" });
      return errorJson();
    }
    return waiting(again.status);
  }
  await recordEvent(env, appId, "exchanged", row.id, { agentId: issued.apiKey.id });
  return jsonNoStore({
    credential: issued.secret,
    agentId: issued.apiKey.id,
    scopes,
    store: storeFor(row.agent_class),
    endpoints: endpointsFor(originOf(request))
  });
}
async function bridgeAgent(request, env, appId) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const credential = match?.[1] ?? "";
  if (!credential || credential.length > 1024 || credential.startsWith("enr_")) {
    throw new HttpError(401, "UNAUTHENTICATED", "Credential is missing.");
  }
  const key = await env.DB.prepare(
    `SELECT id, owner_id, revoked_at, expires_at, grace_expires_at
       FROM ${INTERNAL_TABLES.apiKeys}
      WHERE app_id = ?1 AND key_hash = ?2
      LIMIT 1`
  ).bind(appId, await sha256(credential)).first();
  if (!key) throw new HttpError(401, "UNAUTHENTICATED", "Credential is missing.");
  const timestamp = now();
  const dead = Boolean(key.revoked_at) || key.expires_at !== null && key.expires_at <= timestamp || key.grace_expires_at !== null && key.grace_expires_at <= timestamp;
  if (dead) throw new HttpError(403, "FORBIDDEN", "This agent credential is revoked.");
  const invite = await env.DB.prepare(
    `SELECT id, status FROM ${INTERNAL_TABLES.bridgeInvites}
      WHERE app_id = ?1 AND api_key_id = ?2
      LIMIT 1`
  ).bind(appId, key.id).first();
  if (!invite || invite.status === "revoked") {
    throw new HttpError(403, "FORBIDDEN", invite ? "This agent credential is revoked." : "This credential is not a bridge agent.");
  }
  if (invite.status !== "paused" && invite.status !== "active") {
    throw new HttpError(403, "FORBIDDEN", "This agent credential is revoked.");
  }
  return { keyId: key.id, ownerId: key.owner_id, inviteId: invite.id, inviteStatus: invite.status };
}
function jsonField(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(422, "VALIDATION_ERROR", "Job payload is invalid.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonField(item));
  if (typeof value === "object") {
    const object = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === void 0) continue;
      object[key] = jsonField(item);
    }
    return object;
  }
  throw new HttpError(422, "VALIDATION_ERROR", "Job payload is invalid.");
}
function jobPayload(body) {
  const payload = {};
  for (const key of ["argv", "to_hint", "context_shape", "data_boundary", "budget"]) {
    if (body[key] !== void 0) payload[key] = jsonField(body[key]);
  }
  return payload;
}
function parseUsage(body) {
  const confidence = body.confidence;
  if (confidence !== "reported" && confidence !== "estimated" && confidence !== "unavailable") {
    throw new HttpError(422, "VALIDATION_ERROR", "Usage confidence is invalid.", {
      confidence: "Use reported, estimated, or unavailable"
    });
  }
  const usage = { confidence };
  let numbers = 0;
  for (const key of NUMERIC_USAGE) {
    if (body[key] === void 0) continue;
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new HttpError(422, "VALIDATION_ERROR", "Usage number is invalid.", { [key]: "Use a finite number" });
    }
    if (key === "cost_usd_reported") {
      if (value < 0) throw new HttpError(422, "VALIDATION_ERROR", "Usage number is invalid.", { [key]: "Use a number of at least 0" });
    } else if (!Number.isInteger(value) || value < 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "Usage number is invalid.", { [key]: "Use an integer of at least 0" });
    }
    usage[key] = value;
    numbers += 1;
  }
  if (confidence === "unavailable" && numbers > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Unavailable usage cannot include numbers.");
  }
  if (confidence !== "unavailable" && numbers === 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Reported usage needs a number you actually have.");
  }
  for (const key of ["model", "provider"]) {
    if (body[key] === void 0) continue;
    const value = body[key];
    if (typeof value !== "string" || value.length < 1 || value.length > 120) {
      throw new HttpError(422, "VALIDATION_ERROR", "Usage label is invalid.", { [key]: "Use 1 to 120 characters" });
    }
    usage[key] = value;
  }
  return usage;
}
async function markActive(env, appId, keyId) {
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.bridgeInvites}
        SET status = 'active', updated_at = ?1
      WHERE app_id = ?2 AND api_key_id = ?3 AND status = 'paused'`
  ).bind(now(), appId, keyId).run();
}
async function intents(request, env, appId) {
  const agent = await bridgeAgent(request, env, appId);
  const body = await readJson(request, env);
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!JOB_ID.test(jobId)) throw new HttpError(422, "VALIDATION_ERROR", "Job id is invalid.", { job_id: "Use a UUID" });
  if (!ACTION.test(action)) throw new HttpError(422, "VALIDATION_ERROR", "Job action is invalid.", { action: "Use 1 to 64 letters, numbers, _ or -" });
  const existing = await env.DB.prepare(
    `SELECT agent_id, action, status FROM ${INTERNAL_TABLES.bridgeJobs}
      WHERE app_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(appId, jobId).first();
  if (existing) {
    if (existing.agent_id !== agent.keyId || existing.action !== action) {
      throw new HttpError(409, "CONFLICT", "That job id is already in use.");
    }
    await markActive(env, appId, agent.keyId);
    return jsonNoStore({ job_id: jobId, status: existing.status });
  }
  const timestamp = now();
  try {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.bridgeJobs}
         (app_id, id, agent_id, status, action, payload, usage, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'accepted', ?4, ?5, NULL, ?6, ?6)`
    ).bind(appId, jobId, agent.keyId, action, JSON.stringify(jobPayload(body)), timestamp).run();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
    const raced = await env.DB.prepare(
      `SELECT agent_id, action, status FROM ${INTERNAL_TABLES.bridgeJobs}
        WHERE app_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(appId, jobId).first();
    if (!raced || raced.agent_id !== agent.keyId || raced.action !== action) {
      throw new HttpError(409, "CONFLICT", "That job id is already in use.");
    }
    await markActive(env, appId, agent.keyId);
    return jsonNoStore({ job_id: jobId, status: raced.status });
  }
  await markActive(env, appId, agent.keyId);
  await recordEvent(env, appId, "intent_accepted", agent.inviteId, { jobId, action });
  return jsonNoStore({ job_id: jobId, status: "accepted" });
}
async function inbox(request, env, appId) {
  const agent = await bridgeAgent(request, env, appId);
  const rows = await env.DB.prepare(
    `SELECT id, status, action, payload, created_at
       FROM ${INTERNAL_TABLES.bridgeJobs}
      WHERE app_id = ?1 AND agent_id = ?2 AND status NOT IN ('completed', 'failed')
      ORDER BY created_at ASC
      LIMIT 50`
  ).bind(appId, agent.keyId).all();
  return json({
    jobs: (rows.results ?? []).map((row) => ({
      job_id: row.id,
      status: row.status,
      action: row.action,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at
    }))
  });
}
async function ack(request, env, appId, jobId) {
  const agent = await bridgeAgent(request, env, appId);
  const usage = parseUsage(await readJson(request, env));
  const job = await env.DB.prepare(
    `SELECT agent_id, status, usage FROM ${INTERNAL_TABLES.bridgeJobs}
      WHERE app_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(appId, jobId).first();
  if (!job || job.agent_id !== agent.keyId) throw new HttpError(404, "NOT_FOUND", "Job not found.");
  if (job.status === "completed") {
    return jsonNoStore({
      job_id: jobId,
      status: "completed",
      usage: job.usage ? JSON.parse(job.usage) : {}
    });
  }
  const timestamp = now();
  const update = await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.bridgeJobs}
        SET status = 'completed', usage = ?1, updated_at = ?2
      WHERE app_id = ?3 AND id = ?4 AND agent_id = ?5 AND status = 'accepted'`
  ).bind(JSON.stringify(usage), timestamp, appId, jobId, agent.keyId).run();
  if (changed(update) === 0) {
    const again = await env.DB.prepare(
      `SELECT status, usage FROM ${INTERNAL_TABLES.bridgeJobs}
        WHERE app_id = ?1 AND id = ?2 AND agent_id = ?3 LIMIT 1`
    ).bind(appId, jobId, agent.keyId).first();
    if (again?.status === "completed") {
      return jsonNoStore({
        job_id: jobId,
        status: "completed",
        usage: again.usage ? JSON.parse(again.usage) : {}
      });
    }
    throw new HttpError(409, "CONFLICT", "This job cannot be acknowledged.");
  }
  await recordEvent(env, appId, "ack", agent.inviteId, { jobId, confidence: String(usage.confidence) });
  return jsonNoStore({ job_id: jobId, status: "completed", usage });
}
async function events(request, env, appId) {
  const auth = await requireUserSession(request, env, appId);
  const rows = await env.DB.prepare(
    `SELECT e.id, e.kind, e.invite_id, e.details, e.created_at
       FROM ${INTERNAL_TABLES.bridgeEvents} AS e
       LEFT JOIN ${INTERNAL_TABLES.bridgeInvites} AS i
         ON i.app_id = e.app_id AND i.id = e.invite_id
      WHERE e.app_id = ?1 AND i.owner_id = ?2
      ORDER BY e.created_at DESC
      LIMIT 50`
  ).bind(appId, auth.user.id).all();
  return json({
    events: (rows.results ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      inviteId: row.invite_id,
      details: JSON.parse(row.details),
      createdAt: row.created_at
    }))
  });
}
async function bridgeRoute(request, env, appId, segments) {
  const resource = segments[2];
  const id = segments[3];
  const action = segments[4];
  if (!resource && request.method === "GET") return ownerPage(request, env, appId);
  if (resource === "invites" && !id && request.method === "POST") return mint(request, env, appId);
  if (resource === "enrollments" && !id && request.method === "GET") return listEnrollments(request, env, appId);
  if (resource === "enrollments" && id && action === "approve" && segments.length === 5 && request.method === "POST") {
    return approve(request, env, appId, id);
  }
  if (resource === "enrollments" && id && action === "deny" && segments.length === 5 && request.method === "POST") {
    return deny(request, env, appId, id);
  }
  if (resource === "enrollments" && id && action === "revoke" && segments.length === 5 && request.method === "POST") {
    return revoke(request, env, appId, id);
  }
  if (resource === "events" && !id && request.method === "GET") return events(request, env, appId);
  if (resource === "enroll" && !id && request.method === "POST") return exchange(request, env, appId);
  if (resource === "intents" && !id && request.method === "POST") return intents(request, env, appId);
  if (resource === "inbox" && !id && request.method === "GET") return inbox(request, env, appId);
  if (resource === "inbox" && id && action === "ack" && segments.length === 5 && request.method === "POST") {
    return ack(request, env, appId, id);
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  bridgeJoinRoute,
  bridgeRoute
};
