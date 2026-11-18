'use strict';
/**
 * FakeS3 — a minimal in-process S3-compatible HTTP server for tests ONLY.
 *
 * Implements PutObject / GetObject / HeadObject / DeleteObject /
 * ListObjectsV2 (plus DeleteMultiple, unused by the transport but cheap)
 * against an in-memory map. No auth enforcement: the SigV4 signature is
 * accepted without verification, so the contract suite runs fully
 * offline and exercises the real S3 transport code path (signing,
 * path-style addressing, XML list parsing) without any live Cloudflare
 * call. Never used outside test/.
 */
const http = require('node:http');
const crypto = require('node:crypto');

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlError(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
}

class FakeS3 {
  constructor({ bucket = '29court-app-files' } = {}) {
    this.bucket = bucket;
    this.store = new Map(); // key -> { bytes: Buffer, contentType: string }
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/xml' }); res.end(xmlError('InternalError', String(e && e.message || e))); }
      });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }
  async close() { await new Promise((resolve) => this.server.close(resolve)); }

  /** Test introspection. */
  objectCount() { return this.store.size; }
  has(key) { return this.store.has(key); }
  keys() { return [...this.store.keys()].sort(); }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  async _handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const parts = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (parts[0] !== this.bucket) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end(xmlError('NoSuchBucket', `bucket ${parts[0] || ''} does not exist`));
      return;
    }
    // ListObjectsV2: GET /<bucket>?list-type=2
    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const maxKeys = Math.min(Math.max(parseInt(u.searchParams.get('max-keys') || '1000', 10) || 1000, 1), 1000);
      const offset = parseInt(u.searchParams.get('continuation-token') || '0', 10) || 0;
      const all = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = all.slice(offset, offset + maxKeys);
      const truncated = offset + maxKeys < all.length;
      const contents = page.map((k) => {
        const o = this.store.get(k);
        return `<Contents><Key>${xmlEscape(k)}</Key><Size>${o.bytes.length}</Size><ETag>"${crypto.createHash('md5').update(o.bytes).digest('hex')}"</ETag></Contents>`;
      }).join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
        + `<Name>${xmlEscape(this.bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>`
        + `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`
        + `<IsTruncated>${truncated}</IsTruncated>`
        + (truncated ? `<NextContinuationToken>${offset + maxKeys}</NextContinuationToken>` : '')
        + contents + `</ListBucketResult>`);
      return;
    }
    // DeleteMultiple: POST /<bucket>?delete
    if (req.method === 'POST' && u.searchParams.has('delete')) {
      const body = (await this._readBody(req)).toString('utf8');
      const deleted = [];
      for (const m of body.matchAll(/<Key>(.*?)<\/Key>/gs)) {
        const k = m[1];
        this.store.delete(k);
        deleted.push(`<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`);
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deleted.join('')}</DeleteResult>`);
      return;
    }
    const key = parts.slice(1).join('/');
    if (!key) { res.writeHead(400, { 'Content-Type': 'application/xml' }); res.end(xmlError('InvalidRequest', 'object key is required')); return; }

    if (req.method === 'PUT') {
      const bytes = await this._readBody(req);
      this.store.set(key, { bytes, contentType: req.headers['content-type'] || 'application/octet-stream' });
      res.writeHead(200, { ETag: `"${crypto.createHash('md5').update(bytes).digest('hex')}"` });
      res.end('');
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const obj = this.store.get(key);
      if (!obj) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        if (req.method === 'GET') res.end(xmlError('NoSuchKey', `key ${key} does not exist`));
        else res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': obj.contentType,
        'Content-Length': obj.bytes.length,
        ETag: `"${crypto.createHash('md5').update(obj.bytes).digest('hex')}"`,
      });
      res.end(req.method === 'GET' ? obj.bytes : '');
      return;
    }
    if (req.method === 'DELETE') {
      this.store.delete(key);
      res.writeHead(204);
      res.end('');
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/xml' });
    res.end(xmlError('MethodNotAllowed', `${req.method} is not supported by FakeS3`));
  }
}
module.exports = { FakeS3 };
