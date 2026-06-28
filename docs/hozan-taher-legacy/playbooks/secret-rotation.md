# Secret Rotation Playbook

> **Created**: 2026-04-25 (BF-G2)
> **Audience**: Operator (Tomáš + delegates).
> **Scope**: per-secret rotation procedure + blast-radius assessment.
> **Cadence**: ad-hoc on suspected exposure; quarterly preventive for
> long-lived production tokens.

## Inventory of secrets

| Secret | Where it lives | Consumers | Rotation cost |
|---|---|---|---|
| `OUTREACH_API_KEY` | Railway env (`outreach-dashboard`, `orchestrator`) | BFF↔Go auth, IPC between services | LOW — change both, redeploy |
| `ANTI_TRACE_RELAY_TOKEN` | Railway env (BFF + relay) | BFF→relay `/v1/submit` auth | LOW — coordinated redeploy |
| `MAILBOX_PASSWORD_KEY` | Railway env (BFF) | pgcrypto column-level encryption (S5) | **HIGH** — re-encrypt all rows |
| `SENTRY_AUTH_TOKEN` | Railway env (BFF + Go services) | Sentry source-map uploads | LOW — CI rebuild |
| `SENTRY_DSN` | Railway env | Runtime error reporting | NIL — public-by-design |
| `DATABASE_URL` | Railway internal | All services | **HIGH** — Railway-coordinated |
| Mailbox app passwords (per Seznam mailbox) | Postgres `outreach_mailboxes.password` (encrypted) | sender/IMAP poller | MEDIUM — per-mailbox, breaks send window |

> Mailbox app passwords are NOT environment variables — they live encrypted in
> the DB. See [memory: feedback_mailbox_passwords_via_db.md] for the rule.

## Rotation procedure — by secret

Each procedure has the same shape: announce → rotate → verify → audit-log.

---

### `OUTREACH_API_KEY`

**Blast radius**: BFF↔Go authentication. Stale value → 401s on `/api/daemons`,
`/api/campaigns`, `/recalc`. Public users unaffected.

```
1. Generate new key: `openssl rand -hex 32`
2. Railway dashboard → outreach-dashboard service → Variables
   → set OUTREACH_API_KEY=<new>
3. Railway dashboard → orchestrator service → Variables
   → set OUTREACH_API_KEY=<same new>
4. Trigger redeploy of BOTH services (Railway does this automatically
   on env change but verify via deploy log).
5. Verify: `curl -H "X-API-Key: <new>" https://api.../health` → 200.
6. Verify: dashboard /api/daemons returns data within 60s (read-through cache
   eviction is fast).
7. Audit log: append a manual `INSERT INTO operator_audit_log` row with
   action='secret_rotated', entity_type='env', entity_id='OUTREACH_API_KEY'.
```

**Rollback**: revert env var on both services to the previous value.

---

### `ANTI_TRACE_RELAY_TOKEN`

**Blast radius**: BFF (sender path) + anti-trace relay must agree. Stale →
sends fail with `ErrAntiTraceHTTPStatus` (relay 401). Receiving side won't
deliver until rotation completes.

```
1. Generate new: `openssl rand -hex 32`
2. Update on RELAY service first (Railway env), redeploy.
3. Update BFF env (ANTI_TRACE_RELAY_TOKEN), redeploy.
4. Briefly during the rotation window, in-flight sends fail; the engine's
   per-mailbox circuit breaker may open. Reset via API:
     POST /api/mailboxes/release-hold?address=<each active mailbox>
5. Verify: pnpm send a test email; expect 200 from relay.
6. Audit log row.
```

**Rollback**: revert on relay first, then BFF.

---

### `MAILBOX_PASSWORD_KEY` (pgcrypto KEK)

**Blast radius**: all encrypted mailbox passwords become undecryptable.
This is the most expensive rotation in the system.

> **Do NOT rotate this in isolation** — follow [S5-mailbox-encryption.md](S5-mailbox-encryption.md)
> Phase 4 procedure which co-ordinates re-encryption.

```
0. PRECONDITION: Phase 4 of S5 plan is implemented and tested in staging.
1. Pause all sending: `UPDATE outreach_mailboxes SET status='paused', status_reason='manual: KEK rotation'`.
2. Generate new KEK: `openssl rand -hex 32`.
3. Run re-encrypt script:
   `MAILBOX_PASSWORD_KEY_OLD=<old> MAILBOX_PASSWORD_KEY_NEW=<new>
    pnpm tsx scripts/migrations/rotate-mailbox-kek.ts --execute`
