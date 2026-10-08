import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { initializeDatabase } from './initialize.ts';

test('initialization recovers an interrupted staging database and never reseeds published data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'armadillo-initialize-'));
  const path = join(directory, 'example.db');
  let attempts = 0;
  const seed = async (staging: string) => {
    const db = new DatabaseSync(staging);
    try { db.exec("BEGIN; CREATE TABLE IF NOT EXISTS sample(id TEXT PRIMARY KEY, name TEXT); INSERT OR IGNORE INTO sample VALUES('first', 'original'); COMMIT;"); }
    finally { db.close(); }
    if (++attempts === 1) throw new Error('simulated interruption after a committed seed operation');
  };
  try {
    await assert.rejects(initializeDatabase(path, seed), /interruption/);
    await assert.rejects(access(path));
    assert.equal(await initializeDatabase(path, seed), true);
    const db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sample').get()!.n, 1);
    db.exec("UPDATE sample SET name='user edit'"); db.close();
    assert.equal(await initializeDatabase(path, async () => { throw new Error('must not seed existing data'); }), false);
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare('SELECT name FROM sample').get()!.name, 'user edit'); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one command starts with useful data and restart preserves user edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'armadillo-startup-'));
  const path = join(directory, 'example.db');
  async function start() {
    const process = spawn(globalThis.process.execPath, ['--experimental-strip-types', 'local.ts'], { cwd: new URL('.', import.meta.url), env: { ...globalThis.process.env, DATABASE_PATH: path, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { process.kill(); reject(new Error('Startup timeout: ' + output)); }, 30000);
      process.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/One-use local (?:host )?sign-in: (http[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]!); } });
      process.stderr.on('data', chunk => { output += String(chunk); });
      process.on('exit', code => { clearTimeout(timeout); reject(new Error('Startup exited ' + code + ': ' + output)); });
    });
    return { url, stop: () => new Promise<void>(resolve => { process.once('exit', () => resolve()); process.kill('SIGTERM'); }) };
  }
  try {
    const first = await start();
    assert.equal((await fetch(new URL('/', first.url))).status, 200);
    await first.stop();
    const db = new DatabaseSync(path);
    assert.ok(Number(db.prepare('SELECT count(*) AS n FROM _armadillo_objects').get()!.n) > 0);
    db.exec("CREATE TABLE startup_user_data(value TEXT); INSERT INTO startup_user_data VALUES('keep me');"); db.close();
    const second = await start(); await second.stop();
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare('SELECT value FROM startup_user_data').get()!.value, 'keep me'); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('completed staging promotes without seeding; a concurrent final database is never replaced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'armadillo-promotion-'));
  try {
    const completed = join(directory, 'completed.db');
    const stage = new DatabaseSync(completed + '.initializing.db');
    stage.exec('CREATE TABLE sample(id TEXT)'); stage.close();
    await writeFile(completed + '.initializing.db.ready', 'sample-v1');
    assert.equal(await initializeDatabase(completed, async () => { throw new Error('completed staging must not seed'); }), true);
    const concurrent = join(directory, 'concurrent.db');
    assert.equal(await initializeDatabase(concurrent, async path => {
      const staging = new DatabaseSync(path); staging.exec('CREATE TABLE sample(value TEXT)'); staging.close();
      const winner = new DatabaseSync(concurrent); winner.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('winning data');"); winner.close();
    }), false);
    const winner = new DatabaseSync(concurrent);
    assert.equal(winner.prepare('SELECT value FROM preserved').get()!.value, 'winning data'); winner.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
