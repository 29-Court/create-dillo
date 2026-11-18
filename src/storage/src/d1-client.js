'use strict';
/**
 * D1Client — minimal Node client for the Cloudflare D1 HTTP query API.
 * Talks to bin/d1_bridge.py child processes (stdio JSON-lines) so the
 * fleet credential is attached by the connector's own helper inside the
 * bridge and never enters this process, a file, or a log.
 * A small pool (default 2) gives bounded parallelism for chunk I/O;
 * each bridge is strictly sequential.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const ACCOUNT_ID = process.env.PLATFORM_CF_ACCOUNT_ID || 'df3c35b2bb75d5acafb15572064f41c0';
const DATABASE_ID = process.env.PLATFORM_D1_DATABASE_ID || 'ef0fd639-3694-4d9e-829a-af644c40b13f'; // 29court-platform-dev (scratch)

class D1Error extends Error {
  constructor(status, error, sql) {
    super(`D1 query failed (HTTP ${status}): ${error} :: ${String(sql).slice(0, 120)}`);
    this.name = 'D1Error'; this.status = status;
    if (status === 429) this.code = 'RATE_LIMITED';
  }
}

class Bridge {
  constructor(databaseId) {
    this.proc = spawn('python3', [path.join(__dirname, '..', 'bin', 'd1_bridge.py'), databaseId], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.chain = Promise.resolve();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p({ ok: false, status: 0, error: `bridge exited (${code})` });
      this.pending.clear();
    });
  }
  query(sql, params) {
    const run = () => new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const wire = params.map(p => (Buffer.isBuffer(p) || p instanceof Uint8Array) ? { $blob_b64: Buffer.from(p).toString('base64') } : p);
      this.proc.stdin.write(JSON.stringify({ id, sql, params: wire }) + '\n');
    });
    const result = this.chain.then(run, run);
    this.chain = result.then(() => {}, () => {});
    return result;
  }
  close() { try { this.proc.stdin.end(); this.proc.kill(); } catch {} }
}

class D1Client {
  constructor({ databaseId = DATABASE_ID, poolSize = 2 } = {}) {
    this.databaseId = databaseId;
    this.bridges = Array.from({ length: poolSize }, () => new Bridge(databaseId));
    this.rr = 0;
  }
  async query(sql, params = []) {
    const bridge = this.bridges[this.rr++ % this.bridges.length];
    const res = await bridge.query(sql, params);
    if (!res.ok) throw new D1Error(res.status, res.error, sql);
    return res.results;
  }
  /** Run a statement expected to return no rows (DDL/DML). */
  async exec(sql, params = []) { return this.query(sql, params); }
  close() { for (const b of this.bridges) b.close(); }
}
module.exports = { D1Client, D1Error, ACCOUNT_ID, DATABASE_ID };
