import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { local } from 'create-dillo/local';
import { Armadillo } from 'create-dillo/client';
import backend from './backend.ts';

test('typed projects, caller function, owner isolation and logout through the public client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minimal-contract-'));
  const server = await local(backend, { appId: 'minimal', databasePath: join(directory, 'minimal.db'), filesDirectory: join(directory, 'files'), port: 0, signupMode: 'open', maintenanceIntervalMs: 0 });
  const app = Armadillo.client<typeof backend>({ url: server.origin, appId: 'minimal' });
  try {
    const account = async (email: string) => {
      const credentials = { email, password: 'a-long-test-only-password' };
      await app.auth.signUp(credentials);
      return app.withAuth((await app.auth.logIn(credentials, { mode: 'token' })).token);
    };
    const owner = await account('owner@example.com');
    const neighbor = await account('neighbor@example.com');
    const project = await owner.tables.Project.create({ name: 'Bring the chairs' });
    assert.equal(project.active, true);
    assert.equal((await owner.functions.greet({ name: 'Alex' })).message, 'Hello, Alex! Your projects are private to you.');
    assert.equal((await owner.tables.Project.update(project.id, { active: false })).active, false);
    assert.equal((await neighbor.tables.Project.query().find()).length, 0);
    await assert.rejects(neighbor.tables.Project.get(project.id));
    await assert.rejects(neighbor.tables.Project.update(project.id, { name: 'Not yours' }));
    await owner.tables.Project.delete(project.id);
    assert.equal((await owner.tables.Project.query().find()).length, 0);
    await owner.auth.logOut();
    await assert.rejects(owner.tables.Project.query().find());
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
