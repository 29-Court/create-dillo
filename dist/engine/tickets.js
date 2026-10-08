import {} from "../backend.js";
import {} from "../backend.js";
import { isObject } from "./helpers/json.js";
import { now } from "./records.js";
import {} from "../backend.js";
import {} from "./environment.js";
import { HttpError } from "./http.js";
import { requireAuth } from "./auth.js";
import { requireTeamPolicy } from "./teams.js";
import { INTERNAL_TABLES } from "../backend.js";
import { json } from "./http.js";
import { readJson } from "./validation.js";
import { NAME } from "./http.js";
import { encoder } from "./http.js";
import { maxJsonBytes } from "./http.js";
import { base64Url } from "./helpers/id.js";
import { randomBytes } from "./helpers/id.js";
import { makeId } from "./helpers/id.js";
import { sha256 } from "./helpers/crypto.js";
import { enforceRateLimit } from "./auth.js";
const TICKET_COLUMNS = `id, owner_id, team_id, holder_id, label, event_id, code_prefix,
  metadata, expires_at, consumed_at, consumed_by, created_at, updated_at`;
function ticketJson(row) {
  let metadata = {};
  try {
    const parsed = JSON.parse(row.metadata);
    if (isObject(parsed)) metadata = parsed;
  } catch {
  }
  const status = row.consumed_at ? "consumed" : row.expires_at && row.expires_at <= now() ? "expired" : "active";
  return {
    id: row.id,
    label: row.label,
    teamId: row.team_id,
    holderId: row.holder_id,
    eventId: row.event_id,
    codePrefix: row.code_prefix,
    metadata,
    status,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function ticketRoles(policy, action) {
  if (action === "read") return policy.readRoles;
  if (action === "issue") return policy.issueRoles ?? ["owner", "admin"];
  return policy.consumeRoles ?? ["owner", "admin", "checkin", "scanner"];
}
async function ticketsRoute(request, env, currentAppId, policy, id) {
  if (!policy) throw new HttpError(404, "NOT_FOUND", "Tickets are not configured for this backend.");
  const operation = id === "consume" ? "consume" : id === "lookup" || request.method === "GET" ? "read" : "issue";
  const auth = await requireAuth(request, env, currentAppId, `tickets:${operation}`);
  const membership = await requireTeamPolicy(
    env,
    currentAppId,
    policy.team,
    auth.user.id,
    ticketRoles(policy, operation)
  );
  if (!id && request.method === "GET") {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    let cursorCreatedAt = null;
    let cursorId = null;
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      cursorCreatedAt = separator > 0 ? cursor.slice(0, separator) : null;
      cursorId = separator > 0 ? cursor.slice(separator + 1) : null;
      if (!cursorCreatedAt || !cursorId || !Number.isFinite(Date.parse(cursorCreatedAt))) {
        throw new HttpError(400, "BAD_REQUEST", "Ticket cursor is invalid.");
      }
    }
    const parameters = [currentAppId, membership.id];
    let older = "";
    if (cursorCreatedAt && cursorId) {
      older = "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))";
      parameters.push(cursorCreatedAt, cursorId);
    }
    parameters.push(101);
    const result = await env.DB.prepare(
      `SELECT ${TICKET_COLUMNS} FROM ${INTERNAL_TABLES.tickets}
        WHERE app_id = ?1 AND team_id = ?2
          ${older}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...parameters).all();
    const rows = result.results ?? [];
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return json({
      tickets: page.map(ticketJson),
      nextCursor: rows.length > 100 && last ? `${last.created_at}|${last.id}` : null
    });
  }
  if (!id && request.method === "POST") {
    const body = await readJson(request, env);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const holderId = typeof body.holderId === "string" && body.holderId ? body.holderId : null;
    const eventId = typeof body.eventId === "string" && body.eventId ? body.eventId.trim() : null;
    const metadata = body.metadata === void 0 ? {} : body.metadata;
    const fields = {};
    if (!label || label.length > 120) fields.label = "Use 1 to 120 characters";
    if (holderId && !NAME.test(holderId)) fields.holderId = "Choose a valid user";
    if (eventId && eventId.length > 160) fields.eventId = "Use at most 160 characters";
    if (!isObject(metadata)) fields.metadata = "Expected an object";
    let expiresAt = null;
    if (body.expiresAt !== void 0 && body.expiresAt !== null) {
      const parsed = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= Date.now()) fields.expiresAt = "Choose a future date";
      else expiresAt = new Date(parsed).toISOString();
    }
    if (Object.keys(fields).length > 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "Ticket input is invalid.", fields);
    }
    if (holderId) {
      const holder = await env.DB.prepare(
        `SELECT id FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2 LIMIT 1`
      ).bind(currentAppId, holderId).first();
      if (!holder) throw new HttpError(422, "VALIDATION_ERROR", "Ticket holder does not exist.");
    }
    const encodedMetadata = JSON.stringify(metadata);
    if (encoder.encode(encodedMetadata).byteLength > maxJsonBytes(env)) {
      throw new HttpError(413, "BAD_REQUEST", "Ticket metadata is too large.");
    }
    const code = `tkt_${base64Url(randomBytes(24))}`;
    const timestamp = now();
    const ticket = {
      id: makeId("ticket"),
      owner_id: auth.user.id,
      team_id: membership.id,
      holder_id: holderId,
      label,
      event_id: eventId,
      code_prefix: code.slice(0, 12),
      metadata: encodedMetadata,
      expires_at: expiresAt,
      consumed_at: null,
      consumed_by: null,
      created_at: timestamp,
      updated_at: timestamp
    };
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.tickets}
         (app_id, id, owner_id, team_id, holder_id, label, event_id, code_hash, code_prefix,
          metadata, expires_at, consumed_at, consumed_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12, ?12)`
    ).bind(
      currentAppId,
      ticket.id,
      ticket.owner_id,
      ticket.team_id,
      ticket.holder_id,
      ticket.label,
      ticket.event_id,
      await sha256(code),
      ticket.code_prefix,
      ticket.metadata,
      ticket.expires_at,
      timestamp
    ).run();
    return json({ ticket: ticketJson(ticket), code }, 201);
  }
  if ((id === "lookup" || id === "consume") && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "ticket-scan", 180, 60, auth.user.id);
    const body = await readJson(request, env);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (code.length < 20 || code.length > 1024) {
      throw new HttpError(422, "VALIDATION_ERROR", "Ticket code is invalid.", { code: "Enter a valid ticket code" });
    }
    const ticket = await env.DB.prepare(
      `SELECT ${TICKET_COLUMNS} FROM ${INTERNAL_TABLES.tickets}
        WHERE app_id = ?1 AND team_id = ?2 AND code_hash = ?3 LIMIT 1`
    ).bind(currentAppId, membership.id, await sha256(code)).first();
    if (!ticket) throw new HttpError(404, "NOT_FOUND", "Ticket is invalid.");
    if (id === "lookup") return json({ ticket: ticketJson(ticket) });
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new HttpError(422, "VALIDATION_ERROR", "Ticket idempotency key is invalid.", {
        idempotencyKey: "Use a stable key from 8 to 200 characters"
      });
    }
    const prior = await env.DB.prepare(
      `SELECT consumed_by FROM ${INTERNAL_TABLES.ticketConsumptions}
        WHERE app_id = ?1 AND ticket_id = ?2 AND idempotency_key = ?3 LIMIT 1`
    ).bind(currentAppId, ticket.id, idempotencyKey).first();
    if (prior) {
      if (prior.consumed_by !== auth.user.id) throw new HttpError(409, "CONFLICT", "That scan key is already in use.");
      const current = await env.DB.prepare(
        `SELECT ${TICKET_COLUMNS} FROM ${INTERNAL_TABLES.tickets}
          WHERE app_id = ?1 AND id = ?2 LIMIT 1`
      ).bind(currentAppId, ticket.id).first();
      return json({ consumed: true, idempotent: true, ticket: ticketJson(current ?? ticket) });
    }
    try {
      await env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.ticketConsumptions}
           (app_id, id, ticket_id, idempotency_key, consumed_by, consumed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(currentAppId, makeId("consumption"), ticket.id, idempotencyKey, auth.user.id, now()).run();
    } catch (error) {
      if (String(error).includes("ARMADILLO_TICKET_UNAVAILABLE") || String(error).toLowerCase().includes("unique")) {
        const repeated = await env.DB.prepare(
          `SELECT consumed_by FROM ${INTERNAL_TABLES.ticketConsumptions}
            WHERE app_id = ?1 AND ticket_id = ?2 AND idempotency_key = ?3 LIMIT 1`
        ).bind(currentAppId, ticket.id, idempotencyKey).first();
        if (repeated?.consumed_by === auth.user.id) {
          const current = await env.DB.prepare(
            `SELECT ${TICKET_COLUMNS} FROM ${INTERNAL_TABLES.tickets}
              WHERE app_id = ?1 AND id = ?2 LIMIT 1`
          ).bind(currentAppId, ticket.id).first();
          return json({ consumed: true, idempotent: true, ticket: ticketJson(current ?? ticket) });
        }
        throw new HttpError(409, "CONFLICT", "Ticket is already consumed or expired.");
      }
      throw error;
    }
    const updated = await env.DB.prepare(
      `SELECT ${TICKET_COLUMNS} FROM ${INTERNAL_TABLES.tickets}
        WHERE app_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(currentAppId, ticket.id).first();
    return json({ consumed: true, idempotent: false, ticket: ticketJson(updated ?? ticket) });
  }
  if (id && request.method === "GET") {
    const ticket = await env.DB.prepare(
      `SELECT ${TICKET_COLUMNS} FROM ${INTERNAL_TABLES.tickets}
        WHERE app_id = ?1 AND team_id = ?2 AND id = ?3 LIMIT 1`
    ).bind(currentAppId, membership.id, id).first();
    if (!ticket) throw new HttpError(404, "NOT_FOUND", "Ticket not found.");
    return json({ ticket: ticketJson(ticket) });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  TICKET_COLUMNS,
  ticketJson,
  ticketRoles,
  ticketsRoute
};
