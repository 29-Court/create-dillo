import {} from "../backend.js";
import {} from "../backend.js";
import { now } from "./records.js";
import {} from "./environment.js";
import { requireAuth } from "./auth.js";
import { enforceRateLimit } from "./auth.js";
import { readJson } from "./validation.js";
import { HttpError } from "./http.js";
import { INTERNAL_TABLES } from "../backend.js";
import { sha256 } from "./helpers/crypto.js";
import { json } from "./http.js";
import { makeId } from "./helpers/id.js";
import { base64Url } from "./helpers/id.js";
import { randomBytes } from "./helpers/id.js";
function voucherJson(row) {
  const status = row.expires_at && row.expires_at <= now() ? "expired" : row.remaining <= 0 ? "depleted" : "active";
  return {
    id: row.id,
    name: row.name,
    codePrefix: row.code_prefix,
    capacity: row.capacity,
    remaining: row.remaining,
    consumed: row.capacity - row.remaining,
    status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
const VOUCHER_COLUMNS = "id, owner_id, name, code_prefix, capacity, remaining, expires_at, created_at, updated_at";
async function vouchersRoute(request, env, currentAppId, id, action) {
  if (id === "consume" && !action && request.method === "POST") {
    const auth2 = await requireAuth(request, env, currentAppId, "vouchers:consume");
    await enforceRateLimit(request, env, currentAppId, "voucher-consume", 120, 60, auth2.user.id);
    const body = await readJson(request, env);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (code.length < 20 || code.length > 1024 || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new HttpError(422, "VALIDATION_ERROR", "Voucher redemption input is invalid.", {
        ...code.length < 20 || code.length > 1024 ? { code: "Enter a valid voucher code" } : {},
        ...idempotencyKey.length < 8 || idempotencyKey.length > 200 ? { idempotencyKey: "Use a stable key from 8 to 200 characters" } : {}
      });
    }
    const voucher2 = await env.DB.prepare(
      `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
        WHERE app_id = ?1 AND code_hash = ?2 LIMIT 1`
    ).bind(currentAppId, await sha256(code)).first();
    if (!voucher2) throw new HttpError(404, "NOT_FOUND", "Voucher is invalid.");
    const prior = await env.DB.prepare(
      `SELECT consumed_by FROM ${INTERNAL_TABLES.voucherRedemptions}
        WHERE app_id = ?1 AND voucher_id = ?2 AND idempotency_key = ?3 LIMIT 1`
    ).bind(currentAppId, voucher2.id, idempotencyKey).first();
    if (prior) {
      if (prior.consumed_by !== auth2.user.id) {
        throw new HttpError(409, "CONFLICT", "That idempotency key is already in use.");
      }
      const current = await env.DB.prepare(
        `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
          WHERE app_id = ?1 AND id = ?2 LIMIT 1`
      ).bind(currentAppId, voucher2.id).first();
      return json({ consumed: true, idempotent: true, voucher: voucherJson(current ?? voucher2) });
    }
    try {
      await env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.voucherRedemptions}
           (app_id, id, voucher_id, idempotency_key, consumed_by, consumed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(currentAppId, makeId("redemption"), voucher2.id, idempotencyKey, auth2.user.id, now()).run();
    } catch (error) {
      const message = String(error);
      if (message.includes("ARMADILLO_VOUCHER_UNAVAILABLE")) {
        throw new HttpError(409, "CONFLICT", "Voucher is depleted or expired.");
      }
      if (message.toLowerCase().includes("unique")) {
        const repeated = await env.DB.prepare(
          `SELECT consumed_by FROM ${INTERNAL_TABLES.voucherRedemptions}
            WHERE app_id = ?1 AND voucher_id = ?2 AND idempotency_key = ?3 LIMIT 1`
        ).bind(currentAppId, voucher2.id, idempotencyKey).first();
        if (repeated?.consumed_by === auth2.user.id) {
          const current = await env.DB.prepare(
            `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
              WHERE app_id = ?1 AND id = ?2 LIMIT 1`
          ).bind(currentAppId, voucher2.id).first();
          return json({ consumed: true, idempotent: true, voucher: voucherJson(current ?? voucher2) });
        }
      }
      if (message.toLowerCase().includes("unique")) {
        throw new HttpError(409, "CONFLICT", "Voucher is already consumed or expired.");
      }
      throw error;
    }
    const updated = await env.DB.prepare(
      `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
        WHERE app_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(currentAppId, voucher2.id).first();
    return json({ consumed: true, idempotent: false, voucher: voucherJson(updated ?? voucher2) });
  }
  const write = request.method !== "GET";
  const auth = await requireAuth(request, env, currentAppId, write ? "vouchers:write" : "vouchers:read");
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
        throw new HttpError(400, "BAD_REQUEST", "Voucher cursor is invalid.");
      }
    }
    const parameters = [currentAppId, auth.user.id];
    let older = "";
    if (cursorCreatedAt && cursorId) {
      older = "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))";
      parameters.push(cursorCreatedAt, cursorId);
    }
    parameters.push(101);
    const result = await env.DB.prepare(
      `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
        WHERE app_id = ?1 AND owner_id = ?2
          ${older}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...parameters).all();
    const rows = result.results ?? [];
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return json({
      vouchers: page.map(voucherJson),
      nextCursor: rows.length > 100 && last ? `${last.created_at}|${last.id}` : null
    });
  }
  if (!id && request.method === "POST") {
    const body = await readJson(request, env);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const capacity = body.capacity === void 0 || body.capacity === null ? 1 : Number(body.capacity);
    if (!name || name.length > 120 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1e6) {
      throw new HttpError(422, "VALIDATION_ERROR", "Voucher input is invalid.", {
        ...!name || name.length > 120 ? { name: "Use 1 to 120 characters" } : {},
        ...!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1e6 ? { capacity: "Use an integer from 1 to 1,000,000" } : {}
      });
    }
    let expiresAt = null;
    if (body.expiresAt !== void 0 && body.expiresAt !== null) {
      const parsed = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= Date.now()) {
        throw new HttpError(422, "VALIDATION_ERROR", "Voucher expiry must be in the future.", {
          expiresAt: "Choose a future date"
        });
      }
      expiresAt = new Date(parsed).toISOString();
    }
    const code = `vch_${base64Url(randomBytes(24))}`;
    const voucherId = makeId("voucher");
    const timestamp = now();
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.vouchers}
         (app_id, id, owner_id, name, code_hash, code_prefix, capacity, remaining, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?9)`
    ).bind(currentAppId, voucherId, auth.user.id, name, await sha256(code), code.slice(0, 12), capacity, expiresAt, timestamp).run();
    const row = {
      id: voucherId,
      owner_id: auth.user.id,
      name,
      code_prefix: code.slice(0, 12),
      capacity,
      remaining: capacity,
      expires_at: expiresAt,
      created_at: timestamp,
      updated_at: timestamp
    };
    return json({ voucher: voucherJson(row), code }, 201);
  }
  const voucher = await env.DB.prepare(
    `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
      WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 LIMIT 1`
  ).bind(currentAppId, id ?? "", auth.user.id).first();
  if (!voucher) throw new HttpError(404, "NOT_FOUND", "Voucher not found.");
  if (!action && request.method === "GET") return json({ voucher: voucherJson(voucher) });
  if (action === "restock" && request.method === "POST") {
    const body = await readJson(request, env);
    const amount = body.amount === void 0 || body.amount === null ? 1 : Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1e6) {
      throw new HttpError(422, "VALIDATION_ERROR", "Restock amount is invalid.", {
        amount: "Use an integer from 1 to 1,000,000"
      });
    }
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.vouchers}
          SET remaining = min(capacity, remaining + ?1), updated_at = ?2
        WHERE app_id = ?3 AND id = ?4 AND owner_id = ?5`
    ).bind(amount, now(), currentAppId, voucher.id, auth.user.id).run();
    const updated = await env.DB.prepare(
      `SELECT ${VOUCHER_COLUMNS} FROM ${INTERNAL_TABLES.vouchers}
        WHERE app_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(currentAppId, voucher.id).first();
    return json({ voucher: voucherJson(updated ?? voucher) });
  }
  if (!action && request.method === "DELETE") {
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.vouchers} SET expires_at = ?1, updated_at = ?1
        WHERE app_id = ?2 AND id = ?3 AND owner_id = ?4`
    ).bind(now(), currentAppId, voucher.id, auth.user.id).run();
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  VOUCHER_COLUMNS,
  voucherJson,
  vouchersRoute
};
