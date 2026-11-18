'use strict';
/**
 * StoragePort — the ONE storage interface platform apps call.
 * PASS-3-ARCHITECTURE-LAW.md §2.4 (apps-platform-120).
 *
 *   put(account, app, bytes|stream, metadata)   -> head record (incl. object_id, version_no)
 *   get(object_id, {version})                   -> { head, bytes: Buffer }
 *   head(object_id, {version})                  -> index record (no bytes)
 *   listByAccount(account_id)                   -> index records for exactly that account
 *   deleteObject(object_id)                     -> { object_id, blobs_deleted, versions_deleted }
 *   deleteAccountScope(account_id)              -> { account_id, objects_deleted, blobs_deleted }
 *   mintReadUrl(object_id, ttl_seconds)         -> read descriptor (backend-specific shape, see backends)
 *
 * Every method takes an entitlement context as its FIRST argument:
 *   ctx = { account_id, account_state }   // account_state: pending|verified|suspended|killed (§1.2A/§1.4)
 * The real ledger lookup (§1.2C) wires in later; here the context is a
 * parameter object, exactly as commissioned. WRITE methods (put,
 * deleteObject, deleteAccountScope) refuse any ctx whose account_state
 * is not 'verified' (§2.4: "the interface refuses calls for accounts
 * whose account_state is not verified for writes").
 * Read methods require the ctx account to own the object; a foreign
 * object id answers NotFound, never Forbidden, so list/read endpoints
 * do not leak existence (PASS-3 §3.6).
 *
 * Versioning: put() with no object_id in metadata mints a fresh object
 * at v/1. put() with metadata.object_id naming an existing object of the
 * same account+app creates the next version (metadata.version_no may pin
 * it; a duplicate version_no is refused). Prior versions stay immutable
 * and retrievable via get/head with { version: n } (§2.3: editing never
 * overwrites the prior object).
 *
 * Cross-app rule (F1/A2, 2026-11-07): put() naming an object owned by
 * another app — same account, different app_slug — answers NOT_FOUND,
 * never Forbidden, so the refusal leaks nothing about the object.
 * Quarantine rule (F1/A3): put() ALWAYS lands state='quarantined',
 * scan_state='pending', whatever the caller passes in metadata.state /
 * metadata.scan_state; those fields are ignored, never honored.
 * Version allocation (F1/A5): an auto-allocated version_no is reserved
 * in the index before bytes are written, and a conflict re-reads
 * maxVersion and retries (bounded); a conflict never deletes a prior
 * version (F1/A4: a failed version push removes only that version's
 * rows/objects).
 * Tombstones (F1, 2026-11-07; MERGE LAW, coordinator 2026-11-07):
 * deleteObject(ctx, id, { tombstone: true }) removes the BYTES but
 * keeps the index row plus all version metadata. listByAccount(ctx,
 * account, { includeDeleted }) excludes tombstoned rows by default and
 * returns them (state visible) when includeDeleted is true. get/head
 * on a tombstoned object answer NOT_FOUND. put() naming a tombstoned
 * object_id REVIVES it: a new version, state back to 'quarantined',
 * scan_state 'pending'.
 *   THE WIRE LAW (B5 route vs F1 backends, reconciled at merge): the
 *   worker's /api/storage route stores the SAME marker as the
 *   worker's /api/files trash — state='trashed', prev_state kept,
 *   restorable 30 days — because the two route sets share the files
 *   table and its trash/restore endpoints. The backends store
 *   state='deleted', retained, no sweep. A consumer MUST treat
 *   state 'deleted' OR 'trashed' (or deleted===true) as tombstoned;
 *   the engine (sync-r2.js isTombstoned) and the hub pull (sheet.js)
 *   already do. Post-revive state is store-defined ('quarantined'
 *   on backends, prev_state on the route); sync depends only on
 *   object_id / current_version / revived. A route tombstone swept
 *   after 30 days is ABSENT from lists; absence from the
 *   authoritative list is itself tombstoned, and a PUT naming the
 *   swept id answers 404, so the engine clears meta and re-mints.
 *   Renaming the wire was evaluated and rejected: it would fork the
 *   worker's two route sets into different vocabularies for the same
 *   row. The route is owner-only and honors no file_grants; shared
 *   reads stay on /api/files.
 */
