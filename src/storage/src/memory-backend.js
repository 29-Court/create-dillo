'use strict';
/**
 * MemoryBackend — in-memory fake implementing StoragePort with the same
 * chunked shape as D1BlobBackend (files index + ordinal chunks), so the
 * contract suite exercises identical semantics without Cloudflare.
 * Storage key convention mirrors D1: storage_key = object_id; a version's
 * chunk rows live under `${object_id}/v/<version_no>`.
 */
const {
  requireVerifiedWrite, requireCtx, requireOwns, requireSameApp,
  NotFoundError, ValidationError,
  sha256Hex, newObjectId, detectMime, toBuffer, sanitizeDisplayName,
} = require('./storage-port');

class MemoryBackend {
  constructor({ chunkSize = 256 * 1024 } = {}) {
    this.name = 'memory';
    this.chunkSize = chunkSize;
    this.files = new Map();    // object_id -> index row (§2.3 fields)
    this.versions = new Map(); // `${object_id}@${version_no}` -> version row
    this.blobs = new Map();    // version_object_id -> Map(ordinal -> Buffer)
  }

  _versionKey(objectId, versionNo) { return `${objectId}/v/${versionNo}`; }

  async put(ctx, accountId, appSlug, data, metadata = {}) {
    requireVerifiedWrite(ctx);
    if (ctx.account_id !== accountId) throw new ValidationError('ctx account does not match put account');
    if (!appSlug) throw new ValidationError('app slug is required');
    const bytes = await toBuffer(data);
    const now = new Date().toISOString();
    let objectId = metadata.object_id || null;
    let existing = objectId ? this.files.get(objectId) : null;
    if (objectId && !existing) throw new NotFoundError(objectId);
    if (existing) {
      requireOwns(ctx, existing.account_id, objectId);
      // F1/A2: same account, different app is a hijack — NOT_FOUND, no leak.
      requireSameApp(existing, appSlug, objectId);
      // A tombstoned row is still an existing object: put() revives it
      // (new version, state back to quarantined — see row below).
    } else objectId = newObjectId();
    // F1/A5: same reserve-then-write shape as R2/D1 — auto version
    // re-reads the max and retries on conflict (bounded). Map writes
    // here are synchronous past toBuffer, so the loop is a guard rail,
    // not the live path; the contract test still proves the outcome.
    const autoVersion = metadata.version_no == null;
    const MAX_ATTEMPTS = 5;
    const sha = sha256Hex(bytes);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let versionNo;
      if (existing) {
        const prior = [...this.versions.values()].filter(v => v.object_id === objectId);
        versionNo = autoVersion ? (prior.length ? Math.max(...prior.map(v => v.version_no)) + 1 : 1) : metadata.version_no;
      } else versionNo = metadata.version_no || 1;
      if (this.versions.has(`${objectId}@${versionNo}`)) {
        if (!autoVersion) throw new ValidationError(`version ${versionNo} of ${objectId} already exists`);
        continue; // someone else took this slot; re-read max and retry
      }
      const versionObjectId = versionNo === 1 ? objectId : this._versionKey(objectId, versionNo);
      const chunks = new Map();
      for (let off = 0, ord = 0; off < bytes.length || (bytes.length === 0 && ord === 0); off += this.chunkSize, ord++)
        chunks.set(ord, bytes.subarray(off, off + this.chunkSize));
      if (bytes.length === 0) chunks.set(0, Buffer.alloc(0));
      this.blobs.set(versionObjectId, chunks);
      this.versions.set(`${objectId}@${versionNo}`, {
        object_id: objectId, version_no: versionNo, version_object_id: versionObjectId,
        storage_backend: 'memory', storage_key: versionObjectId, size_bytes: bytes.length, sha256: sha, created_at: now,
      });
      const row = {
        object_id: objectId, account_id: accountId, app_slug: appSlug,
        storage_backend: 'memory', storage_key: objectId,
        display_name: sanitizeDisplayName(metadata.display_name) || (existing && existing.display_name) || null,
        declared_mime: metadata.declared_mime || (existing && existing.declared_mime) || null,
        detected_mime: detectMime(bytes),
        size_bytes: bytes.length, sha256: sha,
        // F1/A3: caller-supplied state/scan_state is IGNORED, never honored.
        state: 'quarantined', scan_state: 'pending',
        created_at: existing ? existing.created_at : now, updated_at: now,
        version_no: versionNo,
      };
      this.files.set(objectId, row);
      return { ...row };
    }
    throw new ValidationError(`could not allocate a version for ${objectId} after ${MAX_ATTEMPTS} attempts`);
  }

  async _resolve(ctx, objectId, version) {
    requireCtx(ctx);
    const row = this.files.get(objectId);
    if (!row) throw new NotFoundError(objectId);
    // F1 tombstone: a deleted object reads as not-found, never as deleted.
    if (row.state === 'deleted') throw new NotFoundError(objectId);
    requireOwns(ctx, row.account_id, objectId);
    const vNo = version || row.version_no;
    const v = this.versions.get(`${objectId}@${vNo}`);
    if (!v) throw new NotFoundError(`${objectId} v/${vNo}`);
    return { row, v };
  }

  async head(ctx, objectId, opts = {}) {
    const { row, v } = await this._resolve(ctx, objectId, opts.version);
    return { ...row, version_no: v.version_no, size_bytes: v.size_bytes, sha256: v.sha256, version_object_id: v.version_object_id };
  }

  async get(ctx, objectId, opts = {}) {
    const head = await this.head(ctx, objectId, opts);
    const chunks = this.blobs.get(head.version_object_id);
    if (!chunks) throw new NotFoundError(objectId);
    const bytes = Buffer.concat([...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf));
    return { head, bytes };
  }

  async listByAccount(ctx, accountId, opts = {}) {
    requireCtx(ctx);
    if (ctx.account_id !== accountId) throw new NotFoundError(accountId);
    // F1 tombstone: state='deleted' rows are hidden by default and
    // returned (with their state visible) only with includeDeleted:true.
    return [...this.files.values()]
      .filter(r => r.account_id === accountId && (opts.includeDeleted || r.state !== 'deleted'))
      .map(r => ({ ...r }));
  }

  async deleteObject(ctx, objectId, opts = {}) {
    requireVerifiedWrite(ctx);
    const row = this.files.get(objectId);
    if (!row) throw new NotFoundError(objectId);
    requireOwns(ctx, row.account_id, objectId);
    if (opts.tombstone) {
      // F1 tombstone: bytes gone, index row + version metadata retained
      // with state='deleted'.
      let blobsDeleted = 0;
      for (const v of [...this.versions.values()]) {
        if (v.object_id !== objectId) continue;
        const chunks = this.blobs.get(v.version_object_id);
        blobsDeleted += chunks ? chunks.size : 0;
        this.blobs.delete(v.version_object_id);
      }
      this.files.set(objectId, { ...row, state: 'deleted', updated_at: new Date().toISOString() });
      return { object_id: objectId, blobs_deleted: blobsDeleted, versions_deleted: 0, tombstoned: true };
    }
    let blobsDeleted = 0, versionsDeleted = 0;
    for (const [key, v] of [...this.versions.entries()]) {
      if (v.object_id !== objectId) continue;
      const chunks = this.blobs.get(v.version_object_id);
      blobsDeleted += chunks ? chunks.size : 0;
      this.blobs.delete(v.version_object_id);
      this.versions.delete(key);
      versionsDeleted++;
    }
    this.files.delete(objectId);
    return { object_id: objectId, blobs_deleted: blobsDeleted, versions_deleted: versionsDeleted };
  }

  async deleteAccountScope(ctx, accountId) {
    requireVerifiedWrite(ctx);
    if (ctx.account_id !== accountId) throw new NotFoundError(accountId);
    let objects = 0, blobs = 0;
    for (const row of [...this.files.values()]) {
      if (row.account_id !== accountId) continue;
      const res = await this.deleteObject(ctx, row.object_id);
      objects++; blobs += res.blobs_deleted;
    }
    return { account_id: accountId, objects_deleted: objects, blobs_deleted: blobs };
  }

  async mintReadUrl(ctx, objectId, ttlSeconds = 300) {
    const head = await this.head(ctx, objectId);
    return {
      kind: 'platform-route', backend: 'memory', signed: false,
      url: `/api/storage/objects/${objectId}`,
      object_id: objectId, version_no: head.version_no,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      note: 'No public URL exists on this backend. Reads resolve through the platform worker, which checks the ledger and grants before serving bytes (PASS-3 §2.3/§4). This descriptor is that route, not a signed URL.',
    };
  }

  // test introspection (not part of StoragePort)
  _blobRowCount(objectId) {
    let n = 0;
    for (const [key, v] of this.versions.entries())
      if (v.object_id === objectId) { const c = this.blobs.get(v.version_object_id); n += c ? c.size : 0; }
    return n;
  }
}
module.exports = { MemoryBackend };