4. After verification (sample decrypt with new key works on every active row),
   set `MAILBOX_PASSWORD_KEY=<new>` in Railway, redeploy.
5. Resume mailboxes in batches of 5 with smtp_check between each batch.
6. Audit log row referencing the migration script + rows affected.
```

**Rollback**: re-run the script with OLD/NEW swapped (it's idempotent on
already-decrypted-with-old-key rows). Coordinate via on-call.

---

### `SENTRY_AUTH_TOKEN`

**Blast radius**: source-map uploads at deploy time (no runtime impact).

```
1. Sentry dashboard → Settings → Auth Tokens → Create new (scope: org-write).
2. Update Railway env on each consuming service.
3. Trigger a redeploy; check sentry-cli output in build log for "uploaded
   N source maps".
4. Revoke the old token in Sentry dashboard.
5. Audit log row.
```

**Rollback**: not applicable — fall forward by re-issuing.

---

### `SENTRY_DSN`

Public-by-design (it shows up in Sentry browser SDK). Rotation not security-
sensitive but is supported via the same env-var update + redeploy. Most
operators will never need to rotate this.

---

### `DATABASE_URL`

**Blast radius**: every service. Railway manages this internally; rotation
is a Railway-side operation (regenerate connection string).

```
1. Railway dashboard → Postgres service → Settings → Reset password.
2. Railway propagates the new DATABASE_URL to all linked services
   automatically.
3. Trigger sequential redeploy of all consumers (BFF, orchestrator, relay,
   privacy-gateway, mcp). Postgres holds existing connections until they
   close, so live tx don't break — but new connections after the change
   will fail until the consumer redeploys.
4. Verify via `pnpm report` — pipeline + replies probes.
5. Audit log row.
```

**Rollback**: not directly — Railway only stores the current URL. Have a
support ticket open before rotating in production.

---

### Mailbox app passwords (per Seznam mailbox)

**Blast radius**: per-mailbox sending. Stale → SMTP 535 auth_fail; the
per-mailbox circuit breaker (BF-E2) trips after 3 attempts and pauses
the mailbox.

```
1. Operator generates a new app password in Seznam.cz UI for the mailbox.
2. Dashboard → Mailboxes → <mailbox> → Update Password (writes encrypted
   to DB; never via env).
3. Engine.ResetMailboxBreaker(<address>) is called automatically by the
   update endpoint — sender resumes immediately, no 30 min cooldown wait.
4. Verify next send result via /api/mailboxes/<id>/full-check?force=1.
5. Audit log row written by the password-update endpoint.
```

**Rollback**: revert via the same UI flow with the previous password.

## Quarterly preventive rotation

For long-lived tokens (everything in the table EXCEPT the mailbox app
passwords and DATABASE_URL), schedule a calendar reminder for the first
Monday of each quarter:

```
Q1: 2026-01-05  Q2: 2026-04-06  Q3: 2026-07-06  Q4: 2026-10-05
```

Order of rotation (least → most blast radius):

1. `SENTRY_AUTH_TOKEN`
2. `OUTREACH_API_KEY`
3. `ANTI_TRACE_RELAY_TOKEN`
4. (Skip `MAILBOX_PASSWORD_KEY` and `DATABASE_URL` — heavy, ad-hoc only.)

Document each rotation as an audit-log row + a one-line summary in
`docs/handoff/BOARD.md`.

## On suspected exposure

If a secret may have leaked (commit history, accidental Slack post,
support-ticket screenshot), rotate **immediately** — do not wait for
the next quarterly window. Treat the previous value as compromised
even if you have not seen abuse: log search lags real-world abuse by
hours.

After rotation, do a [SECRET-HYGIENE-SWEEP.md](SECRET-HYGIENE-SWEEP.md)-style
repo grep to confirm no other place referenced the leaked value.

## Records

| Date | Secret | Reason | Operator |
|---|---|---|---|
| 2026-04-25 | playbook drafted | initial creation | Claude |
| | | | |