const crypto = require('node:crypto');

class StorageError extends Error {
  constructor(code, message) { super(message); this.name = 'StorageError'; this.code = code; }
}
class NotVerifiedError extends StorageError {
  constructor(state) { super('NOT_VERIFIED', `write refused: account_state is '${state}', writes require 'verified'`); }
}
class NotFoundError extends StorageError {
  constructor(what) { super('NOT_FOUND', `not found: ${what}`); }
}
class ValidationError extends StorageError {
  constructor(msg) { super('VALIDATION', msg); }
}
class NotProvisionedError extends StorageError {
  constructor(msg) { super('NOT_PROVISIONED', msg); }
}

function requireCtx(ctx) {
  if (!ctx || typeof ctx.account_id !== 'string' || !ctx.account_id)
    throw new ValidationError('entitlement context { account_id, account_state } is required');
  if (typeof ctx.account_state !== 'string' || !ctx.account_state)
    throw new ValidationError('entitlement context must carry account_state');
}
function requireVerifiedWrite(ctx) {
  requireCtx(ctx);
  if (ctx.account_state !== 'verified') throw new NotVerifiedError(ctx.account_state);
}
function requireOwns(ctx, ownerAccountId, objectId) {
  if (ctx.account_id !== ownerAccountId) throw new NotFoundError(objectId);
}
/** F1/A2: a put naming an existing object must name the owning app too;
 *  a foreign app answers NOT_FOUND, never Forbidden (no existence leak). */
function requireSameApp(existing, appSlug, objectId) {
  if (existing.app_slug !== appSlug) throw new NotFoundError(objectId);
}
/** F1/A5: a version-allocation conflict is a retriable race, not a caller
 *  error — recognised by the store's duplicate-key wording (D1 PK,
 *  MemoryIndexStore PK emulation, or an explicit 'already exists'). */
function isVersionConflictError(e) {
  return !!e && /UNIQUE constraint|already exists|duplicate/i.test(String((e && e.message) || e));
}

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function newObjectId() { return crypto.randomUUID(); }

/** Minimal magic-byte sniffing: detected_mime (§2.3) is never the caller's word alone. */
function detectMime(buf) {
  if (!buf || buf.length === 0) return 'application/x-empty';
  const b = buf;
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
  if (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  let printable = true;
  const n = Math.min(b.length, 1024);
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0 || (c < 0x09) || (c > 0x0d && c < 0x20)) { printable = false; break; } }
  return printable ? 'text/plain' : 'application/octet-stream';
}

/** Accept Buffer | Uint8Array | ArrayBuffer | string | (async) iterable of chunks. */
async function toBuffer(data) {
  if (data == null) throw new ValidationError('put requires bytes or a stream');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (typeof data[Symbol.asyncIterator] === 'function' || typeof data[Symbol.iterator] === 'function' || typeof data.pipe === 'function') {
    const parts = [];
    for await (const part of data) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    return Buffer.concat(parts);
  }
  throw new ValidationError('unsupported data type for put: expected Buffer, Uint8Array, string, or stream');
}

function sanitizeDisplayName(name) {
  if (!name) return null;
  return String(name).replace(/[\\/]+/g, '_').replace(/[\x00-\x1f]/g, '').slice(0, 200) || null;
}

module.exports = {
  StorageError, NotVerifiedError, NotFoundError, ValidationError, NotProvisionedError,
  requireCtx, requireVerifiedWrite, requireOwns, requireSameApp, isVersionConflictError,
  sha256Hex, newObjectId, detectMime, toBuffer, sanitizeDisplayName,
};
