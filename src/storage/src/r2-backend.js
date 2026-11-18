'use strict';
/**
 * R2Backend — StoragePort on Cloudflare R2 (PASS-3 §2.3/§2.4).
 *
 * BYTES live in R2; the INDEX lives in D1. The `files` + `file_versions`
 * rows are the same §2.3 index D1BlobBackend writes (same DDL, same
 * columns), only the blob bytes move: each immutable version is ONE R2
 * object, never chunks, at the §2.3 key
 *
 *   v1/acct/<account_id>/app/<app_slug>/obj/<object_id>/v/<version_no>/<file>
 *
 * in bucket `29court-app-files`. `files.storage_key` points at the
 * latest version's key; each `file_versions` row points at its own key
 * (its `version_object_id` IS that key). New uploads land
 * state='quarantined', scan_state='pending', exactly as on D1.
 *
 * TWO transports, selected by constructor config:
 *   (a) Worker R2Bucket binding (production): { binding, bucket }
 *   (b) S3-compatible HTTP (local dev + tests): { endpoint, bucket,
 *       accessKeyId, secretAccessKey, region } — SigV4 signed, path-style
 *       addressing, Node stdlib only (node:crypto + global fetch).
 * With neither, the backend constructs but every method throws
 * NotProvisioned (AT-1: the fleet token has no R2 permission) so a
 * mis-set PLATFORM_STORAGE_BACKEND=r2 still fails loudly.
 *
 * The index is pluggable for the same reason: production uses
 * D1IndexStore (the D1 HTTP client, same SQL as D1BlobBackend); the
 * contract suite runs the R2 leg offline against MemoryIndexStore +
 * the test fake-S3 server. The D1 index is the real one — the memory
 * index is test-only scaffolding with identical semantics.
 *
 * blobs_deleted semantics differ from D1/memory by storage shape, and
 * honestly so: D1/memory count chunk rows; R2 counts R2 objects
 * (one per version). The contract suite asserts the per-backend form.
 */
const crypto = require('node:crypto');
const {
  requireVerifiedWrite, requireCtx, requireOwns, requireSameApp, isVersionConflictError,
  NotFoundError, ValidationError,
  NotProvisionedError, sha256Hex, newObjectId, detectMime, toBuffer, sanitizeDisplayName,
} = require('./storage-port');
const { D1Client } = require('./d1-client');
const { SCHEMA: D1_SCHEMA } = require('./d1-backend');

const R2_BUCKET = '29court-app-files';
const WHY_UNPROVISIONED =
  'R2 is not provisioned: the fleet token has no R2 permission (AT-1, HTTP 403 code 10000 on the R2 management plane) and no bucket exists. ' +
  'Use PLATFORM_STORAGE_BACKEND=d1, or construct R2Backend with a Worker R2Bucket binding / S3 endpoint config.';

/** The §2.3 key. <file> is the sanitized display name, falling back to 'file'. */
function buildR2Key(accountId, appSlug, objectId, versionNo, fileName) {
  const file = (fileName || 'file').replace(/\s+/g, '_') || 'file';
  return `v1/acct/${accountId}/app/${appSlug}/obj/${objectId}/v/${versionNo}/${file}`;
}

/* ------------------------------------------------------------------ */
/* Index stores: same files + file_versions shape, two implementations */
/* ------------------------------------------------------------------ */

// files + file_versions DDL only (no blobs table: R2 holds the bytes).
const INDEX_SCHEMA = D1_SCHEMA.slice(0, 3);

