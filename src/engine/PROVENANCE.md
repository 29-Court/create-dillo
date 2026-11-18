# Provenance — recovered create-dillo TypeScript sources

Recovered 2026-11-10 by slice A4 of the overnight repo program
(`docs/OVERNIGHT-PROGRAM-FABLE-2026-11-10.md` §1.3 A4, §1.2).

## Source of record

- Source repo: `29-Court/create-dillo`, branch `main`
- Source head: `ad47d1eb982e8b795c48b7d0a452580ef035a0d2`
- Source tree: `bb3c39be87da5eaf6f7d4550774fbe46eaa2dc50`
- Fetch date: 2026-11-10
- Fetch mechanism: GitHub Git Data API via the house custody helper
  (`gitdata_sync.RepoSync`, connector `custom.github-pat`); the git
  protocol does not work from the build VM. Full source tree at that
  head: 387 files, 113 under `src/`.
- Landed here: every file under the source repo's `src/` (113 files,
  structure preserved, so source `src/engine/mail.ts` is
  `engine/mail.ts` in this directory), plus the source root `LICENSE`
  (MIT) as `LICENSE` in this directory. The per-file source blob SHAs
  are in `MANIFEST.json` beside this file.
- Not landed: the source root `package.json` and `README.md` were
  fetched and used for the match check below (their blob SHAs are
  recorded in `MANIFEST.json`), but not copied in — a nested
  `package.json` here would shadow the `dillo` package's own, and
  the source README is the source repo's site-style readme, not this
  package's face. The `dillo/package.json` is owned by a sibling
  slice and was not edited.

## Match verdict: MATCH — the sources correspond to the shipped dist

Evidence, all measured in this run:

1. **The source repo's own `dist/` is byte-identical to the in-repo
   legacy dist.** The source tree at the head above contains 204
   files under `dist/`; the legacy copy at
   `packages/dillo/app/dillo-pkg-src/dist/` also contains 204.
   All 204 files are common to both, and all 204 have identical git
   blob SHAs (204/204, zero differing, zero only-on-one-side).
2. **Every shipped declaration file has its source.** Every
   `dist/**/*.d.ts` in the legacy dist maps to a `src/**/*.ts` in
   the recovered tree, and every recovered `src/**/*.ts` maps to a
   shipped counterpart — the library modules to `dist/`, the
   `src/cli/` files to `dist-cli/`. The only recovered file with no
   compiled counterpart is `src/agent-bridge/README.md` (docs), and
   `src/build.d.ts` is an ambient-declaration file (module wildcards
   for `*.txt` / `*.module.js` / `*.bundle.js` plus the
   `ARMADILLO_BUILD_VERSION` build constant), which ships as source
   by design.
3. **LICENSE is identical** in both repos: blob
   `27e97ad8f5555f4e4e01074215ec01a689cd83b1` (MIT, Copyright (c)
   2026 Victor Algaze).

Divergences found, neither of which touches the API surface:

- `package.json`: the source repo carries version
  `1.0.0-alpha.0`; the in-repo legacy copy carries `1.0.0`. The
  full diff is that one version line plus a trailing newline at
  end of file — every export path, dependency, and script is
  identical.
- `README.md`: the two READMEs differ throughout. The source
  repo's is a short site-style readme (install-first); the in-repo
  legacy copy's is a longer product readme carrying the
  `1.0.0` / `v1.0.0-rc.1` status table. Documentation diverged
  after the dist was copied in; code and declarations did not.

So the upstream of record and the shipped artifact agree: these
sources are the sources of the dist the estate has been running.

## Verification gates run at landing

- Blob verification: every landed source file's local git blob SHA
  (`git hash-object`) equals the source repo's blob SHA for that
  path — 113/113 for `src/`, plus LICENSE 1/1.
- Secret scan: `gitleaks dir dillo/src/engine` — clean (see the
  slice record in the campaign RUN.md for the verbatim tail).
- Syntax smoke: no `tsc`, `esbuild`, or `wrangler` exists in the
  repo toolchain (`node_modules/.bin` holds none of them), so a
  full typecheck was not run — the source repo's tsconfigs were
  also outside this slice's recovery scope. As a syntax gate, the
  oxc parser bundled with the repo's `rolldown` package
  (`rolldown/parseAst`) parsed all 112 landed `.ts` files:
  112/112, zero parse failures. That is syntax only, not a
  typecheck.

## Notes / surprises

- `src/cli/` (11 files: `project.ts`, `run-workflow.ts`, and
  `commands/{backup,create,deploy,dev,doctor,init,plan,run}.ts`)
  recovers the CLI's TypeScript sources; the legacy package only
  carried its compiled output under `dist-cli/`.
- The recovered tree is the full library, not only the engine:
  top-level `access`, `backend`, `browser`, `cache`,
  `capabilities`, `client`, `computed`, `discovery`, `extensions`,
  `gdpr`, `geo`, `index`, `internal-schema`, `middleware`,
  `migrations`, `prompt-pack`, `realtime`, `realtime-client`,
  `requirements`, `runtime`, `schedules`, `schema`,
  `schema-migrations`, `testing`, `ui`, `usage-config`,
  `versions`, `webhooks`, plus `agent-bridge/`, `cloudflare/`,
  `deploy/`, `engine/`, `local/`, and `ui/` subtrees.
