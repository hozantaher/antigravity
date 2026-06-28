# Security PR Review Pack — 2026-04-30

Operator session pack — 17 security PRs ready for review + merge.

**Cíl:** vyřídit všechny v jedné focused 90-min session. Per PR ~5 min review.

## CRITICAL (4 PRs)

### #161 — S-C1 — fail-closed when HMAC secret missing
- **What:** `features/platform/outreach-dashboard/server.js` — when both `UNSUBSCRIBE_SECRET` and `OUTREACH_API_KEY` unset, signs with empty key. Mass-unsubscribe attack vector.
- **Fix:** new `resolveUnsubscribeSecret()` returns null if both unset → handler refuses with 503 + Sentry capture, NO suppression INSERT, NO contacts UPDATE.
- **Tests:** 10 fail-closed cases (verified GREEN locally).
- **Recommendation:** APPROVE.

### #162 — S-C2 — XFF trusted-proxy gate + leftmost parse
- **What:** XFF header trust without proxy verification = rate-limit bypass.
- **Fix:** explicit `TRUSTED_PROXY_CIDR` allowlist, leftmost valid IP only.
- **Recommendation:** APPROVE. Set `TRUSTED_PROXY_CIDR` env on Railway.

### #166 — F1-1 — segment placeholder offset bug
- **What:** placeholder offset bug silently corrupted segment memberships → wrong contacts in wrong segments.
- **Recommendation:** APPROVE.

### #184 — W2-B — constant-time token compare
- **What:** privacy-mail-gateway uses `==` for token compare → timing oracle.
- **Fix:** `subtle.ConstantTimeCompare`.
- **Recommendation:** APPROVE.

## HIGH (12 PRs)

### #163 — S-H1 — strict DSN parser anti-SSRF
- /sentry-tunnel proxies user DSN; loose parsing allowed SSRF to internal IPs. Strict regex + allowlist. APPROVE.

### #164 — S-H2 — strip raw err.Error() from HTTP responses
- Go handlers leaked DB schema/file paths via raw err.Error(). Sanitize + log server-side. APPROVE.

### #165 — S-H3 — CSP + cross-origin isolation
- Missing CSP. Adds strict CSP + COEP/COOP. Verify dashboard renders post-merge. APPROVE.

### #167 — F1-2 — HMAC timing-safe + trust-proxy + ?limit clamp
- 3 fixes bundled: HMAC timing, trust-proxy header, ?limit DoS clamp. APPROVE.

### #169 — F2-1 — close outreach_threads on link unsub (parity with Go)
- BFF didn't close thread on unsub; Go does. Parity. GDPR Art.17 cascade. APPROVE.

### #170 — F2-2 — drop silent .catch on tracking_events DELETE inside tx
- DSR endpoint had `.catch(() => {})` swallowing tx failures. GDPR-critical. APPROVE.

### #171 — F2-3 — pin sql.Conn for advisory-lock lifetime
- Lock taken on Conn A, work done on Conn B → duplicate-send risk. APPROVE.

### #172 — F2-4 — AbortSignal/timeout on BFF→Go fetches
- BFF→Go without timeout → BFF hangs. APPROVE.

### #173 — F3-1 — feed Backpressure on IMAP-DSN bounces
- IMAP hard bounces don't trigger backpressure → Seznam reputation. APPROVE.

### #174 — F3-2 — /run flips status only; remove silent no-op
- /run had silent no-op fallback flipping status without start. APPROVE.

### #175 — F3-3 — anti-trace empty envelope_id is typed error
- Empty envelope_id silently → DSN dedupe broken. Typed error fix. APPROVE.

### #178 — F5-2 — pq.Array swap fixes IN-scalar SQL injection
- SQL IN with raw array literal = injection. `pq.Array()` parameterization. APPROVE.

## MEDIUM (1 PR)

### #180 — F5-3 — auth-matrix ENABLED-side contract
- Missing positive-side test for auth matrix. APPROVE.

## Recommended approval

All 17 PRs APPROVE. None can be deferred without leaving security holes.

## Estimated session

- 17 PRs × 4-5 min = 70-85 min
- + 5 min audit log
- = **75-90 min total**

## Post-merge verification

- Set `TRUSTED_PROXY_CIDR` env on Railway (for #162)
- Verify dashboard renders post-CSP (for #165) — `curl -I` expects strict CSP header
- Run `pnpm build` locally, no errors expected

## Audit format

Append per merge to `docs/audits/admin-merges.jsonl`:
```json
{"ts":"2026-04-30T...","pr":N,"tier":"C","reason":"security gate, operator approved","reviewer":"operator","local_tests":"...","operator_approved":"Tomáš direct"}
```
