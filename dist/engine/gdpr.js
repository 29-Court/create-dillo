import {} from "./environment.js";
import {} from "../backend.js";
import { json } from "./http.js";
import { requireUserSession } from "./auth.js";
import { INTERNAL_TABLES } from "../backend.js";
import {} from "../backend.js";
import { enforceRateLimit } from "./auth.js";
import { readJson } from "./validation.js";
import { HttpError } from "./http.js";
import { now } from "./records.js";
import { sha256 } from "./helpers/crypto.js";
import { makeId } from "./helpers/id.js";
import { membershipsFor } from "./teams.js";
import { sqlIdentifier } from "./records.js";
import { physicalTableName } from "../index.js";
import { physicalGeoColumns } from "../index.js";
import {} from "../backend.js";
import { userJson } from "./records.js";
import {} from "../backend.js";
const EXPORT_ROW_CAP = 5e3;
const EXPORT_BYTE_CAP = 32 * 1024 * 1024;
const ERASE_FILE_BATCH_CAP = 20;
const ERASE_FILE_BUDGET_MS = 2e4;
async function readPages(load, stamp, weigh = () => 1) {
  const rows = [];
  let bytes = 0;
  let cursorAt = null;
  let cursorId = null;
  for (; ; ) {
    const page = await load(cursorAt, cursorId);
    for (const row of page) {
      rows.push(row);
      bytes += weigh(row);
      if (rows.length >= EXPORT_ROW_CAP || bytes >= EXPORT_BYTE_CAP) {
        throw new HttpError(413, "BAD_REQUEST", "This export is too large to return in one response.", {
          limit: "Ask for a narrower export, or erase the account and export what remains."
        });
      }
    }
    if (page.length < 100) return rows;
    const last = page[page.length - 1];
    cursorAt = stamp(last);
    cursorId = last.id;
  }
}
async function gdprRoute(request, env, currentAppId, options, sub) {
  const gdpr = options.gdpr ?? {};
  const purposes = gdpr.purposes ?? [];
  if (sub === "info" && request.method === "GET") {
    return json({
      info: {
        dpoEmail: gdpr.dpoEmail ?? null,
        privacyPolicyUrl: gdpr.privacyPolicyUrl ?? null,
        retentionDays: gdpr.retentionDays ?? null,
        purposes: [...purposes],
        requireExplicitConsent: gdpr.requireExplicitConsent ?? false
      }
    });
  }
  const auth = await requireUserSession(request, env, currentAppId);
  if (sub === "consents" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, purpose, granted, metadata, created_at, updated_at, expires_at
         FROM ${INTERNAL_TABLES.gdprConsents}
        WHERE app_id = ?1 AND user_id = ?2
        ORDER BY updated_at DESC`
    ).bind(currentAppId, auth.user.id).all();
    return json({
      consents: (rows.results ?? []).map((r) => ({
        id: r.id,
        purpose: r.purpose,
        granted: r.granted === 1,
        metadata: JSON.parse(r.metadata),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        expiresAt: r.expires_at
      }))
    });
  }
  if (sub === "consent" && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "gdpr-consent", 20, 60 * 60, auth.user.id);
    const body = await readJson(request, env);
    const purpose = typeof body.purpose === "string" ? body.purpose.trim().toLowerCase() : "";
    const granted = body.granted;
    if (!/^[a-z][a-z0-9_-]{1,47}$/.test(purpose)) {
      throw new HttpError(422, "VALIDATION_ERROR", "Consent purpose is invalid.", { purpose: "Use lowercase letters, numbers, hyphen, 2-48 chars" });
    }
    if (purposes.length > 0 && !purposes.includes(purpose)) {
      throw new HttpError(422, "VALIDATION_ERROR", `Unknown purpose \`${purpose}\`. Allowed: ${purposes.join(", ")}`, { purpose: `Choose one of: ${purposes.join(", ")}` });
    }
    if (typeof granted !== "boolean") {
      throw new HttpError(422, "VALIDATION_ERROR", "Consent granted must be a boolean.", { granted: "Use true or false" });
    }
    const metadata = body.metadata === void 0 ? {} : body.metadata;
    if (metadata !== null && typeof metadata !== "object") {
      throw new HttpError(422, "VALIDATION_ERROR", "Consent metadata must be an object.", { metadata: "Use an object" });
    }
    let expiresAt = null;
    if (body.expiresAt !== void 0 && body.expiresAt !== null) {
      const parsed = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      if (!Number.isFinite(parsed)) throw new HttpError(422, "VALIDATION_ERROR", "expiresAt must be an ISO date.", { expiresAt: "Use an ISO date" });
      expiresAt = new Date(parsed).toISOString();
    }
    const timestamp = now();
    const peerIp = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ?? "unknown";
    const ipHash = await sha256(peerIp || "unknown");
    const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 300);
    const existing = await env.DB.prepare(
      `SELECT id FROM ${INTERNAL_TABLES.gdprConsents} WHERE app_id = ?1 AND user_id = ?2 AND purpose = ?3 LIMIT 1`
    ).bind(currentAppId, auth.user.id, purpose).first();
    if (existing) {
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.gdprConsents}
            SET granted = ?1, metadata = ?2, ip_hash = ?3, user_agent = ?4, updated_at = ?5, expires_at = ?6
          WHERE app_id = ?7 AND id = ?8`
      ).bind(
        granted ? 1 : 0,
        JSON.stringify(metadata ?? {}),
        ipHash,
        userAgent,
        timestamp,
        expiresAt,
        currentAppId,
        existing.id
      ).run();
      const row = await env.DB.prepare(
        `SELECT id, purpose, granted, metadata, created_at, updated_at, expires_at FROM ${INTERNAL_TABLES.gdprConsents} WHERE app_id = ?1 AND id = ?2 LIMIT 1`
      ).bind(currentAppId, existing.id).first();
      if (!row) throw new HttpError(500, "INTERNAL_ERROR", "Could not update consent.");
      return json({ consent: { id: row.id, purpose: row.purpose, granted: row.granted === 1, metadata: JSON.parse(row.metadata), createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at } });
    }
    const id = makeId("consent");
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.gdprConsents}
         (app_id, id, user_id, purpose, granted, metadata, ip_hash, user_agent, created_at, updated_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`
    ).bind(currentAppId, id, auth.user.id, purpose, granted ? 1 : 0, JSON.stringify(metadata ?? {}), ipHash, userAgent, timestamp, expiresAt).run();
    return json({ consent: { id, purpose, granted, metadata: metadata ?? {}, createdAt: timestamp, updatedAt: timestamp, expiresAt } }, 201);
  }
  if (sub === "export" && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "gdpr-export", 3, 60 * 60, auth.user.id);
    const timestamp = now();
    const exportId = makeId("gdpr_export");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.gdprExportLog} (app_id, id, user_id, actor_user_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(currentAppId, exportId, auth.user.id, auth.user.id, timestamp, expiresAt).run();
    const consentsRows = await env.DB.prepare(
      `SELECT id, purpose, granted, metadata, created_at, updated_at, expires_at FROM ${INTERNAL_TABLES.gdprConsents} WHERE app_id = ?1 AND user_id = ?2`
    ).bind(currentAppId, auth.user.id).all();
    const memberships = await membershipsFor(env, currentAppId, auth.user.id);
    const older = (column) => `AND (?3 IS NULL OR ${column} < ?3 OR (${column} = ?3 AND id < ?4))`;
    const sessions = await readPages(
      async (cursorAt, cursorId) => (await env.DB.prepare(
        `SELECT id, created_at, expires_at FROM ${INTERNAL_TABLES.sessions}
          WHERE app_id = ?1 AND user_id = ?2 ${older("created_at")}
          ORDER BY created_at DESC, id DESC LIMIT 100`
      ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
      (row) => row.created_at
    );
    const apiKeys = await readPages(
      async (cursorAt, cursorId) => (await env.DB.prepare(
        `SELECT id, name, key_prefix, scopes, created_at FROM ${INTERNAL_TABLES.apiKeys}
          WHERE app_id = ?1 AND owner_id = ?2 ${older("created_at")}
          ORDER BY created_at DESC, id DESC LIMIT 100`
      ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
      (row) => row.created_at
    );
    const objects = await readPages(
      async (cursorAt, cursorId) => (await env.DB.prepare(
        `SELECT collection, id, data, created_at, updated_at FROM ${INTERNAL_TABLES.objects}
          WHERE app_id = ?1 AND owner_id = ?2 ${older("updated_at")}
          ORDER BY updated_at DESC, id DESC LIMIT 100`
      ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
      (row) => row.updated_at,
      // Record payloads are the bulk of an export; count them as they arrive.
      (row) => row.data.length + 128
    );
    const collections = Object.keys(options.schema?.normalized.tables ?? {});
    const physicalObjects = [];
    for (const col of collections) {
      const t = options.schema?.normalized.tables[col];
      if (t?.storage !== "columns") continue;
      try {
        const rows = await readPages(
          async (cursorAt, cursorId) => (await env.DB.prepare(
            `SELECT * FROM ${sqlIdentifier(physicalTableName(currentAppId, col))}
              WHERE app_id = ?1 AND owner_id = ?2 ${older("created_at")}
              ORDER BY created_at DESC, id DESC LIMIT 100`
          ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
          (row) => row.created_at
        );
        for (const full of rows) {
          const table = t;
          const data = {};
          for (const [fieldName, field] of Object.entries(table.fields)) {
            if (field.type === "geo") {
              const [latC, lngC, altC] = physicalGeoColumns(fieldName);
              const lat = full[latC];
              const lng = full[lngC];
              if (typeof lat === "number" && typeof lng === "number") data[fieldName] = { latitude: lat, longitude: lng, ...typeof full[altC] === "number" ? { altitude: full[altC] } : {} };
            } else {
              const v = full[fieldName];
              if (v !== null && v !== void 0) {
                data[fieldName] = field.type === "json" && typeof v === "string" ? JSON.parse(v) : v;
              }
            }
          }
          physicalObjects.push({ collection: col, id: full.id, data, createdAt: full.created_at, updatedAt: full.updated_at });
        }
      } catch {
      }
    }
    const files = await readPages(
      async (cursorAt, cursorId) => (await env.DB.prepare(
        `SELECT id, name, content_type, size, created_at FROM ${INTERNAL_TABLES.files}
          WHERE app_id = ?1 AND owner_id = ?2 ${older("created_at")}
          ORDER BY created_at DESC, id DESC LIMIT 100`
      ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
      (row) => row.created_at
    );
    const submissions = await readPages(
      async (cursorAt, cursorId) => (await env.DB.prepare(
        `SELECT id, collector_id, data, created_at, expires_at FROM ${INTERNAL_TABLES.collectorSubmissions}
          WHERE app_id = ?1 AND user_id = ?2 ${older("created_at")}
          ORDER BY created_at DESC, id DESC LIMIT 100`
      ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
      (row) => row.created_at
    );
    const tickets = await readPages(
      async (cursorAt, cursorId) => (await env.DB.prepare(
        `SELECT id, label, metadata, created_at FROM ${INTERNAL_TABLES.tickets}
          WHERE app_id = ?1 AND (owner_id = ?2 OR holder_id = ?2) ${older("created_at")}
          ORDER BY created_at DESC, id DESC LIMIT 100`
      ).bind(currentAppId, auth.user.id, cursorAt, cursorId).all()).results ?? [],
      (row) => row.created_at
    );
    const bundle = {
      exportId,
      user: userJson(auth.user),
      consents: (consentsRows.results ?? []).map((r) => ({ id: r.id, purpose: r.purpose, granted: r.granted === 1, metadata: JSON.parse(r.metadata), createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at })),
      memberships: memberships.map((m) => ({ groupId: m.groupId, groupName: m.groupName, groupSlug: m.groupSlug, role: m.role, trusted: m.trusted })),
      sessions: sessions.map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at })),
      apiKeys: apiKeys.map((r) => ({ id: r.id, name: r.name, prefix: r.key_prefix, scopes: JSON.parse(r.scopes), createdAt: r.created_at })),
      objects: [
        ...objects.map((r) => ({ collection: r.collection, id: r.id, data: JSON.parse(r.data), createdAt: r.created_at, updatedAt: r.updated_at })),
        ...physicalObjects
      ],
      files: files.map((r) => ({ id: r.id, name: r.name, contentType: r.content_type, size: r.size, createdAt: r.created_at })),
      collectorSubmissions: submissions.map((r) => ({ id: r.id, collectorId: r.collector_id, data: JSON.parse(r.data), createdAt: r.created_at, expiresAt: r.expires_at })),
      tickets: tickets.map((r) => ({ id: r.id, label: r.label, metadata: JSON.parse(r.metadata), createdAt: r.created_at })),
      generatedAt: timestamp,
      dpoEmail: gdpr.dpoEmail ?? null,
      privacyPolicyUrl: gdpr.privacyPolicyUrl ?? null
    };
    return json({ bundle });
  }
  if (sub === "rectify" && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "gdpr-rectify", 10, 60 * 60, auth.user.id);
    const body = await readJson(request, env);
    const updates = {};
    const fields = {};
    if (body.name !== void 0) {
      const name = body.name === null ? null : typeof body.name === "string" ? body.name.trim() : void 0;
      if (name !== null && name !== void 0 && (name.length === 0 || name.length > 120)) fields.name = "Use between 1 and 120 characters";
      else if (name !== void 0) updates.name = name;
    }
    if (body.email !== void 0) {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) fields.email = "Enter a valid email address";
      else updates.email = email;
    }
    if (Object.keys(fields).length > 0) throw new HttpError(422, "VALIDATION_ERROR", "Rectification input is invalid.", fields);
    if (Object.keys(updates).length === 0) throw new HttpError(422, "VALIDATION_ERROR", "No rectification fields provided.", { data: "Provide name or email" });
    try {
      const sets = [];
      const binds = [];
      if (updates.name !== void 0) {
        sets.push("name = ?");
        binds.push(updates.name === null ? null : updates.name);
      }
      if (updates.email !== void 0) {
        sets.push("email = ?");
        binds.push(updates.email);
      }
      sets.push("updated_at = ?");
      binds.push(now());
      const idx = binds.length;
      const result = await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET ${sets.join(", ")} WHERE app_id = ?${idx + 1} AND id = ?${idx + 2}`
      ).bind(...binds, currentAppId, auth.user.id).run();
      if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, "NOT_FOUND", "User not found.");
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) throw new HttpError(409, "CONFLICT", "That email is already in use.", { email: "Choose a different email" });
      throw error;
    }
    const updated = await env.DB.prepare(
      `SELECT id, email, name, password_hash, password_salt, password_iterations, password_enabled, profile, created_at, updated_at FROM ${INTERNAL_TABLES.users} WHERE app_id = ?1 AND id = ?2 LIMIT 1`
    ).bind(currentAppId, auth.user.id).first();
    if (!updated) throw new HttpError(404, "NOT_FOUND", "User not found.");
    return json({ user: userJson(updated) });
  }
  if (sub === "restrict" && request.method === "POST") {
    const body = await readJson(request, env);
    const restricted = body.restricted;
    if (typeof restricted !== "boolean") throw new HttpError(422, "VALIDATION_ERROR", "restricted must be a boolean.", { restricted: "Use true or false" });
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
    const timestamp = now();
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.gdprRestrictions} (app_id, user_id, restricted, reason, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (app_id, user_id) DO UPDATE SET restricted = excluded.restricted, reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(currentAppId, auth.user.id, restricted ? 1 : 0, reason, timestamp, auth.user.id).run();
    return json({ restricted });
  }
  if (sub === "erasure-log" && request.method === "GET") {
    const superadminSlug = env.ARMADILLO_SUPERADMIN_GROUP?.trim() || "armadillo-superadmins";
    const isPrivileged = (await membershipsFor(env, currentAppId, auth.user.id)).some(
      (member) => member.trusted && member.groupSlug === superadminSlug && ["owner", "admin"].includes(member.role)
    );
    if (isPrivileged) {
      const rows2 = await env.DB.prepare(
        `SELECT id, target_user_id, actor_user_id, strategy, reason, created_at, completed_at FROM ${INTERNAL_TABLES.gdprErasureLog} WHERE app_id = ?1 ORDER BY created_at DESC LIMIT 100`
      ).bind(currentAppId).all();
      return json({ log: (rows2.results ?? []).map((r) => ({ id: r.id, targetUserId: r.target_user_id, actorUserId: r.actor_user_id, strategy: r.strategy, reason: r.reason, createdAt: r.created_at, completedAt: r.completed_at })) });
    }
    const rows = await env.DB.prepare(
      `SELECT id, target_user_id, actor_user_id, strategy, reason, created_at, completed_at FROM ${INTERNAL_TABLES.gdprErasureLog} WHERE app_id = ?1 AND target_user_id = ?2 ORDER BY created_at DESC LIMIT 100`
    ).bind(currentAppId, auth.user.id).all();
    return json({ log: (rows.results ?? []).map((r) => ({ id: r.id, targetUserId: r.target_user_id, actorUserId: r.actor_user_id, strategy: r.strategy, reason: r.reason, createdAt: r.created_at, completedAt: r.completed_at })) });
  }
  if (sub === "erase" && request.method === "POST") {
    await enforceRateLimit(request, env, currentAppId, "gdpr-erase", 3, 60 * 60, auth.user.id);
    const body = await readJson(request, env);
    const confirm = typeof body.confirm === "string" ? body.confirm : "";
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1e3) : null;
    const strategy = body.strategy === "anonymize" ? "anonymize" : "delete";
    if (confirm !== "ERASE" && confirm !== "DELETE") {
      throw new HttpError(422, "VALIDATION_ERROR", "Erasure requires explicit confirmation.", { confirm: 'Send { confirm: "ERASE" }' });
    }
    const timestamp = now();
    const erasureId = makeId("gdpr_erase");
    let deletedObjects = 0;
    let deletedFiles = 0;
    let deletedCollectorSubs = 0;
    const sharedOwnedGroup = await env.DB.prepare(
      `SELECT m.group_id, (SELECT g.slug FROM ${INTERNAL_TABLES.groups} AS g
          WHERE g.app_id = m.app_id AND g.id = m.group_id) AS slug
         FROM ${INTERNAL_TABLES.groupMembers} AS m
        WHERE m.app_id = ?1 AND m.user_id = ?2 AND m.role = 'owner'
          AND EXISTS (SELECT 1 FROM ${INTERNAL_TABLES.groupMembers} AS other
                       WHERE other.app_id = m.app_id AND other.group_id = m.group_id
                         AND other.user_id != ?2)
        ORDER BY m.group_id LIMIT 1`
    ).bind(currentAppId, auth.user.id).first();
    if (sharedOwnedGroup) {
      throw new HttpError(
        409,
        "CONFLICT",
        `You are the owner of team \`${sharedOwnedGroup.slug ?? ""}\` with other members. Transfer ownership before erasure.`,
        { team: sharedOwnedGroup.slug ?? "" }
      );
    }
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.gdprErasureLog} (app_id, id, target_user_id, actor_user_id, strategy, reason, details, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(currentAppId, erasureId, auth.user.id, auth.user.id, strategy, reason, JSON.stringify({ confirm }), timestamp).run();
    if (strategy === "delete") {
      const objRes = await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.objects} WHERE app_id = ?1 AND owner_id = ?2`).bind(currentAppId, auth.user.id).run();
      deletedObjects += objRes.meta.changes ?? 0;
      const collections = Object.keys(options.schema?.normalized.tables ?? {});
      for (const col of collections) {
        const t = options.schema?.normalized.tables[col];
        if (t?.storage !== "columns") continue;
        try {
          const res = await env.DB.prepare(`DELETE FROM ${sqlIdentifier(physicalTableName(currentAppId, col))} WHERE app_id = ?1 AND owner_id = ?2`).bind(currentAppId, auth.user.id).run();
          deletedObjects += res.meta.changes ?? 0;
        } catch {
        }
      }
      const eraseDeadline = Date.now() + ERASE_FILE_BUDGET_MS;
      for (let round = 0; round < ERASE_FILE_BATCH_CAP; round += 1) {
        if (Date.now() > eraseDeadline) break;
        const filesRows = await env.DB.prepare(
          `SELECT id, storage_key FROM ${INTERNAL_TABLES.files} WHERE app_id = ?1 AND owner_id = ?2 LIMIT 500`
        ).bind(currentAppId, auth.user.id).all();
        const page = filesRows.results ?? [];
        if (page.length === 0) break;
        for (const file of page) {
          try {
            await env.FILES.delete(file.storage_key);
          } catch (error) {
            console.warn("Armadillo could not delete an erased file object", { fileId: file.id, error: String(error) });
          }
          deletedFiles += 1;
        }
        await env.DB.prepare(
          `DELETE FROM ${INTERNAL_TABLES.files} WHERE app_id = ?1 AND owner_id = ?2 AND id IN (${page.map(() => "?").join(", ")})`
        ).bind(currentAppId, auth.user.id, ...page.map((file) => file.id)).run();
      }
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.fileLinks} WHERE app_id = ?1 AND owner_id = ?2`).bind(currentAppId, auth.user.id).run();
      const collRes = await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.collectorSubmissions} WHERE app_id = ?1 AND user_id = ?2`).bind(currentAppId, auth.user.id).run();
      deletedCollectorSubs += collRes.meta.changes ?? 0;
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.tickets} WHERE app_id = ?1 AND owner_id = ?2`).bind(currentAppId, auth.user.id).run();
      await env.DB.prepare(`UPDATE ${INTERNAL_TABLES.apiKeys} SET revoked_at = ?1 WHERE app_id = ?2 AND owner_id = ?3 AND revoked_at IS NULL`).bind(timestamp, currentAppId, auth.user.id).run();
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.groupMembers} WHERE app_id = ?1 AND user_id = ?2`).bind(currentAppId, auth.user.id).run();
      await env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.groups}
          WHERE app_id = ?1
            AND trusted = 0
            AND NOT EXISTS (SELECT 1 FROM ${INTERNAL_TABLES.groupMembers} AS m
                             WHERE m.app_id = ?1 AND m.group_id = ${INTERNAL_TABLES.groups}.id)
            AND id IN (SELECT group_id FROM ${INTERNAL_TABLES.groupMembers}
                        WHERE app_id = ?1 AND user_id = ?2 AND role = 'owner')`
      ).bind(currentAppId, auth.user.id).run();
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.sessions} WHERE app_id = ?1 AND user_id = ?2`).bind(currentAppId, auth.user.id).run();
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.magicLinks} WHERE app_id = ?1 AND user_id = ?2`).bind(currentAppId, auth.user.id).run();
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.vouchers} WHERE app_id = ?1 AND owner_id = ?2`).bind(currentAppId, auth.user.id).run();
      await env.DB.prepare(`DELETE FROM ${INTERNAL_TABLES.gdprConsents} WHERE app_id = ?1 AND user_id = ?2`).bind(currentAppId, auth.user.id).run();
      const tombstoneEmail = `erased_${auth.user.id}@deleted.local`;
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET email = ?1, name = NULL, password_hash = 'erased', password_salt = 'erased', password_iterations = 0, password_enabled = 0, updated_at = ?2 WHERE app_id = ?3 AND id = ?4`
      ).bind(tombstoneEmail, timestamp, currentAppId, auth.user.id).run();
      await env.DB.prepare(`UPDATE ${INTERNAL_TABLES.gdprErasureLog} SET completed_at = ?1, details = ?2 WHERE app_id = ?3 AND id = ?4`).bind(timestamp, JSON.stringify({ deletedObjects, deletedFiles, deletedCollectorSubs }), currentAppId, erasureId).run();
      return json({ erased: true, strategy, details: { deletedObjects, deletedFiles, deletedCollectorSubs, tombstoneEmail } });
    } else {
      const tombstoneEmail = `anon_${auth.user.id}@deleted.local`;
      await env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET email = ?1, name = NULL, updated_at = ?2 WHERE app_id = ?3 AND id = ?4`
      ).bind(tombstoneEmail, timestamp, currentAppId, auth.user.id).run();
      await env.DB.prepare(`UPDATE ${INTERNAL_TABLES.gdprErasureLog} SET completed_at = ?1, details = ?2 WHERE app_id = ?3 AND id = ?4`).bind(timestamp, JSON.stringify({ anonymized: true, tombstoneEmail }), currentAppId, erasureId).run();
      return json({ erased: true, strategy, details: { anonymized: true, tombstoneEmail } });
    }
  }
  throw new HttpError(404, "NOT_FOUND", "GDPR route not found.");
}
export {
  gdprRoute
};