class D1IndexStore {
  constructor({ client = null } = {}) {
    this._client = client; // lazy: constructing a D1Client spawns bridge processes
    this._schemaReady = null;
  }
  _getClient() { if (!this._client) this._client = new D1Client(); return this._client; }
  close() { if (this._client) this._client.close(); }
  async ensureSchema() {
    if (!this._schemaReady) {
      this._schemaReady = (async () => { for (const sql of INDEX_SCHEMA) await this._getClient().exec(sql); })();
    }
    return this._schemaReady;
  }
  async getFile(objectId) {
    const rows = await this._getClient().query('SELECT * FROM files WHERE object_id = ?', [objectId]);
    return rows[0] || null;
  }
  async upsertFile(row) {
    await this._getClient().exec(
      `INSERT INTO files (object_id, account_id, app_slug, storage_backend, storage_key, display_name, declared_mime, detected_mime, size_bytes, sha256, state, scan_state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(object_id) DO UPDATE SET display_name=excluded.display_name, declared_mime=excluded.declared_mime, detected_mime=excluded.detected_mime, size_bytes=excluded.size_bytes, sha256=excluded.sha256, state=excluded.state, scan_state=excluded.scan_state, updated_at=excluded.updated_at`,
      [row.object_id, row.account_id, row.app_slug, row.storage_backend, row.storage_key, row.display_name, row.declared_mime, row.detected_mime, row.size_bytes, row.sha256, row.state, row.scan_state, row.created_at, row.updated_at]);
  }
  async getVersion(objectId, versionNo) {
    const rows = await this._getClient().query(
      'SELECT * FROM file_versions WHERE object_id = ? AND version_no = ?', [objectId, versionNo]);
    return rows[0] || null;
  }
  async getLatestVersion(objectId) {
    const rows = await this._getClient().query(
      'SELECT * FROM file_versions WHERE object_id = ? ORDER BY version_no DESC LIMIT 1', [objectId]);
    return rows[0] || null;
  }
  async insertVersion(v) {
    await this._getClient().exec(
      'INSERT INTO file_versions (object_id, version_no, version_object_id, storage_backend, storage_key, size_bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [v.object_id, v.version_no, v.version_object_id, v.storage_backend, v.storage_key, v.size_bytes, v.sha256, v.created_at]);
  }
  /** F1/A4: remove ONE version row only — never deleteVersions (all). */
  async deleteVersion(objectId, versionNo) {
    await this._getClient().exec(
      'DELETE FROM file_versions WHERE object_id = ? AND version_no = ?', [objectId, versionNo]);
  }
  async maxVersion(objectId) {
    const rows = await this._getClient().query(
      'SELECT COALESCE(MAX(version_no),0) AS mx FROM file_versions WHERE object_id = ?', [objectId]);
    return rows[0].mx;
  }
  async listVersions(objectId) {
    return this._getClient().query(
      'SELECT * FROM file_versions WHERE object_id = ? ORDER BY version_no ASC', [objectId]);
  }
  async listFilesByAccount(accountId) {
    return this._getClient().query(
      'SELECT * FROM files WHERE account_id = ? ORDER BY created_at ASC', [accountId]);
  }
  async deleteVersions(objectId) {
    await this._getClient().exec('DELETE FROM file_versions WHERE object_id = ?', [objectId]);
  }
  async deleteFile(objectId) {
    await this._getClient().exec('DELETE FROM files WHERE object_id = ?', [objectId]);
  }
  async fileExists(objectId) {
    const rows = await this._getClient().query('SELECT COUNT(*) AS n FROM files WHERE object_id = ?', [objectId]);
    return rows[0].n > 0;
  }
}

/** In-memory index with identical semantics — test-only (offline R2 leg). */
class MemoryIndexStore {
  constructor() { this.files = new Map(); this.versions = new Map(); }
  close() {}
  async ensureSchema() {}
  async getFile(objectId) { const r = this.files.get(objectId); return r ? { ...r } : null; }
  async upsertFile(row) { this.files.set(row.object_id, { ...row }); }
  async getVersion(objectId, versionNo) {
    const v = this.versions.get(`${objectId}@${versionNo}`); return v ? { ...v } : null;
  }
  async getLatestVersion(objectId) {
    const vs = [...this.versions.values()].filter(v => v.object_id === objectId);
    if (!vs.length) return null;
    return { ...vs.reduce((a, b) => (b.version_no > a.version_no ? b : a)) };
  }
  async insertVersion(v) {
    // F1/A5: the memory index emulates the real file_versions PK
    // (object_id, version_no) — a duplicate insert must FAIL like D1,
    // or the retry loop below can never see the conflict it retries on.
    const k = `${v.object_id}@${v.version_no}`;
    if (this.versions.has(k)) throw new Error(`UNIQUE constraint failed: file_versions.object_id, file_versions.version_no (object ${v.object_id} version ${v.version_no} already exists)`);
    this.versions.set(k, { ...v });
  }
  /** F1/A4: remove ONE version row only — never deleteVersions (all). */
  async deleteVersion(objectId, versionNo) { this.versions.delete(`${objectId}@${versionNo}`); }
  async maxVersion(objectId) {
    const vs = [...this.versions.values()].filter(v => v.object_id === objectId);
    return vs.length ? Math.max(...vs.map(v => v.version_no)) : 0;
  }
  async listVersions(objectId) {
    return [...this.versions.values()].filter(v => v.object_id === objectId)
      .sort((a, b) => a.version_no - b.version_no).map(v => ({ ...v }));
  }
  async listFilesByAccount(accountId) {
    return [...this.files.values()].filter(r => r.account_id === accountId).map(r => ({ ...r }));
  }
  async deleteVersions(objectId) {
    for (const k of [...this.versions.keys()]) if (k.startsWith(`${objectId}@`)) this.versions.delete(k);
  }
  async deleteFile(objectId) { this.files.delete(objectId); }
  async fileExists(objectId) { return this.files.has(objectId); }
}

/* ------------------------------------------------------------------ */
/* Transports: one object-store surface, two implementations            */
/* ------------------------------------------------------------------ */

class R2BindingTransport {
  constructor(binding, bucket) { this.binding = binding; this.bucket = bucket; }
  async putObject(key, bytes, contentType) {
    await this.binding.put(key, bytes, contentType ? { httpMetadata: { contentType } } : undefined);
  }
  async getObject(key) {
    const obj = await this.binding.get(key);
    if (!obj) return null;
    return Buffer.from(await obj.arrayBuffer());
  }
  async headObject(key) {
    const obj = await this.binding.head(key);
    if (!obj) return null;
    return { size: obj.size, etag: obj.etag, uploaded: obj.uploaded };
  }
  async deleteObjects(keys) {
    if (!keys.length) return;
    // R2Bucket.delete accepts a key or an array of keys.
    await this.binding.delete(keys.length === 1 ? keys[0] : keys);
  }
  async listObjects(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await this.binding.list({ prefix, cursor });
      for (const o of page.objects) out.push(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
}

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256HexStr(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

/** F1/A1b+A1c: SigV4 requires RFC 3986 segment encoding. encodeURIComponent
 *  leaves `(` `)` `'` `*` `!` raw; S3 signs the pct-encoded form, so a key
 *  containing any of them signed the wrong canonical URI (403
 *  SignatureDoesNotMatch). Applied to keys AND query params, consistently. */
function rfc3986Encode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

class S3HttpTransport {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
  }
  _encodeKey(key) { return key.split('/').map(s => rfc3986Encode(s)).join('/'); }

  async _request(method, key, { query = {}, body = null, contentType = null } = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256HexStr(body || '');
    const host = new URL(this.endpoint).host;
    const canonicalUri = key == null ? `/${this.bucket}` : `/${this.bucket}/${this._encodeKey(key)}`;
    const queryEntries = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQuery = queryEntries.map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`).join('&');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexStr(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign).toString('hex');
    const url = `${this.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    const headers = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers, body });
    return res;
  }

  async putObject(key, bytes, contentType) {
    const res = await this._request('PUT', key, { body: bytes, contentType: contentType || 'application/octet-stream' });
    if (!res.ok) throw new Error(`R2 S3 PutObject ${key} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 500));
  }
  async getObject(key) {
    const res = await this._request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 S3 GetObject ${key} failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async headObject(key) {
    const res = await this._request('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 S3 HeadObject ${key} failed: HTTP ${res.status}`);
    return { size: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag') };
  }
  async deleteObjects(keys) {
    for (const key of keys) {
      const res = await this._request('DELETE', key);
      if (!res.ok && res.status !== 404) throw new Error(`R2 S3 DeleteObject ${key} failed: HTTP ${res.status}`);
    }
  }
  async listObjects(prefix) {
    const out = [];
    let token;
    for (let page = 0; page < 100; page++) {
      const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const res = await this._request('GET', null, { query });
      if (!res.ok) throw new Error(`R2 S3 ListObjectsV2 prefix=${prefix} failed: HTTP ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>(.*?)<\/Key>/gs)) {
        out.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated) break;
      const next = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/s);
      if (!next) break;
      token = next[1];
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* R2Backend                                                          */
/* ------------------------------------------------------------------ */

class R2Backend {
  /**
   * @param {object} opts
   * @param {object} [opts.binding] Worker R2Bucket binding (production transport)
   * @param {string} [opts.endpoint] S3-compatible endpoint (dev/test transport)
   * @param {string} [opts.bucket] default '29court-app-files' (§2.3)
   * @param {string} [opts.accessKeyId] S3 access key (env/binding only, never a literal)
   * @param {string} [opts.secretAccessKey] S3 secret key (env/binding only, never a literal)
   * @param {string} [opts.region] default 'auto' (R2's S3 region)
   * @param {object} [opts.index] index store; default D1IndexStore (the D1 index)
   * @param {number} [opts.chunkSize] test-sizing knob; R2 stores one object per version, it does not chunk
   */
  constructor({ binding = null, endpoint = null, bucket = R2_BUCKET, accessKeyId = null, secretAccessKey = null, region = 'auto', index = null, chunkSize = 512 * 1024 } = {}) {
    this.name = 'r2';
    this.bucket = bucket;
    this.chunkSize = chunkSize;
    this.index = index || new D1IndexStore();
    this._schemaReady = null;
    if (binding) {
      this.transport = new R2BindingTransport(binding, bucket);
      this.transportKind = 'binding';
    } else if (endpoint) {
      if (!accessKeyId || !secretAccessKey) throw new ValidationError('R2 S3 transport requires accessKeyId and secretAccessKey (from env/binding, never a literal in code)');
      this.transport = new S3HttpTransport({ endpoint, bucket, accessKeyId, secretAccessKey, region });
      this.transportKind = 's3';
    } else {
      this.transport = null; // unprovisioned: every method throws NotProvisioned (AT-1)
      this.transportKind = 'none';
    }
  }
  close() { if (this.index && typeof this.index.close === 'function') this.index.close(); }

  _requireTransport() {
    if (!this.transport) throw new NotProvisionedError(WHY_UNPROVISIONED);
  }
  async ensureSchema() {
    if (!this._schemaReady) this._schemaReady = this.index.ensureSchema();
    return this._schemaReady;
  }
  _fileName(metadata, existing) {
    const name = sanitizeDisplayName(metadata.display_name) || (existing && existing.display_name) || 'file';
    return name.replace(/\s+/g, '_') || 'file';
  }

  /**
   * F1/A4: remove ONLY the failed version's rows/objects after a failed
   * put — never v1 or any prior version. `insertedByUs` is true only
   * when THIS call's insertVersion succeeded, so a loser in a version
   * race never deletes the winner's row. The bytes are removed only
   * when no surviving version row still references the key: two racers
   * can share one key (same version_no), and the loser's cleanup must
   * not destroy the winner's bytes.
   */
  async _cleanupFailedVersion(objectId, versionNo, key, insertedByUs) {
    if (insertedByUs && typeof this.index.deleteVersion === 'function') {
      await this.index.deleteVersion(objectId, versionNo).catch(() => {});
    }
    let refs = [];
    try { refs = await this.index.listVersions(objectId); } catch { /* index gone; still try the bytes */ }
    if (!refs.some((v) => v.version_object_id === key || v.storage_key === key)) {
      await this.transport.deleteObjects([key]).catch(() => {});
    }
  }

  async put(ctx, accountId, appSlug, data, metadata = {}) {
    requireVerifiedWrite(ctx);
    this._requireTransport();
    if (ctx.account_id !== accountId) throw new ValidationError('ctx account does not match put account');
    if (!appSlug) throw new ValidationError('app slug is required');
    await this.ensureSchema();
    const bytes = await toBuffer(data);
    const now = new Date().toISOString();
    let objectId = metadata.object_id || null;
    let existing = null;
    if (objectId) {
      existing = await this.index.getFile(objectId);
      if (!existing) throw new NotFoundError(objectId);
      requireOwns(ctx, existing.account_id, objectId);
      // F1/A2: same account, different app is a hijack — NOT_FOUND, no leak.
      requireSameApp(existing, appSlug, objectId);
      // A tombstoned row is still an existing object: put() revives it
      // (new version, state back to quarantined — see row below).
    } else objectId = newObjectId();

    // F1/A5: version allocation is reserve-then-write with bounded retry.
    // The version row is inserted BEFORE the bytes land, so two racers
    // can never share a key and overwrite each other's bytes; the loser
    // sees the PK conflict, re-reads maxVersion, and takes the next slot.
    // A pinned metadata.version_no that already exists is a caller error
    // and is never retried. MAX_ATTEMPTS bounds the loop.
    const autoVersion = metadata.version_no == null;
    const MAX_ATTEMPTS = 5;
    const sha = sha256Hex(bytes);
    const detected = detectMime(bytes);
    let lastConflict = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let versionNo;
      if (existing) {
        versionNo = autoVersion ? ((await this.index.maxVersion(objectId)) + 1) : metadata.version_no;
      } else versionNo = metadata.version_no || 1;
      if (await this.index.getVersion(objectId, versionNo)) {
        if (!autoVersion) throw new ValidationError(`version ${versionNo} of ${objectId} already exists`);
        continue; // someone else took this slot; re-read max and retry
      }
      const key = buildR2Key(accountId, appSlug, objectId, versionNo, this._fileName(metadata, existing));
      const versionRow = {
        object_id: objectId, version_no: versionNo, version_object_id: key,
        storage_backend: 'r2', storage_key: key, size_bytes: bytes.length, sha256: sha, created_at: now,
      };
      let inserted = false;
      try {
        await this.index.insertVersion(versionRow);
        inserted = true;
      } catch (e) {
        // Nothing of ours was written (no row, no bytes): just retry or throw.
        if (autoVersion && isVersionConflictError(e)) { lastConflict = e; continue; }
        throw e;
      }
      try {
        await this.transport.putObject(key, bytes, detected);
      } catch (e) {
        await this._cleanupFailedVersion(objectId, versionNo, key, inserted);
        throw e;
      }
      const row = {
        object_id: objectId, account_id: accountId, app_slug: appSlug,
        storage_backend: 'r2', storage_key: key,
        display_name: sanitizeDisplayName(metadata.display_name) || (existing && existing.display_name) || null,
        declared_mime: metadata.declared_mime || (existing && existing.declared_mime) || null,
        detected_mime: detected, size_bytes: bytes.length, sha256: sha,
        // F1/A3: caller-supplied state/scan_state is IGNORED, never honored.
        // Every new object/version lands quarantined/pending.
        state: 'quarantined', scan_state: 'pending',
        created_at: existing ? existing.created_at : now, updated_at: now, version_no: versionNo,
      };
      try {
        await this.index.upsertFile(row);
      } catch (e) {
        await this._cleanupFailedVersion(objectId, versionNo, key, inserted);
        throw e;
      }
      return { ...row };
    }
    throw new ValidationError(`could not allocate a version for ${objectId} after ${MAX_ATTEMPTS} attempts${lastConflict ? `: last conflict: ${lastConflict.message}` : ''}`);
  }

  async _resolve(ctx, objectId, version) {
    requireCtx(ctx);
    this._requireTransport();
    await this.ensureSchema();
    const row = await this.index.getFile(objectId);
    if (!row) throw new NotFoundError(objectId);
    // F1 tombstone: a deleted object reads as not-found, never as deleted.
    if (row.state === 'deleted') throw new NotFoundError(objectId);
    requireOwns(ctx, row.account_id, objectId);
    const v = version
      ? await this.index.getVersion(objectId, version)
      : await this.index.getLatestVersion(objectId);
    if (!v) throw new NotFoundError(`${objectId} v/${version || 'latest'}`);
    return { row, v };
  }

  async head(ctx, objectId, opts = {}) {
    const { row, v } = await this._resolve(ctx, objectId, opts.version);
    return { ...row, version_no: v.version_no, size_bytes: v.size_bytes, sha256: v.sha256, version_object_id: v.version_object_id };
  }

  async get(ctx, objectId, opts = {}) {
    const head = await this.head(ctx, objectId, opts);
    const bytes = await this.transport.getObject(head.version_object_id);
    if (bytes === null) throw new NotFoundError(`${objectId} bytes missing at ${head.version_object_id}`);
    return { head, bytes };
  }

  async listByAccount(ctx, accountId, opts = {}) {
    requireCtx(ctx);
    this._requireTransport();
    if (ctx.account_id !== accountId) throw new NotFoundError(accountId);
    await this.ensureSchema();
    const rows = await this.index.listFilesByAccount(accountId);
    // F1 tombstone: state='deleted' rows are hidden by default and
    // returned (with their state visible) only with includeDeleted:true.
    const visible = opts.includeDeleted ? rows : rows.filter((r) => r.state !== 'deleted');
    for (const row of visible) row.version_no = await this.index.maxVersion(row.object_id);
    return visible;
  }

  async deleteObject(ctx, objectId, opts = {}) {
    requireVerifiedWrite(ctx);
    this._requireTransport();
    await this.ensureSchema();
    const row = await this.index.getFile(objectId);
    if (!row) throw new NotFoundError(objectId);
    requireOwns(ctx, row.account_id, objectId);
    const versions = await this.index.listVersions(objectId);
    const keys = versions.map(v => v.storage_key);
    await this.transport.deleteObjects(keys);
    if (opts.tombstone) {
      // F1 tombstone: bytes gone, index row + version metadata retained
      // with state='deleted'. No schema change: 'deleted' is a plain
      // TEXT value in the existing files.state column.
      await this.index.upsertFile({ ...row, state: 'deleted', updated_at: new Date().toISOString() });
      return { object_id: objectId, blobs_deleted: keys.length, versions_deleted: 0, tombstoned: true };
    }
    await this.index.deleteVersions(objectId);
    await this.index.deleteFile(objectId);
    // blobs_deleted counts R2 objects (one per version), not chunk rows.
    return { object_id: objectId, blobs_deleted: keys.length, versions_deleted: versions.length };
  }

  async deleteAccountScope(ctx, accountId) {
    requireVerifiedWrite(ctx);
    this._requireTransport();
    if (ctx.account_id !== accountId) throw new NotFoundError(accountId);
    await this.ensureSchema();
    const objs = await this.index.listFilesByAccount(accountId);
    let objectsDeleted = 0, blobsDeleted = 0;
    for (const obj of objs) {
      const versions = await this.index.listVersions(obj.object_id);
      const keys = versions.map(v => v.storage_key);
      await this.transport.deleteObjects(keys);
      await this.index.deleteVersions(obj.object_id);
      await this.index.deleteFile(obj.object_id);
      objectsDeleted++;
      blobsDeleted += keys.length;
    }
    // Sweep the whole account prefix so orphan objects (bytes landed, index
    // write failed) do not survive a scope delete.
    const leftovers = await this.transport.listObjects(`v1/acct/${accountId}/`);
    if (leftovers.length) {
      await this.transport.deleteObjects(leftovers);
      blobsDeleted += leftovers.length;
    }
    return { account_id: accountId, objects_deleted: objectsDeleted, blobs_deleted: blobsDeleted };
  }

  async mintReadUrl(ctx, objectId, ttlSeconds = 300) {
    const head = await this.head(ctx, objectId);
    return {
      kind: 'platform-route', backend: 'r2', signed: false,
      url: `/api/storage/objects/${objectId}`,
      object_id: objectId, version_no: head.version_no,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      note: 'R2 bytes are never exposed by a fabricated signed URL. Reads resolve through the platform worker, which checks the ledger and grants before serving bytes (PASS-3 §2.3/§4). This descriptor is that route, not a signed URL; expires_at is the worker session window the route should honor.',
    };
  }

  // test introspection (not part of StoragePort)
  async _blobRowCount(objectId) {
    this._requireTransport();
    await this.ensureSchema();
    const versions = await this.index.listVersions(objectId);
    let n = 0;
    for (const v of versions) if (await this.transport.headObject(v.storage_key)) n++;
    return n;
  }
  async _indexRowExists(objectId) {
    await this.ensureSchema();
    return this.index.fileExists(objectId);
  }
}
module.exports = { R2Backend, D1IndexStore, MemoryIndexStore, buildR2Key, R2_BUCKET, rfc3986Encode };
