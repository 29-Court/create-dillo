import { HTTP_API_PREFIX } from 'create-dillo';
import './build.ts';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { local } from 'create-dillo/local';
import { Armadillo } from 'create-dillo/client';
import backend from './backend.ts';
import { initializeDatabase } from './initialize.ts';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const databasePath = resolve(process.env.DATABASE_PATH || './.data/minimal.db');
const email = 'hello@example.com';
const options = { appId: 'minimal', databasePath, filesDirectory: resolve(dirname(databasePath), 'files'), hostname: '127.0.0.1', port: Number(process.env.PORT || 8787), development: true, signupMode: 'closed' as const, bootstrapSecret: 'local-minimal-bootstrap-secret-value' };
await initializeDatabase(databasePath, async staging => {
  const server = await local(backend, { ...options, databasePath: staging, port: 0, maintenanceIntervalMs: 0 });
  try {
    const client = Armadillo.client<typeof backend>({ url: server.origin, appId: 'minimal' });
    try { await client.auth.bootstrap({ email, name: 'Neighbor', password: crypto.randomUUID() + crypto.randomUUID(), secret: options.bootstrapSecret }); }
    catch (error) { if ((error as { status?: number }).status !== 409) throw error; }
    const mail = await client.auth.requestMagicLink({ email });
    const response = await fetch(server.origin + HTTP_API_PREFIX + '/auth/verify', { method: 'POST', headers: { 'x-armadillo-auth-mode': 'token', 'content-type': 'application/json' }, body: JSON.stringify({ token: mail.debugToken }) });
    const session = await response.json() as { token: string };
    const signedIn = client.withAuth(session.token);
    if (!(await signedIn.table('Project').query().find()).length) await signedIn.table('Project').create({ name: 'Plan a good night', active: true });
    await signedIn.auth.logOut();
  } finally { await server.close(); }
});
const server = await local(backend, { ...options, publicDirectory: './public' });
const client = Armadillo.client<typeof backend>({ url: server.origin, appId: 'minimal' });
const mail = await client.auth.requestMagicLink({ email, redirectTo: server.origin });
console.log(`Minimal: ${server.origin}\nDatabase: ${databasePath}\nOne-use local sign-in: ${server.origin}/?armadillo_magic_token=${encodeURIComponent(mail.debugToken!)}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().then(() => process.exit(0)); });
