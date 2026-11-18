# dillo — the library

Dillo is a library of typed primitives — auth, permissions,
files, events, database access and a secrets vault — for people
building signed-in apps and workflows on this stack. The legacy
`create-dillo` studio package and its compiled dist are archived
under `legacy/create-dillo/` inside this package (slice A10,
2026-11-10): provenance only, never extended, excluded from the
public face and from any sync set. Its TypeScript sources were
recovered into `src/engine/` on 2026-11-10 and blob-verified
against their source repo (see Proven).

## Install + example

No dependencies. From this directory:

```
npm test          # the smoke + auth suites
npm run build     # compiles src/auth/ to dist/auth/
```

The two re-homed primitives carry their own proofs, run from
this directory: `node src/vault/test/proof.mjs` (the Vault,
69/69) and `node src/mail/test/mail_proof.mjs` (mail, 45/45).
The storage contract suite is `npm run test:offline` in
`src/storage/` (35/35).

The one example:

- **cert-incident-command** — `examples/cert-incident-command/`:
  an incident-command app built on this library (signed-in
  roles, a versioned 29Court rule engine bundle judging voice
  reports, state in the one database, credentials held in the
  vault). Run it with `npm run battery` in that directory —
  51/51 on 2026-11-10. Status: **candidate** — its legs are
  proven locally and against the preview stack; it is not live.

## Proven

All counts measured 2026-11-10:

- `npm test` in this directory — **40/40** (smoke + auth).
- Storage contract suite, offline: `npm run test:offline` in
  `src/storage/` — **35/35**.
- `src/engine/` recovery: **113/113** files blob-verified
  against the source repo; the record is
  `src/engine/PROVENANCE.md`, with per-file hashes in
  `src/engine/MANIFEST.json`.
- The example battery above — **51/51**.
- All four packages together: `bash scripts/test-packages.sh`
  from the repo root — 4/4.

## Status

Real:

- `src/vault/` — the secrets vault (Worker `29court-vault`, service-
  binding broker; secrets owned by a named user, AEAD-sealed at rest,
  OAuth-as-primitive), built by the phase program's P1 and re-homed
  here from the packages tree in slice A10 (2026-11-10). Package
  proof 69/69 at this path.
- `src/mail/` — the email primitive (render + 7 v1 templates,
  outbox state machine, Cloudflare + HTTPS-ESP transports),
  built by the phase program's P2 and re-homed here in slice
  A10. Surfaces consume it by vendored byte-copy (the pin
  shape); proof 45/45 at this path.
- `src/auth/` — the one handoff verifier (`verifyHandoff`,
  `requireMember`), built to `dist/auth/` and consumed by the
  Photos surface. Semantics are the accounts issuer's: an
  opaque one-time code, 120-second life, single use,
  server-to-server exchange.
- `src/storage/` — the typed storage port (a storage interface
  plus D1, R2 and in-memory adapters, with its contract suite),
  moved here in slice A3 (2026-11-10); the platform surface
  consumes it from here.
- `src/engine/` — the recovered `create-dillo` TypeScript
  sources (113 files; see Proven).
- `examples/cert-incident-command/` — the one example, at
  candidate status.
- `legacy/create-dillo/` — the archived studio package (app +
  compiled dist + its permissions record and proof), re-homed
  here in slice A10. Provenance only: never extended, excluded
  from the public face and from any sync set.
- This package definition (`package.json`), the sync manifest
  and the license-pending note.

Absorbed: none outstanding — slice A10 completed the absorption
(the vault, mail, and the legacy archive above).

Missing:

- A live example — the one example is a candidate, proven
  locally and on the preview stack, not live.
- A license decision — pending, below.

## License + sync boundary

License: PENDING — see `LICENSE-PENDING.md`; the license is the
owner's publishing decision. Sync boundary: this directory is
synced to a public repo by its owner; private siblings are not
part of it.
