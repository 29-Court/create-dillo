# Agent Bridge enrollment (v0)

Dedicated claim-ticket + enroll/intents/inbox surface for **enroll-build-001**.

**Does not** overload library `/v1/tickets` (optional expiry / unbound holder — Detail M1).

## Routes
| Method | Path | Role |
|--------|------|------|
| GET | `/join/:token` | Public enriched markdown `pending-enroll` |
| POST | `/v1/enroll/tickets` | Owner issues claim ticket (sandbox may echo token once) |
| POST | `/v1/enroll` | Owner-approve redeem → scoped-cred (once) |
| POST | `/v1/intents` | Enrolled agent → `{ job_id }` |
| GET | `/v1/inbox` | Poll inbox (muse-poll / grok-webhook local-queue / generic-manual) |

## Local DEV mount

`LocalArmadilloServer` with `development: true` mounts these via
`handleAgentBridgeLocalRequest` **before** the optional app `requestHandler`
and before the engine (so `/v1/tickets` stays engine-owned).

Auth mapping:
- Owner session cookie or Bearer `arm_session_*` → `ownerId`
- Bearer `abr_*` → `bridgeSecret`
- `sandbox: true` **only** when `ARMADILLO_DEV_MODE=1` (development servers)

Non-development local servers do **not** mount Agent Bridge.

## Claim-ticket rules (Detail binding)
- Single-use; replay → reject
- Default TTL 15m; hard cap 30m; required `expiresAt`
- Bound `agentId` + allowlisted `intent` (`bridge_enroll_v0`); checked on redeem
- Hash-at-rest; plaintext once; no durable secrets in chat/email
- Sandbox/box only; `grok-webhook` queues locally — **no live external send**

## Tests
```bash
npm run build && node --test tests/core/agent-bridge.test.ts tests/core/agent-bridge-local.test.ts tests/core/agent-bridge-local.test.ts
```

## Local curl (DEV server with development: true)
```bash
# after signup token in $TOKEN and server on $ORIGIN
curl -sS -X POST "$ORIGIN/v1/enroll/tickets" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"agentId":"muse-leo","intent":"bridge_enroll_v0","connectorHint":"muse-poll"}'
```
