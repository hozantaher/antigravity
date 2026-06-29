# Deep Security Audit — MVP Readiness

**Status:** Complete  
**Date:** 2026-05-05  
**Auditor:** Claude (claude-sonnet-4-6) via agent worktree `agent-aea7d9aa05e7ed84a`  
**Scope:** services/{orchestrator,relay,campaigns,common,contacts,inbox,mailboxes,privacy-gateway,llm-runner,operator-practice}, features/platform/outreach-dashboard/src + server.js, scripts/audits + migrations + launch, modules/outreach  

---

## Executive Summary — Top 3 Must-Fix Before MVP

1. **CRITICAL — Timing side-channel on API key comparison (BFF + llm-runner)**: `authMiddleware.js` compared API keys with `!==` (plain string equality). An attacker with sub-millisecond response-time measurement could recover the key byte-by-byte. Fixed in this PR with `crypto.timingSafeEqual`. The same flaw existed in `features/platform/llm-runner/cmd/llm-runner/main.go` (fixed with HMAC-SHA256, matching `orchestrator/web/auth.go` pattern).

2. **HIGH — PII logged in plaintext to stdout (server.js)**: Contact email addresses were emitted to `console.log` at two production code paths — `[automation] suppressed ${email}` (line 4298) and `[cron] daily report sent to ${email}` (line 4523). Fixed in this PR.

3. **HIGH — Vulnerable `axios` dependency in `features/platform/mcp` (4 CVEs, all HIGH)**: `services__mcp > typesense > axios` is pinned at a version below `1.15.2`. Vulnerabilities: prototype pollution read-side gadgets (credential injection + request hijacking, GHSA-pmwg-cvhr-8vh7, GHSA-q8qp-cvcw-x6jj, GHSA-pf86-5x62-jrwf, GHSA-6chq-wfr3-2hj9), plus NO_PROXY bypass via RFC-1122 loopback subnet. GH issue filed — fix: bump `typesense` to a release that ships `axios >= 1.15.2`.

---

## 1. Hardcoded Secrets

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/platform/outreach-dashboard/.env` | — | INFO | `.env` present in worktree but correctly listed in `.gitignore`. `git log -- .env` shows no prior commit. | No action. |
| All `*.go`, `*.ts`, `*.js` in scope | — | — | No `apiKey = "..."`, `password = "..."`, `secret = "..."`, `Bearer <literal>`, `AKIA*`, or `sk-` patterns found in production code. | ✓ no issues found |

**Verdict:** ✓ no hardcoded secrets.

---

## 2. SQL Injection

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/acquisition/contacts/category/store.go` | 314–318 | INFO | Uses `fmt.Sprintf` to build `$2,$3,...` placeholder list; user data flows only into `args` slice, not into SQL string. | ✓ safe |
| `features/outreach/campaigns/campaign/runner.go` | 801 | INFO | Uses `fmt.Sprintf` to compose parameterized `$N` WHERE clauses; all user values are bound as args. | ✓ safe |
| `features/platform/outreach-dashboard/src/server-routes/crm.js` | 92, 107–112 | INFO | `whereClause` is assembled from `conds[]` where every user value uses `$N` parameterization. `sort` and `dir` are resolved through safe ternaries to column literals. | ✓ safe |
| `features/platform/outreach-dashboard/src/server-routes/companies.js` | 58–123, 133 | INFO | `buildCompaniesWhere` uses `$N` params throughout. `makeAutocompleteHandler` `column` is hardcoded at call site (not user input). `icp`/`size` values are passed as params to `ANY($N::text[])`, not interpolated. | ✓ safe |
| `features/platform/outreach-dashboard/src/server-routes/campaigns.js` | 539–550 | INFO | `where` is built parameterized. | ✓ safe |
| `features/platform/outreach-dashboard/tests/unit/legacy/race.matrix.test.js` | 33–34 | LOW | Template-literal DELETE in test teardown using constant probe tag. Not production code; risk is nil since test DB is ephemeral. | Test-only; acceptable. |

