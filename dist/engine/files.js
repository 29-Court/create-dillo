import { HTTP_API_PREFIX } from "../versions.js";
import {} from "./environment.js";
import { maxFileBytes } from "./http.js";
import { HttpError } from "./http.js";
import { INTERNAL_TABLES } from "../backend.js";
import {} from "../backend.js";
import { now } from "./records.js";
import {} from "./environment.js";
import { readJson } from "./validation.js";
import { makeId } from "./helpers/id.js";
import { json } from "./http.js";
import { fileJson } from "./validation.js";
import { isObject } from "./helpers/json.js";
import {} from "../index.js";
import { findObject, sqlIdentifier } from "./records.js";
import { recordAccessClause } from "./permissions.js";
import { physicalTableName } from "../schema-migrations.js";
import { DIRECT_UPLOAD_LIMIT_BYTES } from "./http.js";
import { requireAuth } from "./auth.js";
import { integer } from "./queries.js";
import {} from "./environment.js";
import { validName } from "./apps.js";
import { chargeUsage, peekUsageQuota, withUsageCharge } from "./usage.js";
import { boundedBody } from "./body.js";
function fileIntentInput(body, env) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const contentType = typeof body.contentType === "string" ? body.contentType.trim().toLowerCase() : "application/octet-stream";
  const size = body.size === void 0 || body.size === null ? null : Number(body.size);
  const fields = {};
  if (!name || name.length > 255 || /[\u0000-\u001F\u007F]/.test(name)) fields.name = "Use 1 to 255 visible characters";
  if (!contentType || contentType.length > 255 || !/^[^\s/]+\/[^\s/]+$/.test(contentType)) {
    fields.contentType = "Use a valid MIME type";
  }
  if (size !== null && (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes(env))) {
    fields.size = `Use a byte count no greater than ${maxFileBytes(env)}`;
  }
  if (Object.keys(fields).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "File upload input is invalid.", fields);
  }
  return { name, contentType, size };
}
async function findFileUpload(env, currentAppId, id, ownerId) {
  return env.DB.prepare(
    `SELECT id, owner_id, storage_key, name, content_type, expected_size, kind,
            r2_upload_id, status, created_at, expires_at
       FROM ${INTERNAL_TABLES.fileUploads}
      WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 LIMIT 1`
  ).bind(currentAppId, id, ownerId).first();
}
async function persistCompletedFile(env, currentAppId, upload, object, backend = {}) {
  if (object.size > maxFileBytes(env)) {
    await env.FILES.delete(upload.storage_key);
    throw new HttpError(413, "BAD_REQUEST", "Uploaded file exceeds the configured size limit.");
  }
  if (upload.expected_size !== null && object.size !== upload.expected_size) {
    await env.FILES.delete(upload.storage_key);
    throw new HttpError(422, "VALIDATION_ERROR", "Uploaded size does not match the declared file size.", {
      size: `Expected ${upload.expected_size} bytes but received ${object.size}`
    });
  }
  const createdAt = now();
  const stored = Number(object.size) || 0;
  try {
    await withUsageCharge(env, currentAppId, backend, "files_stored_bytes", stored, async () => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ${INTERNAL_TABLES.files}
             (app_id, id, owner_id, storage_key, name, content_type, size, etag, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        ).bind(
          currentAppId,
          upload.id,
          upload.owner_id,
          upload.storage_key,
          upload.name,
          upload.content_type,
          object.size,
          object.etag,
          createdAt
        ),
        env.DB.prepare(
          `UPDATE ${INTERNAL_TABLES.fileUploads} SET status = 'complete'
            WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 AND status = 'pending'`
        ).bind(currentAppId, upload.id, upload.owner_id)
      ]);
    });
  } catch (error) {
    await env.FILES.delete(upload.storage_key);
    throw error;
  }
  return {
    id: upload.id,
    owner_id: upload.owner_id,
    storage_key: upload.storage_key,
    name: upload.name,
    content_type: upload.content_type,
    size: object.size,
    etag: object.etag,
    created_at: createdAt
  };
}
async function createPresignedUpload(request, env, currentAppId, auth) {
  if (!env.ARMADILLO_FILE_URLS) {
    throw new HttpError(501, "INTERNAL_ERROR", "Direct uploads require an object-storage URL signer.");
  }
  const input = fileIntentInput(await readJson(request, env), env);
  const id = makeId("file");
  const storageKey = `${currentAppId}/${auth.user.id}/${id}`;
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1e3).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${INTERNAL_TABLES.fileUploads}
       (app_id, id, owner_id, storage_key, name, content_type, expected_size,
        kind, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'presigned', 'pending', ?8, ?9)`
  ).bind(currentAppId, id, auth.user.id, storageKey, input.name, input.contentType, input.size, createdAt, expiresAt).run();
  const uploadUrl = await env.ARMADILLO_FILE_URLS.upload(storageKey, input.contentType, 15 * 60);
  return json({
    upload: {
      id,
      uploadUrl,
      method: "PUT",
      headers: { "content-type": input.contentType },
      expiresAt
    }
  }, 201);
}
async function completePresignedUpload(env, currentAppId, auth, id, backend = {}) {
  const upload = await findFileUpload(env, currentAppId, id, auth.user.id);
  if (!upload || upload.kind !== "presigned" || upload.status !== "pending" || upload.expires_at <= now()) {
    throw new HttpError(404, "NOT_FOUND", "Upload intent is missing or expired.");
  }
  const object = await env.FILES.head(upload.storage_key);
  if (!object) throw new HttpError(409, "CONFLICT", "Upload the object before completing this intent.");
  await assertUploadedBytesMatch(env, currentAppId, upload);
  return json({ file: fileJson(await persistCompletedFile(env, currentAppId, upload, object, backend)) }, 201);
}
async function assertUploadedBytesMatch(env, currentAppId, upload) {
  if (!isActiveContentType(upload.content_type)) return;
  const stored = await env.FILES.get(upload.storage_key);
  if (!stored?.body) return;
  if (!await looksLikeMarkup(stored.body)) return;
  await env.FILES.delete(upload.storage_key);
  await env.DB.prepare(
    `UPDATE ${INTERNAL_TABLES.fileUploads} SET status = 'aborted'
      WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3 AND status = 'pending'`
  ).bind(currentAppId, upload.id, upload.owner_id).run();
  throw new HttpError(422, "VALIDATION_ERROR", "That upload's declared type does not match its contents.", {
    contentType: "This type would be executed by a browser; upload it as application/octet-stream instead"
  });
}
async function createMultipartUpload(request, env, currentAppId, auth) {
  const input = fileIntentInput(await readJson(request, env), env);
  const id = makeId("file");
  const storageKey = `${currentAppId}/${auth.user.id}/${id}`;
  const multipart = await env.FILES.createMultipartUpload(storageKey, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: { appId: currentAppId, ownerId: auth.user.id, fileId: id, name: input.name }
  });
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.fileUploads}
         (app_id, id, owner_id, storage_key, name, content_type, expected_size,
          kind, r2_upload_id, status, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'multipart', ?8, 'pending', ?9, ?10)`
    ).bind(
      currentAppId,
      id,
      auth.user.id,
      storageKey,
      input.name,
      input.contentType,
      input.size,
      multipart.uploadId,
      createdAt,
      expiresAt
    ).run();
  } catch (error) {
    await multipart.abort();
    throw error;
  }
  return json({ upload: { id, uploadId: multipart.uploadId, partSize: 10 * 1024 * 1024, expiresAt } }, 201);
}
async function multipartUploadRoute(request, env, currentAppId, auth, id, action, part, backend = {}) {
  const upload = await findFileUpload(env, currentAppId, id, auth.user.id);
  if (!upload || upload.kind !== "multipart" || !upload.r2_upload_id || upload.status !== "pending") {
    throw new HttpError(404, "NOT_FOUND", "Multipart upload is missing or no longer active.");
  }
  const multipart = env.FILES.resumeMultipartUpload(upload.storage_key, upload.r2_upload_id);
  if (action === "parts" && part && request.method === "PUT") {
    const partNumber = Number(part);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 1e4 || !request.body) {
      throw new HttpError(422, "VALIDATION_ERROR", "Multipart part is invalid.");
    }
    const maximum = Math.min(maxFileBytes(env), DIRECT_UPLOAD_LIMIT_BYTES);
    const body = env.ARMADILLO_UPLOAD_BODY?.(request, maximum) ?? boundedBody(request.body, maximum);
    const uploaded = await multipart.uploadPart(partNumber, body);
    return json({ part: { partNumber: uploaded.partNumber, etag: uploaded.etag } });
  }
  if (action === "complete" && request.method === "POST") {
    const body = await readJson(request, env);
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > 1e4) {
      throw new HttpError(422, "VALIDATION_ERROR", "Multipart completion requires uploaded parts.");
    }
    const parts = body.parts.map((candidate) => {
      if (!isObject(candidate) || !Number.isInteger(candidate.partNumber) || Number(candidate.partNumber) < 1 || Number(candidate.partNumber) > 1e4 || typeof candidate.etag !== "string" || candidate.etag.length > 200) {
        throw new HttpError(422, "VALIDATION_ERROR", "A multipart part is invalid.");
      }
      return { partNumber: Number(candidate.partNumber), etag: candidate.etag };
    });
    parts.sort((left, right) => left.partNumber - right.partNumber);
    if (new Set(parts.map((candidate) => candidate.partNumber)).size !== parts.length) {
      throw new HttpError(422, "VALIDATION_ERROR", "Multipart part numbers must be unique.");
    }
    const object = await multipart.complete(parts);
    return json({ file: fileJson(await persistCompletedFile(env, currentAppId, upload, object, backend)) }, 201);
  }
  if (!action && request.method === "DELETE") {
    await multipart.abort();
    await env.DB.prepare(
      `UPDATE ${INTERNAL_TABLES.fileUploads} SET status = 'aborted'
        WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3`
    ).bind(currentAppId, id, auth.user.id).run();
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
async function findFile(env, currentAppId, id, ownerId) {
  return env.DB.prepare(
    `SELECT id, owner_id, storage_key, name, content_type, size, etag, created_at
       FROM ${INTERNAL_TABLES.files}
      WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3
      LIMIT 1`
  ).bind(currentAppId, id, ownerId).first();
}
const ACTIVE_CONTENT_TYPES = /* @__PURE__ */ new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/mathml+xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript"
]);
function isActiveContentType(contentType) {
  return ACTIVE_CONTENT_TYPES.has(contentType.trim().toLowerCase().split(";")[0] ?? "");
}
function presignedDownloadOptions(name, contentType) {
  if (!isActiveContentType(contentType)) return void 0;
  return {
    responseContentType: "application/octet-stream",
    responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  };
}
async function looksLikeMarkup(stream, limit = 512) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    reader.releaseLock();
  } finally {
    reader.releaseLock();
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(chunks.length === 1 ? chunks[0] : concatBytes(chunks, total)).replace(/^﻿/, "").trimStart().toLowerCase();
  if (!head) return false;
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml")) return true;
  if (head.startsWith("<svg")) return true;
  return /^<(script|svg|iframe|body|html|head)\b/.test(head);
}
function concatBytes(chunks, total) {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
async function drain(stream) {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
    }
  } catch {
  } finally {
    reader.releaseLock();
  }
}
function downloadHeaders(metadata, name) {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-length": String(metadata.size),
    etag: metadata.httpEtag
  });
  metadata.writeHttpMetadata(headers);
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  return headers;
}
async function findAccessibleFile(env, currentAppId, id, userId, definition) {
  const file = await env.DB.prepare(
    `SELECT id, owner_id, storage_key, name, content_type, size, etag, created_at
       FROM ${INTERNAL_TABLES.files}
      WHERE app_id = ?1 AND id = ?2
      LIMIT 1`
  ).bind(currentAppId, id).first();
  if (!file || file.owner_id === userId) return file;
  if (await readableLink(env, currentAppId, id, userId, definition)) return file;
  return null;
}
async function readableLink(env, currentAppId, fileId, userId, definition) {
  const links = await env.DB.prepare(
    `SELECT collection, object_id
       FROM ${INTERNAL_TABLES.fileLinks}
      WHERE app_id = ?1 AND file_id = ?2`
  ).bind(currentAppId, fileId).all();
  const byCollection = /* @__PURE__ */ new Map();
  for (const link of links.results ?? []) {
    const ids = byCollection.get(link.collection);
    if (ids) ids.push(link.object_id);
    else byCollection.set(link.collection, [link.object_id]);
  }
  for (const [collection, ids] of byCollection) {
    const table = definition?.normalized.tables[collection];
    const unique = [...new Set(ids)];
    for (let offset = 0; offset < unique.length; offset += 400) {
      const slice = unique.slice(offset, offset + 400);
      const parameters = table?.storage === "columns" ? [currentAppId, JSON.stringify(slice)] : [currentAppId, collection, JSON.stringify(slice)];
      const access = recordAccessClause(table, currentAppId, userId, parameters, false);
      const source = table?.storage === "columns" ? sqlIdentifier(physicalTableName(currentAppId, collection)) : INTERNAL_TABLES.objects;
      const idList = table?.storage === "columns" ? "id IN (SELECT value FROM json_each(?2))" : "collection = ?2 AND id IN (SELECT value FROM json_each(?3))";
      const hit = await env.DB.prepare(
        `SELECT 1 AS ok FROM ${source}
          WHERE app_id = ?1 AND ${idList} ${access ? `AND (${access})` : ""}
          LIMIT 1`
      ).bind(...parameters).first();
      if (hit) return true;
    }
  }
  return false;
}
function uploadName(request) {
  const header = request.headers.get("x-armadillo-file-name") ?? "file";
  let name;
  try {
    name = decodeURIComponent(header).trim();
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "File name encoding is invalid.");
  }
  if (!name || name.length > 255 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new HttpError(422, "VALIDATION_ERROR", "File name is invalid.", {
      name: "Use 1 to 255 visible characters"
    });
  }
  return name;
}
async function uploadFile(request, env, currentAppId, auth, backend = {}) {
  if (!request.body) throw new HttpError(400, "BAD_REQUEST", "File body is required.");
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  const maximum = Math.min(maxFileBytes(env), DIRECT_UPLOAD_LIMIT_BYTES);
  if (declared > maximum) throw new HttpError(413, "BAD_REQUEST", "File exceeds the direct-upload limit; use multipart upload.");
  if (Number.isFinite(declared) && declared > 0) {
    await peekUsageQuota(env, currentAppId, backend, "files_stored_bytes", declared);
  }
  const name = uploadName(request);
  const contentType = (request.headers.get("content-type") || "application/octet-stream").slice(0, 255);
  const id = makeId("file");
  const key = `${currentAppId}/${auth.user.id}/${id}`;
  const body = env.ARMADILLO_UPLOAD_BODY?.(request, maximum) ?? boundedBody(request.body, maximum);
  if (isActiveContentType(contentType)) {
    const [forSniff, forStore] = body.tee();
    if (await looksLikeMarkup(forSniff)) {
      await drain(forStore);
      throw new HttpError(422, "VALIDATION_ERROR", "That file's declared type does not match its contents.", {
        contentType: "This type would be executed by a browser; store it as application/octet-stream instead"
      });
    }
  }
  const uploaded = await env.FILES.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { appId: currentAppId, ownerId: auth.user.id, fileId: id, name }
  });
  if (!uploaded) throw new HttpError(500, "INTERNAL_ERROR", "Object storage rejected the upload.");
  if (uploaded.size > maximum) {
    await env.FILES.delete(key);
    throw new HttpError(413, "BAD_REQUEST", "File exceeds the direct-upload limit; use multipart upload.");
  }
  const createdAt = now();
  const stored = Number(uploaded.size) || 0;
  try {
    await withUsageCharge(env, currentAppId, backend, "files_stored_bytes", stored, async () => {
      await env.DB.prepare(
        `INSERT INTO ${INTERNAL_TABLES.files}
           (app_id, id, owner_id, storage_key, name, content_type, size, etag, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(currentAppId, id, auth.user.id, key, name, contentType, uploaded.size, uploaded.etag, createdAt).run();
    });
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  return json({
    file: fileJson({
      id,
      owner_id: auth.user.id,
      storage_key: key,
      name,
      content_type: contentType,
      size: uploaded.size,
      etag: uploaded.etag,
      created_at: createdAt
    })
  }, 201);
}
async function filesRoute(request, env, currentAppId, id, action, definition, backend = {}) {
  const auth = await requireAuth(
    request,
    env,
    currentAppId,
    request.method === "GET" || request.method === "HEAD" ? "files:read" : "files:write"
  );
  if (id === "presign" && !action && request.method === "POST") {
    return createPresignedUpload(request, env, currentAppId, auth);
  }
  if (id === "multipart" && !action && request.method === "POST") {
    return createMultipartUpload(request, env, currentAppId, auth);
  }
  if (!id && request.method === "POST") return uploadFile(request, env, currentAppId, auth, backend);
  if (!id && request.method === "GET") {
    const url = new URL(request.url);
    const limit = integer(url.searchParams.get("limit") === null ? void 0 : Number(url.searchParams.get("limit")), 50, 1, 100, "limit");
    const cursor = url.searchParams.get("cursor");
    let cursorCreatedAt = null;
    let cursorId = null;
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      cursorCreatedAt = separator > 0 ? cursor.slice(0, separator) : null;
      cursorId = separator > 0 ? cursor.slice(separator + 1) : null;
      if (!cursorCreatedAt || !cursorId || !Number.isFinite(Date.parse(cursorCreatedAt))) {
        throw new HttpError(400, "BAD_REQUEST", "File cursor is invalid.");
      }
    }
    const parameters = [currentAppId, auth.user.id];
    let cursorClause = "";
    if (cursorCreatedAt && cursorId) {
      cursorClause = "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))";
      parameters.push(cursorCreatedAt, cursorId);
    }
    parameters.push(limit + 1);
    const result = await env.DB.prepare(
      `SELECT id, owner_id, storage_key, name, content_type, size, etag, created_at
         FROM ${INTERNAL_TABLES.files}
        WHERE app_id = ?1 AND owner_id = ?2
          ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...parameters).all();
    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return json({
      files: page.map(fileJson),
      nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null
    });
  }
  if (!id) throw new HttpError(404, "NOT_FOUND", "Route not found.");
  const row = request.method === "GET" || request.method === "HEAD" ? await findAccessibleFile(env, currentAppId, id, auth.user.id, definition) : await findFile(env, currentAppId, id, auth.user.id);
  if (!row) throw new HttpError(404, "NOT_FOUND", "File not found.");
  if (action === "meta" && request.method === "GET") return json({ file: fileJson(row) });
  if (action === "url" && request.method === "GET") {
    if (!env.ARMADILLO_FILE_URLS) {
      return json({ url: new URL(`${HTTP_API_PREFIX}/files/${encodeURIComponent(id)}`, request.url).toString(), expiresAt: null });
    }
    const expiresIn = 5 * 60;
    return json({
      url: await env.ARMADILLO_FILE_URLS.download(
        row.storage_key,
        expiresIn,
        // A presigned URL is served by the object store, so Armadillo's own
        // `attachment`/`nosniff` headers never apply to it. Carry the safe
        // rendering mode in the URL itself for anything a browser would run.
        presignedDownloadOptions(row.name, row.content_type)
      ),
      expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString()
    });
  }
  if (!action && request.method === "HEAD") {
    const metadata = await env.FILES.head(row.storage_key);
    if (!metadata) throw new HttpError(404, "NOT_FOUND", "Stored file is missing.");
    return new Response(null, { headers: downloadHeaders(metadata, row.name) });
  }
  if (!action && request.method === "GET") {
    const object = await env.FILES.get(row.storage_key);
    if (!object || !object.body) throw new HttpError(404, "NOT_FOUND", "Stored file is missing.");
    const served = Number(row.size) || 0;
    if (served > 0) {
      await chargeUsage(env, currentAppId, backend, "files_served_bytes", served);
    }
    return new Response(object.body, { headers: downloadHeaders(object, row.name) });
  }
  if (!action && request.method === "DELETE") {
    await env.FILES.delete(row.storage_key);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${INTERNAL_TABLES.users} SET profile_photo_id = NULL WHERE app_id = ?1 AND id = ?2 AND profile_photo_id = ?3`
      ).bind(currentAppId, auth.user.id, id),
      env.DB.prepare(
        `DELETE FROM ${INTERNAL_TABLES.files} WHERE app_id = ?1 AND id = ?2 AND owner_id = ?3`
      ).bind(currentAppId, id, auth.user.id)
    ]);
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
async function recordFilesRoute(request, env, currentAppId, collection, objectId, definition, fileId) {
  validName(collection, "Table name");
  const auth = await requireAuth(
    request,
    env,
    currentAppId,
    request.method === "GET" ? "files:read" : "files:write"
  );
  const object = await findObject(
    env,
    currentAppId,
    collection,
    objectId,
    definition,
    auth.user.id,
    request.method !== "GET"
  );
  if (!object) throw new HttpError(404, "NOT_FOUND", "Object not found.");
  if (!fileId && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT f.id, f.owner_id, f.storage_key, f.name, f.content_type, f.size, f.etag, f.created_at,
              l.relation, l.field_name, l.position
         FROM ${INTERNAL_TABLES.fileLinks} AS l
         JOIN ${INTERNAL_TABLES.files} AS f ON f.app_id = l.app_id AND f.id = l.file_id
        WHERE l.app_id = ?1 AND l.collection = ?2 AND l.object_id = ?3
          AND l.relation = 'attachment'
        ORDER BY l.position, l.created_at, f.id`
    ).bind(currentAppId, collection, objectId).all();
    return json({
      files: (rows.results ?? []).map((row) => ({
        ...fileJson(row),
        relation: row.relation,
        fieldName: row.field_name || null,
        position: row.position
      }))
    });
  }
  if (!fileId && request.method === "POST") {
    const body = await readJson(request, env);
    const requestedFileId = typeof body.fileId === "string" ? body.fileId : "";
    const position = integer(body.position, 0, 0, 1e6, "position");
    const file = await findFile(env, currentAppId, requestedFileId, auth.user.id);
    if (!file) throw new HttpError(404, "NOT_FOUND", "File not found.");
    await env.DB.prepare(
      `INSERT INTO ${INTERNAL_TABLES.fileLinks}
         (app_id, collection, object_id, file_id, owner_id, relation, field_name, position, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'attachment', '', ?6, ?7)
       ON CONFLICT(app_id, collection, object_id, file_id, relation, field_name)
       DO UPDATE SET position = excluded.position`
    ).bind(currentAppId, collection, objectId, file.id, auth.user.id, position, now()).run();
    return json({ file: fileJson(file), position }, 201);
  }
  if (fileId && request.method === "DELETE") {
    const result = await env.DB.prepare(
      `DELETE FROM ${INTERNAL_TABLES.fileLinks}
        WHERE app_id = ?1 AND collection = ?2 AND object_id = ?3
          AND file_id = ?4 AND owner_id = ?5 AND relation = 'attachment'`
    ).bind(currentAppId, collection, objectId, fileId, auth.user.id).run();
    if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, "NOT_FOUND", "Attachment not found.");
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
export {
  completePresignedUpload,
  createMultipartUpload,
  createPresignedUpload,
  fileIntentInput,
  filesRoute,
  findAccessibleFile,
  findFile,
  findFileUpload,
  isActiveContentType,
  looksLikeMarkup,
  multipartUploadRoute,
  persistCompletedFile,
  presignedDownloadOptions,
  recordFilesRoute,
  uploadFile,
  uploadName
};
