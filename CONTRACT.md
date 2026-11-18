# CONTRACT — dillo

The library: auth, storage, vault, mail, and the recovered engine
sources, as typed primitives other packages consume. Imports nothing
in-repo (`AGENTS.md`, `PACKAGES.md`).

- **Sensitivity:** internal. This package contains the Vault (secrets
  custody) — treat every path under `src/vault/` as custody-grade.
- **Verified against:** `package.json` (`exports`, 2026-11-10),
  `src/` tree, `env/test.json` worker blocks `vault` + `demo-chatbot`.

## Public exports

`package.json` declares exactly one export today:

| Export | Types | Runtime |
|---|---|---|
| `dillo/auth` | `./dist/auth/index.d.ts` | `./dist/auth/index.js` (built by `build.mjs` from `src/auth/index.ts`) |

`dillo/auth` surface (from `dist/auth/index.d.ts`): handoff constants
(`HANDOFF_CODE_TTL_MS`, `HANDOFF_EXCHANGE_PATH`, `ACCOUNTS_ORIGIN`),
session constants (`SESSION_ABSOLUTE_MS`, `SESSION_IDLE_MS`,
`SESSION_TOUCH_MS`), `sha256Hex`, `timingSafeEqual`,
`resolveHandoffSecret` / `handoffSecret`, and the `HandoffEnv` /
`D1Like` structural types. Surfaces verify accounts handoffs through
this entry — never by re-implementing the exchange.

Everything else in `src/` is **not** a package export; it is consumed
by being deployed or bundled from its home, and that is the contract:

- `src/vault/` — the Vault Worker (`worker.mjs`) plus its library
  modules (`src/vault/src/`). Consumed over HTTP / service binding by
  callers holding a Vault grant; the OAuth primitive (authorize →
  code catch → token exchange → per-user sealed token → auto-refresh)
  lives here, provider registry in `src/vault/src/providers.mjs`
  (the `test` provider points at the preview Mock OAuth fixture).
- `src/mail/` — Dillo Mail (`mail.mjs`, deployed by its own
  `deploy.py`): the outbox writer every surface's mail goes through.
- `src/storage/` — the storage contract (own `package.json`, own
  offline test: `npm run test:offline` in `src/storage/`).
- `src/engine/` — recovered engine sources (provenance in
  `src/engine/PROVENANCE.md` / `MANIFEST.json`). Reference material
  for the runtime, not a consumable API.

## Events emitted (typed)

None. Dillo is a library plus two deployed services (Vault, Mail); it
emits no broker events. Its observable side effects are rows it owns:
Vault access is recorded in `dillo_secret_access_log`, mail in
`dillo_mail_outbox` (statuses include the capture path's
`no_mailer` — the test/preview mail sink).

## Events consumed

None. The Vault and Mail workers are request/response services.

## Tables owned

Vault schema (`src/vault/schema.sql`, applied by the vault deploy /
preview stand-up; the Worker never runs DDL):

- `dillo_secrets`, `dillo_secret_keys`, `dillo_secret_access_log`,
  `dillo_oauth_states`, `dillo_oauth_refresh_locks`,
  `dillo_secret_rotations`, `dillo_vault_grants`

Mail schema (`src/mail/schema.sql`):

- `dillo_mail_outbox`

## Bindings required (names only — never values)

Vault Worker (per `env/test.json` block `vault`; preview names are
the `preview-*` equivalents enforced by `ops/preview/stand_up.py`):

| Binding | Type | Notes |
|---|---|---|
| `DB` | D1 | the shared product D1 for the stage |
| `VAULT_KEK` | Secrets Store secret | the Vault master key; provisioning it is an owner-only act |

Mail: deployed against the same stage D1 (`DB`); transport is the
stage's configured mail path (capture in test/preview).

## What you may not import from here

- No deep imports into `src/vault/src/` internals from other
  packages: the Vault is reached through its Worker API with a grant,
  so a caller never sees a refresh token or a client secret.
- No importing `src/engine/` as a runtime dependency — it is
  recovered source under provenance, not the shipping runtime.
- Never copy the handoff/session logic out of `dillo/auth` into a
  surface; consume the export.
