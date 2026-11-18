'use strict';
/**
 * D1BlobBackend — StoragePort on Cloudflare D1 (PASS-3 §2.4).
 * Database: `29court-platform-dev` (scratch, created for this workstream;
 * production `twentyninecourt` is never touched by this code).
 *
 * Tables (§2.3 index, identical for both backends):
 *   files         — the file index; storage_key = object_id on this backend (§2.4)
 *   file_versions — one row per immutable version, pointing at its chunk set
 *   blobs         — (object_id, ordinal, chunk) chunked BLOB rows; here
 *                   blobs.object_id is the version's storage id: the
 *                   object_id itself for v/1, `${object_id}/v/<n>` after,
 *                   mirroring the §2.3 R2 key layout's v/<version_no> tail.
 * Chunking exists so file size is not hostage to a single-row BLOB limit:
 * a single D1 query carries ONE chunk (default 512 KiB).
 */
const {
  requireVerifiedWrite, requireCtx, requireOwns, requireSameApp, isVersionConflictError,
  NotFoundError, ValidationError,
  sha256Hex, newObjectId, detectMime, toBuffer, sanitizeDisplayName,
} = require('./storage-port');
const { D1Client } = require('./d1-client');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
     object_id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     app_slug TEXT NOT NULL,
     storage_backend TEXT NOT NULL,
     storage_key TEXT NOT NULL,
     display_name TEXT,
     declared_mime TEXT,
     detected_mime TEXT,
     size_bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     state TEXT NOT NULL,
     scan_state TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_files_account ON files (account_id)`,
  `CREATE TABLE IF NOT EXISTS file_versions (
     object_id TEXT NOT NULL,
     version_no INTEGER NOT NULL,
     version_object_id TEXT NOT NULL UNIQUE,
     storage_backend TEXT NOT NULL,
     storage_key TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (object_id, version_no)
   )`,
  `CREATE TABLE IF NOT EXISTS blobs (
     object_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     chunk BLOB NOT NULL,
     PRIMARY KEY (object_id, ordinal)
   )`,
];

class D1BlobBackend {
  constructor({ client = new D1Client(), chunkSize = 512 * 1024 } = {}) {
    this.name = 'd1';
    this.client = client;
    this.chunkSize = chunkSize;
    this._schemaReady = null;
  }
  close() { this.client.close(); }

  async ensureSchema() {
    if (!this._schemaReady) {
      this._schemaReady = (async () => { for (const sql of SCHEMA) await this.client.exec(sql); })();
    }
    return this._schemaReady;
  }

  _versionKey(objectId, versionNo) { return versionNo === 1 ? objectId : `${objectId}/v/${versionNo}`; }

  /**
   * F1/A4: remove ONLY this call's failed version — its blob rows and its
   * version row — never v1 or any prior version. Safe to call only when
   * this call's version-row insert succeeded (inserted=true): the
   * version-row insert is the allocation gate, so no other put can hold
   * the same (object_id, version_no) or versionObjectId, and every blob
   * row under it is ours. On a version-insert conflict there is nothing
   * to clean (we wrote nothing) and this must NOT run — the existing
   * row/blobs belong to the winner.
   */
  async _cleanupFailedVersion(objectId, versionNo, versionObjectId) {
    await this.client.exec('DELETE FROM blobs WHERE object_id = ?', [versionObjectId]);
    await this.client.exec('DELETE FROM file_versions WHERE object_id = ? AND version_no = ?', [objectId, versionNo]);
  }

  async put(ctx, accountId, appSlug, data, metadata = {}) {
    requireVerifiedWrite(ctx);
    if (ctx.account_id !== accountId) throw new ValidationError('ctx account does not match put account');
    if (!appSlug) throw new ValidationError('app slug is required');
    await this.ensureSchema();
    const bytes = await toBuffer(data);
    const now = new Date().toISOString();
    let objectId = metadata.object_id || null;
    let existing = null;
    if (objectId) {
      const rows = await this.client.query('SELECT * FROM files WHERE object_id = ?', [objectId]);
      existing = rows[0] || null;
      if (!existing) throw new NotFoundError(objectId);
      requireOwns(ctx, existing.account_id, objectId);
      // F1/A2: same account, different app is a hijack — NOT_FOUND, no leak.
      requireSameApp(existing, appSlug, objectId);
      // A tombstoned row is still an existing object: put() revives it
      // (new version, state back to quarantined — see row below).
    } else objectId = newObjectId();

    // F1/A5: reserve-then-write with bounded retry, same shape as R2.
    // The version row is inserted BEFORE the chunk rows, so two racers
    // can never interleave chunks under one version_object_id; the loser
    // sees the file_versions PK conflict, re-reads maxVersion, and takes
    // the next slot. A pinned version_no that exists is a caller error.
    // Reader note: between the version-row insert and the chunk inserts
    // a concurrent get sees the version row with zero chunks — F3 made
    // that throw NOT_FOUND (see get()), never return empty bytes, so
    // the window is a transient NOT_FOUND, not a silent empty read.
    // No transaction API exists on D1Client.
    const autoVersion = metadata.version_no == null;
    const MAX_ATTEMPTS = 5;
    const sha = sha256Hex(bytes);
    let lastConflict = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let versionNo;
      if (existing) {
        const rows = await this.client.query('SELECT COALESCE(MAX(version_no),0) AS mx FROM file_versions WHERE object_id = ?', [objectId]);
        versionNo = autoVersion ? (rows[0].mx + 1) : metadata.version_no;
      } else versionNo = metadata.version_no || 1;
      const dup = await this.client.query('SELECT version_no FROM file_versions WHERE object_id = ? AND version_no = ?', [objectId, versionNo]);
      if (dup.length) {
        if (!autoVersion) throw new ValidationError(`version ${versionNo} of ${objectId} already exists`);
        continue; // someone else took this slot; re-read max and retry
      }
      const versionObjectId = this._versionKey(objectId, versionNo);
      let inserted = false;
      try {
        await this.client.exec(
          'INSERT INTO file_versions (object_id, version_no, version_object_id, storage_backend, storage_key, size_bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)',
          [objectId, versionNo, versionObjectId, 'd1', versionObjectId, bytes.length, sha, now]);
        inserted = true;
      } catch (e) {
        // Nothing of ours was written: just retry or throw.
        if (autoVersion && isVersionConflictError(e)) { lastConflict = e; continue; }
        throw e;
      }
      try {
        // An empty file stores zero chunk rows (an empty int-array param
        // would not survive the D1 API as a BLOB); get() of zero rows is
        // the empty file.
        const chunkCount = bytes.length === 0 ? 0 : Math.ceil(bytes.length / this.chunkSize);
        const inserts = [];
        for (let ord = 0; ord < chunkCount; ord++) {
          const chunk = bytes.subarray(ord * this.chunkSize, (ord + 1) * this.chunkSize);
          inserts.push(this.client.exec('INSERT INTO blobs (object_id, ordinal, chunk) VALUES (?,?,?)', [versionObjectId, ord, chunk]));
        }
        await Promise.all(inserts);
      } catch (e) {
        await this._cleanupFailedVersion(objectId, versionNo, versionObjectId).catch(() => {});
        throw e;
      }
      const row = {
        object_id: objectId, account_id: accountId, app_slug: appSlug,
        storage_backend: 'd1', storage_key: objectId,
        display_name: sanitizeDisplayName(metadata.display_name) || (existing && existing.display_name) || null,
        declared_mime: metadata.declared_mime || (existing && existing.declared_mime) || null,
        detected_mime: detectMime(bytes), size_bytes: bytes.length, sha256: sha,
        // F1/A3: caller-supplied state/scan_state is IGNORED, never honored.
        state: 'quarantined', scan_state: 'pending',
        created_at: existing ? existing.created_at : now, updated_at: now, version_no: versionNo,
      };
      try {
        await this.client.exec(
          `INSERT INTO files (object_id, account_id, app_slug, storage_backend, storage_key, display_name, declared_mime, detected_mime, size_bytes, sha256, state, scan_state, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(object_id) DO UPDATE SET display_name=excluded.display_name, declared_mime=excluded.declared_mime, detected_mime=excluded.detected_mime, size_bytes=excluded.size_bytes, sha256=excluded.sha256, state=excluded.state, scan_state=excluded.scan_state, updated_at=excluded.updated_at`,
          [row.object_id, row.account_id, row.app_slug, row.storage_backend, row.storage_key, row.display_name, row.declared_mime, row.detected_mime, row.size_bytes, row.sha256, row.state, row.scan_state, row.created_at, row.updated_at]);
      } catch (e) {
        await this._cleanupFailedVersion(objectId, versionNo, versionObjectId).catch(() => {});
        throw e;
      }
      return { ...row };
    }
    throw new ValidationError(`could not allocate a version for ${objectId} after ${MAX_ATTEMPTS} attempts${lastConflict ? `: last conflict: ${lastConflict.message}` : ''}`);
  }

  async _resolve(ctx, objectId, version) {
    requireCtx(ctx);
    await this.ensureSchema();
    const rows = await this.client.query('SELECT * FROM files WHERE object_id = ?', [objectId]);
    const row = rows[0];
    if (!row) throw new NotFoundError(objectId);
    // F1 tombstone: a deleted object reads as not-found, never as deleted.
    if (row.state === 'deleted') throw new NotFoundError(objectId);
    requireOwns(ctx, row.account_id, objectId);
    let vRows;
    if (version) vRows = await this.client.query('SELECT * FROM file_versions WHERE object_id = ? AND version_no = ?', [objectId, version]);
    else vRows = await this.client.query('SELECT * FROM file_versions WHERE object_id = ? ORDER BY version_no DESC LIMIT 1', [objectId]);
    const v = vRows[0];
    if (!v) throw new NotFoundError(`${objectId} v/${version || 'latest'}`);
    return { row, v };
  }

  async head(ctx, objectId, opts = {}) {
    const { row, v } = await this._resolve(ctx, objectId, opts.version);
    return { ...row, version_no: v.version_no, size_bytes: v.size_bytes, sha256: v.sha256, version_object_id: v.version_object_id };
  }

  async get(ctx, objectId, opts = {}) {
    const head = await this.head(ctx, objectId, opts);
    const rows = await this.client.query('SELECT ordinal, hex(chunk) AS hx FROM blobs WHERE object_id = ? ORDER BY ordinal ASC', [head.version_object_id]);
    // F3 (Notebook Everywhere): a version row whose chunk rows are
    // absent is NOT_FOUND, never empty bytes — mirroring R2Backend.get
    // (`bytes === null` → NOT_FOUND) and MemoryBackend.get
    // (`!chunks` → NOT_FOUND). A tombstone deletes the old versions'
    // blob rows but retains their version rows, so without this check
    // a pre-tombstone version read back as 0 bytes after revive. The
    // size_bytes guard keeps a genuinely empty file (zero chunk rows
    // by design, size 0) readable. This also closes the transient
    // window F1 documented at put(): a concurrent get between the
    // version-row insert and the chunk inserts now throws NOT_FOUND
    // instead of returning empty bytes.
    if (rows.length === 0 && head.size_bytes > 0) {
      throw new NotFoundError(`${objectId} bytes missing at ${head.version_object_id}`);
    }
    const bytes = Buffer.concat(rows.map(r => Buffer.from(r.hx || '', 'hex')));
    return { head, bytes };
  }

  async listByAccount(ctx, accountId, opts = {}) {
    requireCtx(ctx);
    if (ctx.account_id !== accountId) throw new NotFoundError(accountId);
    await this.ensureSchema();
    const rows = await this.client.query('SELECT * FROM files WHERE account_id = ? ORDER BY created_at ASC', [accountId]);
    // F1 tombstone: state='deleted' rows are hidden by default and
    // returned (with their state visible) only with includeDeleted:true.
    const visible = opts.includeDeleted ? rows : rows.filter((r) => r.state !== 'deleted');
    // attach current version number
    for (const row of visible) {
      const v = await this.client.query('SELECT COALESCE(MAX(version_no),0) AS mx FROM file_versions WHERE object_id = ?', [row.object_id]);
      row.version_no = v[0].mx;
    }
    return visible;
  }

  async deleteObject(ctx, objectId, opts = {}) {
    requireVerifiedWrite(ctx);
    await this.ensureSchema();
    const rows = await this.client.query('SELECT * FROM files WHERE object_id = ?', [objectId]);
    const row = rows[0];
    if (!row) throw new NotFoundError(objectId);
    requireOwns(ctx, row.account_id, objectId);
    const countRows = await this.client.query(
      'SELECT COUNT(*) AS n FROM blobs WHERE object_id IN (SELECT version_object_id FROM file_versions WHERE object_id = ?)', [objectId]);
    const vRows = await this.client.query('SELECT COUNT(*) AS n FROM file_versions WHERE object_id = ?', [objectId]);
    if (opts.tombstone) {
      // F1 tombstone: bytes gone, index row + version metadata retained
      // with state='deleted'. No schema change: 'deleted' is a plain
      // TEXT value in the existing files.state column.
      await this.client.exec('DELETE FROM blobs WHERE object_id IN (SELECT version_object_id FROM file_versions WHERE object_id = ?)', [objectId]);
      await this.client.exec('UPDATE files SET state = ?, updated_at = ? WHERE object_id = ?', ['deleted', new Date().toISOString(), objectId]);
      return { object_id: objectId, blobs_deleted: countRows[0].n, versions_deleted: 0, tombstoned: true };
    }
    await this.client.exec('DELETE FROM blobs WHERE object_id IN (SELECT version_object_id FROM file_versions WHERE object_id = ?)', [objectId]);
    await this.client.exec('DELETE FROM file_versions WHERE object_id = ?', [objectId]);
    await this.client.exec('DELETE FROM files WHERE object_id = ?', [objectId]);
    return { object_id: objectId, blobs_deleted: countRows[0].n, versions_deleted: vRows[0].n };
  }

  async deleteAccountScope(ctx, accountId) {
    requireVerifiedWrite(ctx);
    if (ctx.account_id !== accountId) throw new NotFoundError(accountId);
    await this.ensureSchema();
    const objs = await this.client.query('SELECT object_id FROM files WHERE account_id = ?', [accountId]);
    const blobCount = await this.client.query(
      `SELECT COUNT(*) AS n FROM blobs WHERE object_id IN (
         SELECT version_object_id FROM file_versions WHERE object_id IN (SELECT object_id FROM files WHERE account_id = ?))`, [accountId]);
    await this.client.exec(
      `DELETE FROM blobs WHERE object_id IN (
         SELECT version_object_id FROM file_versions WHERE object_id IN (SELECT object_id FROM files WHERE account_id = ?))`, [accountId]);
    await this.client.exec('DELETE FROM file_versions WHERE object_id IN (SELECT object_id FROM files WHERE account_id = ?)', [accountId]);
    await this.client.exec('DELETE FROM files WHERE account_id = ?', [accountId]);
    return { account_id: accountId, objects_deleted: objs.length, blobs_deleted: blobCount[0].n };
  }

  async mintReadUrl(ctx, objectId, ttlSeconds = 300) {
    const head = await this.head(ctx, objectId);
    return {
      kind: 'platform-route', backend: 'd1', signed: false,
      url: `/api/storage/objects/${objectId}`,
      object_id: objectId, version_no: head.version_no,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      note: 'D1 BLOB storage has no public or signed URL. Reads resolve through the platform worker, which checks the ledger and grants before serving bytes (PASS-3 §2.3/§4). This descriptor is that route, not a signed URL; expires_at is the worker session window the route should honor.',
    };
  }

  // test introspection (not part of StoragePort)
  async _blobRowCount(objectId) {
    await this.ensureSchema();
    const rows = await this.client.query(
      'SELECT COUNT(*) AS n FROM blobs WHERE object_id IN (SELECT version_object_id FROM file_versions WHERE object_id = ?) OR object_id = ?',
      [objectId, objectId]);
    // note: after deleteObject the version rows are gone, so also count raw key + /v/ keys directly
    const raw = await this.client.query("SELECT COUNT(*) AS n FROM blobs WHERE object_id = ? OR object_id LIKE ?", [objectId, `${objectId}/v/%`]);
    return Math.max(rows[0].n, raw[0].n);
  }
  async _indexRowExists(objectId) {
    const rows = await this.client.query('SELECT COUNT(*) AS n FROM files WHERE object_id = ?', [objectId]);
    return rows[0].n > 0;
  }
}
module.exports = { D1BlobBackend, SCHEMA };
