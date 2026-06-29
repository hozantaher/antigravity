# Live Deployment Report

**Date:** 2026-04-03
**Platform:** Railway
**URL:** https://anti-trace-relay-production.up.railway.app
**Mode:** deaddrop, PLAIN_HTTP (Railway terminates TLS)

## Deployment

- Railway project: `anti-trace-relay`
- Docker build: multi-stage, alpine, ~41s build time
- Health check: `/healthz` passing
- Env vars: 13 configured (encryption keys, API token, delivery mode)

## Live Test Results

### API Test

| Check | Result |
|-------|--------|
| `GET /healthz` | `{"status":"ok"}` |
| `POST /v1/submit` | `env_4311c9...` created, status=sealed, 512B |
| `GET /v1/status` | pending_envelopes visible |
| `GET /v1/audit-events` | intake_accepted + relay_scheduled |
| Dead drop POST/GET | Posted + polled successfully |

### Full Amnesic E2E (submit binary -> Railway -> receive binary)

```
Passphrase: live-amnesic-14585ec9a60f
Recipient key: cfdac3b1ece309396a6cc814c2c32e2540bae49481e9617eabc011761644e769

Submit:  PBKDF2 600K derivation -> X25519 seal -> pad -> POST /v1/drop/{slotID}
         "Submitted successfully." (exit 0)

Receive: PBKDF2 600K derivation -> same SlotID -> GET /v1/drop/{slotID} -> X25519 open -> unpad
         "1 message(s) received:" (exit 0)

Content match: EXACT
```

**Message traveled:**
1. Client (macOS) derives keys from passphrase (28s PBKDF2)
2. Encrypts with X25519+HKDF+AES-256-GCM
3. Pads to 512B size class
4. POST to Railway relay dead drop over HTTPS
5. Receiver derives same slot from same passphrase
6. GET from Railway relay dead drop over HTTPS
7. Decrypts with derived private key
8. Displays original plaintext

**Zero files left on either client device after submit/receive.**

## Configuration

```
DELIVERY_MODE=deaddrop
TRANSPORT_MODE=lab
PLAIN_HTTP=true
EMISSION_INTERVAL_SECONDS=5
MIX_POOL_MIN_SIZE=5
RATE_LIMIT_PER_MINUTE=20
AUDIT_RETENTION_HOURS=168
RELAY_RETENTION_HOURS=48
```

## What This Proves

- Full pipeline works over public internet (not just localhost)
- PBKDF2 derivation + X25519 encryption + dead drop roundtrip is production-viable
- Railway PaaS deployment is functional for the relay service
- Amnesic client binaries work against remote relay without any persistent state
- TLS termination by Railway proxy is transparent to the application
