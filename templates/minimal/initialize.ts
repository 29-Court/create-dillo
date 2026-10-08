import { access, link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Publish only a fully seeded database; never overwrite an existing database. */
export async function initializeDatabase(databasePath: string, seed: (stagingPath: string) => Promise<void>) {
  if (await exists(databasePath)) return false;
  await mkdir(dirname(databasePath), { recursive: true });
  const staging = databasePath + '.initializing.db';
  const ready = staging + '.ready';
  if (!(await exists(staging) && await exists(ready))) {
    await seed(staging);
    const db = new DatabaseSync(staging);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); }
    finally { db.close(); }
    await writeFile(ready, 'sample-v1');
  }
  // A hard link publishes atomically without rename's overwrite behavior.
  try { await link(staging, databasePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  await unlink(staging);
  await unlink(ready);
  return true;
}
