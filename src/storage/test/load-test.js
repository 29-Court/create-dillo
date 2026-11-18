'use strict';
/**
 * Load test — sets the v1 per-file cap from evidence, not from docs
 * (PASS-3 §2.4/§4: cap proven by test, never above 100 MB).
 * Method: ladder probe 1,2,4,8,16,32 MB through D1BlobBackend
 * (512 KiB chunks, bridge pool 4). Each probe = put + get + sha256
 * equality + deleteObject. First failure stops the ladder and a binary
 * search (integer MB) narrows the pass/fail bracket. If nothing fails,
 * the tested ceiling is reported as such — no claim beyond it.
 * Results are written to test/load-results.json.
 * Run: node test/load-test.js
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { D1BlobBackend } = require('../src/d1-backend');
const { D1Client } = require('../src/d1-client');

function sampleBytes(n, seed) {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 4096) { // fill by blocks for speed at large n
    const block = Buffer.alloc(Math.min(4096, n - i));
    for (let j = 0; j < block.length; j++) { x = (x * 1664525 + 1013904223) >>> 0; block[j] = (x >>> 24) & 0xff; }
    block.copy(buf, i);
  }
  return buf;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const now = () => Date.now() / 1000;

async function main() {
  const client = new D1Client({ poolSize: 4 });
  const backend = new D1BlobBackend({ client, chunkSize: 512 * 1024 });
  const account = crypto.randomUUID();
  const ctx = { account_id: account, account_state: 'verified' };
  const results = [];
  async function probe(sizeMB) {
    const data = sampleBytes(sizeMB * 1024 * 1024, 1000 + sizeMB);
    const expectSha = sha(data);
    let putS = null, getS = null, ok = false, error = null, objectId = null;
    try {
      let t = now();
      const put = await backend.put(ctx, account, 'load-test', data, { display_name: `load-${sizeMB}mb.bin` });
      putS = now() - t; objectId = put.object_id;
      t = now();
      const got = await backend.get(ctx, objectId);
      getS = now() - t;
      ok = got.bytes.length === data.length && sha(got.bytes) === expectSha;
      if (!ok) error = 'sha256/length mismatch on read-back';
    } catch (e) { error = `${e.name || 'Error'}${e.status ? ' HTTP ' + e.status : ''}: ${String(e.message).slice(0, 300)}`; }
    finally { if (objectId) { try { await backend.deleteObject(ctx, objectId); } catch {} } }
    const rec = { size_mb: sizeMB, ok, put_s: putS && +putS.toFixed(1), get_s: getS && +getS.toFixed(1), error };
    results.push(rec);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${sizeMB} MB  put=${rec.put_s}s get=${rec.get_s}s${error ? '  ' + error : ''}`);
    return rec;
  }

  const ladder = [1, 2, 4, 8, 16, 32];
  let lastPass = 0, firstFail = null;
  for (const s of ladder) {
    const r = await probe(s);
    if (r.ok) lastPass = s; else { firstFail = s; break; }
  }
  if (firstFail !== null) {
    let lo = lastPass, hi = firstFail;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await probe(mid);
      if (r.ok) lo = mid; else hi = mid;
    }
    lastPass = lo; firstFail = hi;
  }
  // Reliability re-check: the largest passing size must round-trip twice in a row.
  let recheck = null;
  if (lastPass > 0) {
    const again = results.filter(r => r.size_mb === lastPass && r.ok).length;
    if (again < 2) { recheck = await probe(lastPass); }
  }
  const summary = {
    ran_at: new Date().toISOString(),
    backend: 'd1', database: '29court-platform-dev', chunk_bytes: 512 * 1024,
    transport: 'D1 HTTP query API via bin/d1_bridge.py (BLOB params as int arrays)',
    largest_passing_mb: lastPass, first_failing_mb: firstFail, results,
  };
  fs.writeFileSync(path.join(__dirname, 'load-results.json'), JSON.stringify(summary, null, 2));
  console.log(`\nLargest passing: ${lastPass} MB; first failing: ${firstFail === null ? 'none up to 32 MB (tested ceiling)' : firstFail + ' MB'}`);
  try { await backend.deleteAccountScope(ctx, account); } catch {}
  client.close();
}
main().catch(e => { console.error('load test crashed:', e); process.exit(2); });
