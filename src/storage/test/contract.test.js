'use strict';
/**
 * StoragePort contract suite — PASS-3 §2.4: the SAME suite runs against
 * every backend; a backend that fails it is not selectable.
 * Run: node test/contract.test.js   (or: npm test)
 * Backends: MemoryBackend, D1BlobBackend (29court-platform-dev), and
 * R2Backend over the in-process FakeS3 server (fully offline).
 * Set STORAGE_CONTRACT_SKIP_D1=1 to run memory + R2 only (no live D1).
 */
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { MemoryBackend } = require('../src/memory-backend');
const { D1BlobBackend } = require('../src/d1-backend');
const { R2Backend, MemoryIndexStore, rfc3986Encode } = require('../src/r2-backend');
const { FakeS3 } = require('./fake-s3');
const { sha256Hex } = require('../src/storage-port');

/** Deterministic pseudo-random bytes (LCG), so equality checks mean something. */
function sampleBytes(n, seed = 42) {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; buf[i] = (x >>> 24) & 0xff; }
  return buf;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let passed = 0, failed = 0;
const failures = [];
async function test(backendName, name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`PASS [${backendName}] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; failures.push(`[${backendName}] ${name}: ${e.message}`); console.log(`FAIL [${backendName}] ${name}: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(`assert: ${msg}`); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`assertEq: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
async function assertThrowsCode(fn, code, msg) {
  try { await fn(); } catch (e) { if (e.code === code) return; throw new Error(`assertThrows: ${msg} — threw ${e.code || e.message}, want ${code}`); }
  throw new Error(`assertThrows: ${msg} — did not throw, want ${code}`);
}

async function runContract(name, backend) {
  const A = crypto.randomUUID(), B = crypto.randomUUID();
  const ctxA = { account_id: A, account_state: 'verified' };
  const ctxB = { account_id: B, account_state: 'verified' };
  const app = 'contract-suite';
  const chunk = backend.chunkSize;

  const roundTrip = async (label, data) => {
    const put = await backend.put(ctxA, A, app, data, { display_name: `${label}.bin`, declared_mime: 'application/octet-stream' });
    assert(put.object_id, 'put returns object_id');
    assertEq(put.size_bytes, data.length, `${label} size_bytes`);
    assertEq(put.sha256, sha(data), `${label} put sha256`);
    // storage_key is per-backend by storage shape (§2.3/§2.4): D1 and
    // memory use storage_key = object_id; R2 uses the §2.3 key path
    // v1/acct/<account>/app/<app>/obj/<object>/v/<version>/<file>.
    if (backend.name === 'r2') {
      assertEq(put.storage_key, `v1/acct/${A}/app/${app}/obj/${put.object_id}/v/${put.version_no}/${label}.bin`, `${label} storage_key is the §2.3 R2 key`);
    } else {
      assertEq(put.storage_key, put.object_id, `${label} storage_key = object_id`);
    }
    assertEq(put.storage_backend, backend.name, `${label} storage_backend`);
    assertEq(put.state, 'quarantined', `${label} initial state quarantined (§4)`);
    assertEq(put.scan_state, 'pending', `${label} initial scan_state`);
    const got = await backend.get(ctxA, put.object_id);
    assert(got.bytes.equals(data), `${label} get bytes equal put bytes`);
    const head = await backend.head(ctxA, put.object_id);
    assertEq(head.sha256, sha(data), `${label} head sha256 recorded correctly`);
    assertEq(head.detected_mime, data.length && data[0] === 0x25 ? 'application/pdf' : head.detected_mime, 'mime placeholder');
    return put;
  };

  await test(name, 'put/get byte equality: empty file', async () => { await roundTrip('empty', Buffer.alloc(0)); });
  await test(name, 'put/get byte equality: 1 byte', async () => { await roundTrip('one', sampleBytes(1, 7)); });
  await test(name, 'put/get byte equality: 1 MB', async () => { await roundTrip('1mb', sampleBytes(1024 * 1024, 11)); });
  await test(name, 'put/get byte equality: multi-chunk boundaries (chunk-1, chunk, chunk+1)', async () => {
    await roundTrip('chunk-minus-1', sampleBytes(chunk - 1, 21));
    await roundTrip('chunk-exact', sampleBytes(chunk, 22));
    await roundTrip('chunk-plus-1', sampleBytes(chunk + 1, 23));
  });
  await test(name, 'put from a stream round-trips', async () => {
    const data = sampleBytes(100000, 31);
    const put = await backend.put(ctxA, A, app, Readable.from([data.subarray(0, 40000), data.subarray(40000)]), {});
    const got = await backend.get(ctxA, put.object_id);
    assert(got.bytes.equals(data), 'stream bytes equal');
  });
  await test(name, 'sha256 recorded correctly in the index', async () => {
    const data = sampleBytes(12345, 41);
    const put = await backend.put(ctxA, A, app, data, {});
    const head = await backend.head(ctxA, put.object_id);
    assertEq(head.sha256, sha(data), 'index sha256');
    assertEq(sha256Hex(data), head.sha256, 'index sha256 (port helper)');
  });
  await test(name, 'listByAccount: two-account isolation, exact membership', async () => {
    const a1 = await backend.put(ctxA, A, app, sampleBytes(10, 51), {});
    const a2 = await backend.put(ctxA, A, app, sampleBytes(20, 52), {});
    const b1 = await backend.put(ctxB, B, app, sampleBytes(30, 53), {});
    const listA = await backend.listByAccount(ctxA, A);
    const idsA = new Set(listA.map(r => r.object_id));
    assert(idsA.has(a1.object_id) && idsA.has(a2.object_id), 'A list contains A objects');
    assert(!idsA.has(b1.object_id), 'A list must NOT contain B object');
    assert(listA.every(r => r.account_id === A), 'A list rows all owned by A');
    const listB = await backend.listByAccount(ctxB, B);
    assertEq(listB.length, 1, 'B list has exactly its one object');
    assertEq(listB[0].object_id, b1.object_id, 'B list membership');
    // cross-account read must not leak existence
    await assertThrowsCode(() => backend.get(ctxB, a1.object_id), 'NOT_FOUND', 'cross-account get');
    await assertThrowsCode(() => backend.listByAccount(ctxB, A), 'NOT_FOUND', 'cross-account list');
  });
  await test(name, 'deleteObject: zero blobs left, index consistent, sibling untouched', async () => {
    const victim = await backend.put(ctxA, A, app, sampleBytes(chunk + 5000, 61), {});
    const sibling = await backend.put(ctxA, A, app, sampleBytes(5000, 62), {});
    const res = await backend.deleteObject(ctxA, victim.object_id);
    // blobs_deleted counts storage units, which differ by backend shape:
    // D1/memory count chunk rows (a chunk+5000 file is >= 2 chunks);
    // R2 stores one object per version, so one version deletes one object.
    if (backend.name === 'r2') assert(res.blobs_deleted >= 1, `R2: one object per version deleted (got ${res.blobs_deleted})`);
    else assert(res.blobs_deleted >= 2, `multi-chunk blobs deleted (got ${res.blobs_deleted})`);
    assertEq(await backend._blobRowCount(victim.object_id), 0, 'zero blob rows remain');
    if (typeof backend._indexRowExists === 'function') assertEq(await backend._indexRowExists(victim.object_id), false, 'index row gone');
    await assertThrowsCode(() => backend.head(ctxA, victim.object_id), 'NOT_FOUND', 'head after delete');
    const sib = await backend.get(ctxA, sibling.object_id);
    assert(sib.bytes.equals(sampleBytes(5000, 62)), 'sibling bytes intact');
  });
  await test(name, 'deleteAccountScope: prefix empty, other account untouched', async () => {
    const before = await backend.listByAccount(ctxB, B);
    assert(before.length >= 1, 'B has objects before scope delete');
    const res = await backend.deleteAccountScope(ctxA, A);
    assert(res.objects_deleted >= 1, 'scope delete removed objects');
    const afterA = await backend.listByAccount(ctxA, A);
    assertEq(afterA.length, 0, 'A prefix empty after deleteAccountScope');
    const afterB = await backend.listByAccount(ctxB, B);
    assertEq(afterB.length, before.length, 'B untouched by A scope delete');
    for (const row of afterB) {
      const got = await backend.get(ctxB, row.object_id);
      assertEq(got.head.sha256, row.sha256, 'B object still retrievable and consistent');
    }
  });
  await test(name, 'versions: two puts of one object do not collide (v/1, v/2 both retrievable)', async () => {
    const v1data = Buffer.from('version one content', 'utf8');
    const v2data = Buffer.from('version two content, different bytes', 'utf8');
    const p1 = await backend.put(ctxB, B, app, v1data, { display_name: 'doc.txt', declared_mime: 'text/plain' });
    assertEq(p1.version_no, 1, 'first put is v/1');
    const p2 = await backend.put(ctxB, B, app, v2data, { object_id: p1.object_id });
    assertEq(p2.version_no, 2, 'second put is v/2');
    assertEq(p2.object_id, p1.object_id, 'same object_id');
    const gotDefault = await backend.get(ctxB, p1.object_id);
    assert(gotDefault.bytes.equals(v2data), 'default get returns latest (v/2)');
    const gotV1 = await backend.get(ctxB, p1.object_id, { version: 1 });
    assert(gotV1.bytes.equals(v1data), 'v/1 still retrievable, unmodified');
    const gotV2 = await backend.get(ctxB, p1.object_id, { version: 2 });
    assert(gotV2.bytes.equals(v2data), 'v/2 retrievable');
    const headV1 = await backend.head(ctxB, p1.object_id, { version: 1 });
    assertEq(headV1.sha256, sha(v1data), 'v/1 sha in version record');
    assertEq(headV1.detected_mime, 'text/plain', 'detected_mime sniffed as text');
  });
  await test(name, 'writes refuse non-verified account states (pending, suspended, killed)', async () => {
    for (const state of ['pending', 'suspended', 'killed']) {
      const bad = { account_id: A, account_state: state };
      await assertThrowsCode(() => backend.put(bad, A, app, Buffer.from('x'), {}), 'NOT_VERIFIED', `put as ${state}`);
      await assertThrowsCode(() => backend.deleteAccountScope(bad, A), 'NOT_VERIFIED', `deleteAccountScope as ${state}`);
    }
    const ok = await backend.put(ctxA, A, app, Buffer.from('y'), {});
    assert(ok.object_id, 'verified write still works after refusals');
    await assertThrowsCode(() => backend.deleteObject({ account_id: A, account_state: 'pending' }, ok.object_id), 'NOT_VERIFIED', 'deleteObject as pending');
  });
  await test(name, 'mintReadUrl returns a platform-route descriptor, never a fake signed URL', async () => {
    const put = await backend.put(ctxB, B, app, Buffer.from('read me'), {});
    const desc = await backend.mintReadUrl(ctxB, put.object_id, 300);
    assertEq(desc.kind, 'platform-route', 'descriptor kind');
    assertEq(desc.signed, false, 'descriptor is honestly unsigned');
    assert(desc.url.includes(put.object_id), 'descriptor url names the object');
    assert(!/X-Amz|Signature=|sig=/.test(desc.url), 'no fabricated signature params');
  });
  await test(name, 'F1/A2 cross-app put refused (NOT_FOUND), same-app versioning still works', async () => {
    const other = await backend.put(ctxA, A, 'other-app', Buffer.from('other-app bytes'), { display_name: 'shared.md' });
    await assertThrowsCode(
      () => backend.put(ctxA, A, app, Buffer.from('hijack'), { object_id: other.object_id, display_name: 'shared.md' }),
      'NOT_FOUND', 'put naming another app object must refuse without leaking existence');
    const headAfter = await backend.head(ctxA, other.object_id);
    assertEq(headAfter.app_slug, 'other-app', 'refused put did not re-home the object');
    const gotV1 = await backend.get(ctxA, other.object_id, { version: 1 });
    assert(gotV1.bytes.equals(Buffer.from('other-app bytes')), 'v1 bytes intact after refused hijack');
    const v2 = await backend.put(ctxA, A, 'other-app', Buffer.from('other-app v2'), { object_id: other.object_id });
    assertEq(v2.version_no, 2, 'same-app versioning still mints v2');
    assertEq(v2.app_slug, 'other-app', 'same-app version keeps its app');
  });
  await test(name, 'F1/A3 caller-supplied state/scan_state ignored; versions land quarantined/pending', async () => {
    const p1 = await backend.put(ctxA, A, app, Buffer.from('q1'), { display_name: 'q.md', state: 'active', scan_state: 'passed-basic' });
    assertEq(p1.state, 'quarantined', 'new put state forced quarantined');
    assertEq(p1.scan_state, 'pending', 'new put scan_state forced pending');
    const head = await backend.head(ctxA, p1.object_id);
    assertEq(head.state, 'quarantined', 'head state quarantined');
    assertEq(head.scan_state, 'pending', 'head scan_state pending');
    const p2 = await backend.put(ctxA, A, app, Buffer.from('q2'), { object_id: p1.object_id, state: 'active', scan_state: 'passed-basic' });
    assertEq(p2.state, 'quarantined', 'v2 state forced quarantined');
    assertEq(p2.scan_state, 'pending', 'v2 scan_state forced pending');
  });
  await test(name, 'F1/A5 concurrent puts land N distinct retrievable versions', async () => {
    const base = await backend.put(ctxA, A, app, Buffer.from('race-base'), { display_name: 'race.md' });
    const payloads = ['racer-A', 'racer-B', 'racer-C', 'racer-D'].map(s => Buffer.from(s));
    const results = await Promise.all(payloads.map(b =>
      backend.put(ctxA, A, app, b, { object_id: base.object_id, display_name: 'race.md' })));
    const versionNos = results.map(r => r.version_no);
    assertEq(new Set(versionNos).size, payloads.length, `all ${payloads.length} racers got distinct versions (got ${versionNos})`);
    assert(versionNos.every(n => n > 1), 'all racers are versions after v1');
    const seen = new Set();
    for (const n of versionNos) {
      const got = await backend.get(ctxA, base.object_id, { version: n });
      seen.add(got.bytes.toString());
    }
    assertEq(seen.size, payloads.length, 'every racer version retrievable with its own bytes');
    for (const p of payloads) assert(seen.has(p.toString()), `payload ${p} present in exactly one version`);
    const v1 = await backend.get(ctxA, base.object_id, { version: 1 });
    assert(v1.bytes.equals(Buffer.from('race-base')), 'v1 survived the race byte-identical');
  });
  await test(name, 'F1 tombstone: bytes gone, row+versions retained, hidden by default, revived by put', async () => {
    const p1 = await backend.put(ctxA, A, app, Buffer.from('tomb-one'), { display_name: 'tomb.md' });
    const p2 = await backend.put(ctxA, A, app, Buffer.from('tomb-two'), { object_id: p1.object_id });
    assertEq(p2.version_no, 2, 'v2 before tombstone');
    const res = await backend.deleteObject(ctxA, p1.object_id, { tombstone: true });
    assertEq(res.tombstoned, true, 'tombstone result flagged');
    assertEq(res.versions_deleted, 0, 'tombstone retains version metadata');
    assertEq(res.blobs_deleted, 2, 'tombstone removed both versions bytes');
    assertEq(await backend._blobRowCount(p1.object_id), 0, 'zero bytes remain after tombstone');
    await assertThrowsCode(() => backend.get(ctxA, p1.object_id), 'NOT_FOUND', 'get tombstoned object');
    await assertThrowsCode(() => backend.get(ctxA, p1.object_id, { version: 1 }), 'NOT_FOUND', 'get tombstoned v1');
    await assertThrowsCode(() => backend.head(ctxA, p1.object_id), 'NOT_FOUND', 'head tombstoned object');
    const list = await backend.listByAccount(ctxA, A);
    assert(!list.some(r => r.object_id === p1.object_id), 'default list hides the tombstone');
    const listDel = await backend.listByAccount(ctxA, A, { includeDeleted: true });
    const tomb = listDel.find(r => r.object_id === p1.object_id);
    assert(tomb, 'includeDeleted returns the tombstone');
    assertEq(tomb.state, 'deleted', 'tombstone state visible with includeDeleted');
    assertEq(tomb.version_no, 2, 'tombstone keeps version metadata (latest v2)');
    // Revive: put naming the tombstoned id mints a new version, quarantined/pending.
    const rev = await backend.put(ctxA, A, app, Buffer.from('revived-bytes'), { object_id: p1.object_id });
    assertEq(rev.version_no, 3, 'revive mints v3 (versions continue past the tombstone)');
    assertEq(rev.state, 'quarantined', 'revived state quarantined');
    assertEq(rev.scan_state, 'pending', 'revived scan pending');
    const got = await backend.get(ctxA, p1.object_id);
    assert(got.bytes.equals(Buffer.from('revived-bytes')), 'revived bytes retrievable');
    const listAfter = await backend.listByAccount(ctxA, A);
    assert(listAfter.some(r => r.object_id === p1.object_id), 'revived object listed again by default');
    // The tombstone removed the old versions' BYTES (metadata retained):
    // v1's bytes are honestly gone even though its version row survived.
    await assertThrowsCode(() => backend.get(ctxA, p1.object_id, { version: 1 }), 'NOT_FOUND', 'pre-tombstone version bytes stay gone after revive');
  });

  // cleanup: leave the backend empty of suite data
  try { await backend.deleteAccountScope(ctxA, A); } catch {}
  try { await backend.deleteAccountScope(ctxB, B); } catch {}
}

(async () => {
  console.log('== StoragePort contract suite ==');
  await runContract('memory', new MemoryBackend({ chunkSize: 64 * 1024 }));
  if (process.env.STORAGE_CONTRACT_SKIP_D1 === '1') {
    console.log('SKIP [d1] STORAGE_CONTRACT_SKIP_D1=1');
  } else {
    const d1 = new D1BlobBackend({ chunkSize: 512 * 1024 });
    try { await runContract('d1', d1); } finally { d1.close(); }
  }
  // R2 leg: the full contract against the real R2Backend over the
  // in-process FakeS3 server (S3 transport, SigV4, path-style) with the
  // in-memory index — fully offline, no live Cloudflare call. This is
  // the stub retiring: the old "every method throws NotProvisioned"
  // test is replaced by the contract itself, and the unprovisioned
  // guarantee is re-covered honestly by the F1/W-TEST test below.
  // The fake credentials are test-only dummy values; the fake enforces no auth.
  const fake = new FakeS3({ bucket: '29court-app-files' });
  const fakeUrl = await fake.start();
  const r2 = new R2Backend({
    endpoint: fakeUrl, bucket: '29court-app-files',
    accessKeyId: 'fake-test-key', secretAccessKey: 'fake-test-secret', region: 'us-east-1',
    index: new MemoryIndexStore(), chunkSize: 512 * 1024,
  });
  try {
    await runContract('r2', r2);
    // F1/A1b+A1c: the encoder itself is RFC 3986 (the wire proof is the
    // adversary's independent SigV4 verifier in proof/adv-r2.cjs).
    await test('r2', 'F1/A1b+A1c SigV4 encoder is RFC 3986 (parens, quote, star, bang)', async () => {
      assertEq(rfc3986Encode('my (note).md'), 'my%20%28note%29.md', 'parens pct-encoded');
      assertEq(rfc3986Encode("don't * stop!.md"), 'don%27t%20%2A%20stop%21.md', 'quote/star/bang pct-encoded');
      assertEq(rfc3986Encode('plain-note.md'), 'plain-note.md', 'unreserved chars untouched');
      assertEq(rfc3986Encode('a/b'), 'a%2Fb', 'slash pct-encoded inside a segment');
    });
    // F1/A4: a failed v2 push (staged index failure on the 2nd insert)
    // must leave v1 retrievable byte-identical — the adversary's repro
    // shape, banked as a contract test.
    await test('r2', 'F1/A4 failed v2 push leaves v1 retrievable byte-identical', async () => {
      class FailSecondInsert extends MemoryIndexStore {
        constructor() { super(); this.inserts = 0; }
        async insertVersion(v) { this.inserts++; if (this.inserts === 2) throw new Error('simulated D1 constraint failure on insertVersion'); return super.insertVersion(v); }
      }
      const idx = new FailSecondInsert();
      const backend = new R2Backend({
        endpoint: fakeUrl, bucket: '29court-app-files',
        accessKeyId: 'fake-test-key', secretAccessKey: 'fake-test-secret', region: 'us-east-1',
        index: idx, chunkSize: 512 * 1024,
      });
      try {
        const acc = crypto.randomUUID();
        const ctx = { account_id: acc, account_state: 'verified' };
        const v1 = await backend.put(ctx, acc, 'notes', Buffer.from('v1 bytes'), { display_name: 'doc.md' });
        let v2err = null;
        try { await backend.put(ctx, acc, 'notes', Buffer.from('v2 bytes'), { object_id: v1.object_id, display_name: 'doc.md' }); }
        catch (e) { v2err = e; }
        assert(v2err, 'staged v2 failure threw');
        const gotV1 = await backend.get(ctx, v1.object_id, { version: 1 });
        assert(gotV1.bytes.equals(Buffer.from('v1 bytes')), 'v1 retrievable byte-identical after failed v2');
        const gotLatest = await backend.get(ctx, v1.object_id);
        assert(gotLatest.bytes.equals(Buffer.from('v1 bytes')), 'latest is still v1 after failed v2');
        assertEq(gotLatest.head.version_no, 1, 'no phantom v2 row');
      } finally { backend.close(); }
    });
    // F1/W-TEST: the unprovisioned NOT_PROVISIONED guarantee, restored.
    // A no-config R2Backend (no binding, no endpoint) must throw
    // NOT_PROVISIONED on every method; the configured backend over the
    // fake must NOT throw it.
    await test('r2', 'F1/W-TEST unprovisioned R2Backend throws NOT_PROVISIONED on every method', async () => {
      const bare = new R2Backend();
      try {
        const acc = crypto.randomUUID();
        const ctx = { account_id: acc, account_state: 'verified' };
        const id = crypto.randomUUID();
        await assertThrowsCode(() => bare.put(ctx, acc, 'notes', Buffer.from('x'), {}), 'NOT_PROVISIONED', 'put unprovisioned');
        await assertThrowsCode(() => bare.get(ctx, id), 'NOT_PROVISIONED', 'get unprovisioned');
        await assertThrowsCode(() => bare.head(ctx, id), 'NOT_PROVISIONED', 'head unprovisioned');
        await assertThrowsCode(() => bare.listByAccount(ctx, acc), 'NOT_PROVISIONED', 'listByAccount unprovisioned');
        await assertThrowsCode(() => bare.deleteObject(ctx, id), 'NOT_PROVISIONED', 'deleteObject unprovisioned');
        await assertThrowsCode(() => bare.deleteAccountScope(ctx, acc), 'NOT_PROVISIONED', 'deleteAccountScope unprovisioned');
        await assertThrowsCode(() => bare.mintReadUrl(ctx, id), 'NOT_PROVISIONED', 'mintReadUrl unprovisioned');
      } finally { bare.close(); }
      const acc2 = crypto.randomUUID();
      const ctx2 = { account_id: acc2, account_state: 'verified' };
      const ok = await r2.put(ctx2, acc2, 'notes', Buffer.from('provisioned'), {});
      assert(ok.object_id, 'configured backend puts without NOT_PROVISIONED');
      await r2.deleteObject(ctx2, ok.object_id);
    });
  } finally { r2.close(); await fake.close(); }
  console.log(`\n== ${passed} passed, ${failed} failed ==`);
  if (failures.length) { console.log('Failures:'); for (const f of failures) console.log(' - ' + f); }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('suite crashed:', e); process.exit(2); });
