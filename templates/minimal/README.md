# Minimal Dillo

A small project list: authentication, typed CRUD, owner permissions, and a typed `greet` cloud function. Open `schema.ts`, `backend.ts`, and `ui/main.ts` to follow the entire application.

Install the published alpha (`npm install create-dillo@alpha`), then run one command:

```sh
npm run dev
```

Open the one-use sign-in link printed in the terminal. The loopback server runs at **http://127.0.0.1:8787**, creates `.data/minimal.db`, and seeds a useful project for `hello@example.com`. Add, complete, and delete projects in the browser. Each account only sees its own projects; the cloud function runs as the signed-in caller.

From a repo checkout instead, install the packed tarball:

```sh
# Repository root
npm ci
npm pack
cd examples/minimal
npm install --ignore-scripts --no-save ../../create-dillo-1.0.0.tgz
npm run dev
```

Initial data is written to a staging database through the public client. Interrupted startup resumes idempotently; a transactional `sample-v1` marker is committed before the database is atomically promoted. Restart never reseeds an existing `.db` or resets user changes. `DATABASE_PATH` and `PORT` override the defaults. Local sign-in links expire and work once; no fixed password is stored.

`npm run check` verifies strict TypeScript, the Workers bundle, first startup, preservation of existing data, and recovery after an interrupted initializer. `npm run plan` is the separate Cloudflare deployment path; local startup needs no cloud account. Run `npm run build:ui` before cloud deployment. Live-cloud upgrade and recovery still require separate verification.