**Verdict:** ✓ no exploitable SQL injection found in production code.

---

## 3. Audit Gap (operator_audit_log)

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/platform/outreach-dashboard/src/server-routes/mailboxes.js` | 206 | MEDIUM | `DELETE /api/mailboxes/:id` executes a hard delete with no `operator_audit_log` INSERT. A mailbox deletion is irreversible and high-impact. | File GH issue. Add audit INSERT before DELETE. |
| `features/platform/outreach-dashboard/src/server-routes/campaigns.js` | 712 | MEDIUM | `DELETE /api/campaigns/:id` has no `operator_audit_log` INSERT. Campaign hard-delete. | File GH issue. |
| `features/platform/outreach-dashboard/src/server-routes/templates.js` | 173 | MEDIUM | `DELETE /api/templates/:id` has no `operator_audit_log` INSERT. | File GH issue. |
| `features/platform/outreach-dashboard/src/server-routes/campaigns.js` | 432, 860 | ✓ | Campaign create + status change are audit-logged. | OK |
| `features/platform/outreach-dashboard/src/server-routes/crm.js` | 426, 474 | ✓ | CRM create/update logged. | OK |
| `features/platform/outreach-dashboard/src/server-routes/dsr.js` | 115, 272 | ✓ | GDPR access + erasure logged. | OK |
| `features/platform/outreach-dashboard/src/server-routes/unsubscribe.js` | 184 | ✓ | Unsubscribe logged. | OK |
| `features/platform/outreach-dashboard/src/server-routes/replies.js` | 256 | ✓ | Reply classification logged. | OK |
| Automation mutations in `server.js` (proxy_url updates, auth_fail_count, etc.) | 2650, 2759, 2807 | LOW | Internal automation-driven UPDATE paths have no audit log entry. These are cron-driven, not operator-triggered, so the risk is lower. | Acceptable for MVP; note in tracker. |

---

## 4. PII Redaction

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/platform/outreach-dashboard/server.js` | 4298 | **CRITICAL** | `console.log(\`[automation] suppressed ${contactRows[0].email} (negative reply)\`)` — full email address in stdout. | **Fixed in this PR** — replaced with `contact_id=N`. |
| `features/platform/outreach-dashboard/server.js` | 4523 | HIGH | `console.log(\`[cron] daily report sent to ${cfgMap.report_recipient_email}\`)` — operator email in stdout. | **Fixed in this PR** — email address removed. |
| `features/platform/outreach-dashboard/src/server-routes/mailboxes.js` | 187 | INFO | `console.log('[patch] mailbox', id, 'fields:', [...usedCols, ...])` — logs field names but NOT values. Password field printed as the string `'password'` only when included. | Acceptable. No PII leaked. |
| `features/acquisition/contacts/enrichment/pipeline.go` | 432, 459 | ✓ | Uses `audit.MaskEmail()`. | OK |
| `features/acquisition/contacts/enrichment/suppress.go` | 65 | ✓ | Uses `audit.MaskEmail()`. | OK |
| `features/outreach/mailboxes/bounce/processor.go` | 185, 240 | ✓ | Uses `audit.MaskEmail()`. | OK |

---

