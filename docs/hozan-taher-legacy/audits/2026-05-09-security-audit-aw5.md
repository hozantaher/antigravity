# Security Audit Report — Sprint AW5
**Date:** 2026-05-09  
**Status:** Complete (read-only)  
**Trigger:** Post-campaign-457-misfire safety roundup  
**Scope:** 8 security areas across monorepo

---

## 1. Mailbox Password Storage
**Status:** OK

- Passwords stored encrypted in `outreach_mailboxes.password` (pgcrypto)
- No MAILBOX_N_PASSWORD env vars in active code paths
- `features/platform/common/config/config.go` contains backward-compat references (test fixture legacy only)
- Rotation procedure documented: `docs/playbooks/secret-rotation.md` (section "Mailbox app passwords")
- KEK rotation (MAILBOX_PASSWORD_KEY) requires phase-4 re-encryption script (Sprint S5)

**Finding:** None — rule enforced. Per-mailbox passwords never read from environment.

---

## 2. API Key Rotation (OUTREACH_API_KEY)
**Status:** OK, documented

- Read in `features/inbound/orchestrator`, `features/platform/outreach-dashboard` (2 services)
- Rotation playbook: `docs/playbooks/secret-rotation.md` (pp. 30–48)
- Quarterly schedule: Q2 due 2026-04-06 (no record found yet; overdue by ~30 days)
- Blast radius: BFF↔Go auth, `/api/daemons` + `/api/campaigns` endpoints
- Rollback: documented as revert both services + redeploy

**Finding:** Quarterly rotation overdue by 1 month. Recommend immediate 2026-05 rotation.

---

## 3. HMAC Token Keys
**Status:** OK

- Unsubscribe tokens: `features/platform/common/token/token.go` — canonical HMAC-SHA256
- Wire format: `HMAC(secret, "<cid>|<id>|<email>") → hex[:16]`
- Test coverage: both sides locked by test suites (`sentry_test.go`, `token_test.go`)
- Token rotation: tokens are stateless; no DB key rotation required
- No hardcoded keys in codebase (all env-sourced)

**Finding:** None — implementation sound.

---

## 4. GDPR Data Subject Requests (DSR)
**Status:** OK, with audit trail

- Handler: `features/platform/outreach-dashboard/src/server-routes/dsr.js` (lines 1–120+)
- Article 15 (access): 11 tables queried in parallel
- Article 17 (erasure): cascade delete across contacts, send_events, reply_inbox, tracking_events, suppression tables
- Rate limiting: 10 req/min per IP (line 31, `_dsrAllow`)
- Audit logging: each access written to `operator_audit_log` + `channel_audit_log` (Art. 30 ROPA)
- Test coverage: `tests/audit/gdpr-cascade-shape.test.js` + `tests/contract/bff-dsr.contract.test.ts`

**Finding:** None — compliant. Cascade tested; no PII leakage in error messages.

---

## 5. Release Tag & Sentry Tracking
**Status:** OK

- `features/platform/common/telemetry/sentry.go:BuildReleaseTag(service)` — constructs `<service>@<sha>`
- SHA source priority: `GIT_SHA` → `RAILWAY_GIT_COMMIT_SHA` → `SOURCE_COMMIT` → `unknown`
- Every Go service calls `telemetry.Init(serviceName)` at boot
- Test coverage: 5 test cases in `sentry_test.go` (all scenarios)
- BFF Sentry integration: wired via `wrapPoolWithBreadcrumbs` + sentryTagMiddleware

**Finding:** None — all Go services have release tag. No drift detected in recent deploys.

---

## 6. Content Security Policy & Headers
**Status:** OK, strict

**CSP (line 137–143 in `server.js`):**
```
default-src 'none'
style-src 'unsafe-inline'
base-uri 'none'
frame-ancestors 'none'
form-action 'self'
```

**Additional headers (lines 149–150+):**
- `X-Content-Type-Options: nosniff`
- (Implicitly trusts Cloudflare/Railway for HSTS, X-Frame-Options upstream)

**Finding:** CSP strict-by-default. No unsafe-script, no unsafe-eval. Unsubscribe/DSR endpoints hardened correctly (inline style only, no external resources).

---

## 7. Mullvad Endpoint Reputation (wgpool)
**Status:** OK, operational

- Implementation: `features/outreach/relay/internal/transport/wgpool/pool.go`
- Quarantine logic: 3 consecutive failures → 5-minute quarantine (line 55–56: `QuarantinedUntil`)
- Health struct (lines 50–59): tracks `LastOK`, `LastFail`, `ConsecutiveFail`, quarantine state
- Audit ratchet: `wgpool_audit_test.go` — only wgpool constructs SOCKS5Transport to 127.0.0.1:108x
- Exposure endpoints: `/v1/proxy-pool` + `/v1/egress-debug` show active/quarantined counts

**Finding:** None — pool manager operational. No stale endpoints observable in recent deploys.

---

## 8. Per-Mailbox Operation Rate Limits
**Status:** OK, atomic

- Implementation: `features/platform/outreach-dashboard/src/lib/mailboxOpRateLimit.js`
- Caps table:
  - `imap_poll`: 12/hour
  - `imap_inbox_fetch`: 6/hour
  - `full_check`: 2/hour
  - `smtp_probe`: 12/hour
  - `verify_email`: 5/hour
- Atomicity: FOR UPDATE row lock + single transaction (lines 44–80)
- Race fix (P2): check lock acquired row before insert to detect deleted mailbox
- HTTP response: 429 + `Retry-After` header
- Cleanup: daily 03:00 Prague — purge rows >7 days old

**Finding:** None — all gates enforce caps. No bypass vectors.

---

## Summary

| Area | Status | Risk | Action |
|------|--------|------|--------|
| Passwords | OK | None | Continue DB-only enforcement |
| OUTREACH_API_KEY | OK | LOW | Rotate immediately (1 month overdue) |
| HMAC tokens | OK | None | No action needed |
| DSR (GDPR) | OK | None | Audit trail complete |
| Release tags | OK | None | All services tagged |
| CSP/Headers | OK | None | Strict-by-default; good |
| wgpool | OK | None | Operational |
| Rate limits | OK | None | Atomic; no race conditions |

---

## Recommendations (Prioritized)

1. **HIGH:** Rotate OUTREACH_API_KEY this week (overdue Q2 baseline)
2. **MEDIUM:** Document DSR runbook location in operator handbook
3. **MEDIUM:** Verify wgpool quarantine behavior in staging after Mullvad config change
4. **LOW:** Add HSTS header explicitly at origin (currently delegated to upstream CDN)

---

## Audit Notes

- No secrets found in codebase (env-only sourcing verified)
- No hardcoded API keys or tokens in grep results
- Password env var references are test fixtures only (config_test.go)
- SENTRY_DSN is public-by-design (expected)
- All rate-limit gates are database-backed with atomic transactions
- No fabricated test data detected in audit (real migration paths only)

**Conclusion:** Hozan-Taher monorepo follows defense-in-depth principles. No CRITICAL findings. Rotate OUTREACH_API_KEY and proceed.