## 5. Authentication Bypass

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/platform/outreach-dashboard/src/lib/authMiddleware.js` | 36 | **CRITICAL** (timing) | `headerKey !== key` is a plain JavaScript strict-equality compare. Measurable timing difference when strings share a long common prefix. | **Fixed in this PR** — replaced with `crypto.timingSafeEqual`. |
| `features/platform/llm-runner/cmd/llm-runner/main.go` | 172 | **CRITICAL** (timing) | `got != apiKey` — plain Go string compare. Comment claimed it matched the constant-time pattern but implementation was naive `!=`. | **Fixed in this PR** — replaced with HMAC-SHA256 (matching `orchestrator/web/auth.go`). |
| `features/platform/outreach-dashboard/server.js` | 263 | INFO | `mountPrivacyRoutes` mounts BEFORE `createAuthMiddleware()`. Intentional — `/privacy` is a public GDPR notice. | ✓ by design |
| `features/platform/outreach-dashboard/server.js` | 340–368 | INFO | `mountUnsubscribeRoutes`, `mountDsrRoutes`, `mountMorningReadinessRoutes`, `mountAnonymityRoutes`, `mountBulkPasswordRoute`, `mountTemplatePreviewRoute` all mount AFTER line 338 (`app.use(createAuthMiddleware())`). | ✓ all gated |
| `features/inbound/orchestrator/web/server.go` | 78–80 | INFO | `/o` (open pixel), `/c` (click redirect), `/healthz` are unauthenticated. Intentional — pixel/redirect must be accessible to email clients; health check for Railway probe. | ✓ by design |
| `features/inbound/orchestrator/web/server.go` | 83 | INFO | `/metrics` (Prometheus) unauthenticated. Standard Railway/internal-network pattern; acceptable if not exposed publicly. | LOW — note for production network policy review |
| `features/compliance/privacy-gateway/internal/auth/static.go` | 55–62 | ✓ | `subtle.ConstantTimeCompare` used, walks all entries unconditionally. | Exemplary |
| `features/inbound/orchestrator/web/auth.go` | 43–53 | ✓ | HMAC-SHA256 constant-time compare. | OK |

---

## 6. CORS

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/platform/outreach-dashboard/server.js` | 149–160 | ✓ | `CORS_ORIGIN` env var (default `http://localhost:18175`). No wildcard `*`. `origin()` callback allows only whitelisted origins. | ✓ no issues found |

---

## 7. Rate Limiting

| Finding | Severity | Fix |
|---------|----------|-----|
| `createRateLimitMiddleware()` at line 337 applies globally to all routes (100 req/min/IP default). High-burst prefix `/api/mailboxes` gets 60 req/min. | ✓ | — |
| `/api/health` prefix is rate-limit exempt. | ✓ acceptable | — |
| `mountDsrRoutes` and `mountUnsubscribeRoutes` mount after the global rate limiter. Both have additional per-IP 10/min enforcement inside the route module. | ✓ double-gated | — |
| Prometheus `/metrics` is not rate-limited. Acceptable for internal-network endpoint. | LOW | File GH note. |

**Verdict:** ✓ Rate limiting is in place for all operator-facing endpoints.

---

## 8. CSP / Security Headers

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/platform/outreach-dashboard/server.js` | 122–145 | ✓ | `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` + `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` + `Referrer-Policy: strict-origin-when-cross-origin` + `Permissions-Policy` + `Strict-Transport-Security` + `COOP: same-origin` + `CORP: same-origin`. | ✓ no issues found |

`style-src 'unsafe-inline'` is intentional and documented — the BFF only serves the unsubscribe HTML page which uses inline `<style>`.

---

## 9. Dependency Scan

| Package | CVE / Advisory | Severity | Path | Fix |
|---------|---------------|----------|------|-----|
| `axios < 1.15.1` | GHSA-pmwg-cvhr-8vh7 (NO_PROXY bypass via 127.0.0.0/8) | HIGH | `services__mcp > typesense > axios` | Bump `typesense` to release shipping axios ≥ 1.15.2 |
| `axios < 1.15.2` | GHSA-q8qp-cvcw-x6jj (prototype pollution — credential injection + request hijacking) | HIGH | `services__mcp > typesense > axios` | Same |
| `axios < 1.15.1` | GHSA-pf86-5x62-jrwf (prototype pollution — response tampering + data exfiltration) | HIGH | `services__mcp > typesense > axios` | Same |
| `axios < 1.15.1` | GHSA-6chq-wfr3-2hj9 (header injection via prototype pollution) | HIGH | `services__mcp > typesense > axios` | Same |
| Various | 24 MODERATE, 2 LOW findings | MOD/LOW | Transitive deps in dashboard monorepo | Review separately; none in direct-BFF path. |

**Note:** The `axios` vulnerability is in `features/platform/mcp` (Typesense client), not in the BFF or campaign pipeline. `mcp` is a context-indexing service; exploitation requires crafted Typesense responses. Risk is elevated if the Typesense instance is not isolated on the internal Railway network.

---

## 10. Cryptographic Review

| File | Line | Severity | Finding | Fix |
|------|------|----------|---------|-----|
| `features/outreach/campaigns/sender/engine.go` | 21, 36 | INFO | `math/rand` imported as `mrand` for `poissonDelay()` jitter. Annotated `//nolint:gosec // non-security use`. Delay jitter is not security-sensitive. | ✓ acceptable |
| `features/outreach/campaigns/content/spin.go` | 4, 13 | INFO | `math/rand` used with seeded RNG for deterministic spin resolution (same contact+step → same variant). Not security-sensitive. | ✓ acceptable |
| `features/outreach/relay/internal/transport/proxy_pool.go` | 503 | INFO | `rand.Shuffle` for proxy list ordering. Not security-sensitive. | ✓ acceptable |
| `features/outreach/relay/internal/transport/bridge/retry.go` | 67 | INFO | `rand.Float64()` for retry jitter. Not security-sensitive. | ✓ acceptable |
| `features/outreach/relay/cmd/relay/main.go` | 886–889 | ✓ | `cryptoJitterDuration` uses `crypto/rand`. | OK |
| `features/outreach/relay/web/raw_smtp_diag.go` | 941–956 | ✓ | Message IDs and nonces use `crypto/rand`. | OK |
| `features/platform/common/token/unsub.go` | 52 | ✓ | `hmac.Equal` for token comparison. | OK |

**Verdict:** ✓ All security-sensitive random operations use `crypto/rand`. `math/rand` uses are exclusively non-security jitter/content selection.

---

## Summary Table

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| A1 | Timing side-channel on API key compare in BFF `authMiddleware.js` | CRITICAL | **Fixed in this PR** |
| A2 | Timing side-channel on API key compare in `llm-runner/main.go` | CRITICAL | **Fixed in this PR** |
| A3 | Contact email logged unredacted in `server.js:4298` | CRITICAL | **Fixed in this PR** |
| A4 | Operator email logged unredacted in `server.js:4523` | HIGH | **Fixed in this PR** |
| B1 | axios 4× HIGH CVEs in `features/platform/mcp > typesense` | HIGH | GH issue filed (#764) |
| B2 | DELETE mailbox/campaign/template without `operator_audit_log` | MEDIUM | GH issue filed (#765) |
| B3 | `/metrics` endpoint unauthenticated on orchestrator | LOW | Acceptable; note for network policy |
| B4 | Automation-driven UPDATE paths without audit log | LOW | Accepted MVP debt |
| C1 | No hardcoded secrets | — | ✓ clean |
| C2 | No SQL injection in production code | — | ✓ clean |
| C3 | CORS configured with explicit allowlist | — | ✓ clean |
| C4 | Rate limiting in place for all operator paths | — | ✓ clean |
| C5 | Security headers (CSP, HSTS, CORP, COOP, etc.) all set | — | ✓ clean |
| C6 | Auth bypass: all operator routes behind `createAuthMiddleware()` | — | ✓ clean |
| C7 | PII masking via `audit.MaskEmail()` in Go services | — | ✓ clean |

---

## GH Issues vs New

| Item | GH Issue |
|------|----------|
| axios HIGH CVEs in features/platform/mcp | **New — #764** (filed as part of this PR) |
| Missing audit_log on destructive DELETE endpoints | **New — #765** (filed as part of this PR) |
| All CRITICAL findings | Fixed inline — no issue needed |
