# Duplicate Audit — 2026-04-30

> Trigger: PR #393 reimplemented `enforceAirtightGate`, parallel to existing
> `SendingConfig.ValidateAirtight`. User asked for a deep cross-monorepo
> sweep so we stop bleeding "I didn't know it existed" duplicates.
>
> Methodology: `git grep` for symbols + AST-style signature inspection on
> functions matching the listed concepts. Each finding cites both call sites
> AND verifies they are reachable from runtime (not dead code). Branch:
> `audit/duplicate-hunt-deep-2026-04-30`. Single commit, report-only.

## CRITICAL duplicates (production behavior at risk)

### 1. Airtight / lab-only boot gate — 2 implementations, BOTH run on every boot
- **Implementation A:** `features/inbound/orchestrator/cmd/outreach/main.go:2891` — `enforceAirtightGate(labOnly, transportMode string) (int, string)`. Exit code **78** on misconfig. Truthy LAB_ONLY: `1|true|TRUE|yes|YES`. Called at `main.go:97` BEFORE config load.
- **Implementation B:** `features/platform/common/config/config.go:151` — `(*SendingConfig).ValidateAirtight() error` returning `*AirtightError{ExitCode 47|48}`. `LoadFromEnv()` parses `LAB_ONLY` via `envBoolOr` (`config.go:387`) which uses `strconv.ParseBool` semantics. Reached via `cfg.Validate()` at `main.go:114`.
- **Status:** BOTH run during `cmd/outreach/main` boot. Truthy semantics differ: A accepts `yes`/`YES`; B's `strconv.ParseBool` accepts `t/T/TRUE/True/1/0/false/False/F/f` but NOT `yes`. So `LAB_ONLY=yes` passes B silently while A rejects with exit 78. Operator runbooks cannot rely on a single exit-code mapping.
- **Merge proposal:** Delete A. Wire main.go:97 to call `cfg.Sending.ValidateAirtight()` after `LoadFromEnv` and translate `*AirtightError.ExitCode` to `os.Exit`. Keep the 47/48 mapping (already documented in ADR-005). `airtight_test.go` in orchestrator becomes redundant — port unique cases (alias forms `yes`/`YES`) into `features/platform/common/config/airtight_test.go`.

### 2. HMAC unsubscribe token — 3 incompatible formats, all live in prod
- **Implementation A:** `features/platform/common/token/token.go:15` — `GenerateUnsubToken(contactID int64, key []byte) string`. Format: `<base64url(8-byte BE payload)>.<base64url(hmac-sha256)>`. Encodes ONLY contactID.
- **Implementation B:** `features/outreach/campaigns/campaign/runner.go:842` — `buildUnsubURL(campaignID, contactID, email)`. HMAC-SHA256 over `"%d|%d|%s"`, `hex.EncodeToString(...)[:16]` (truncated 64-bit). Used by every send tick.
- **Implementation C:** `features/platform/outreach-dashboard/server.js:361` — `createHmac('sha256', secret).update("${c}|${id}|${email}").digest('hex').slice(0,16)`. BFF /unsubscribe handler. Mirrors B.
- **Implementation D (script copies of C):** `features/platform/outreach-dashboard/campaign-send-batch.mjs:40` and `features/platform/outreach-dashboard/dry-run.mjs:33` — same body as C.
- **Status:** B and C/D match by construction (the BFF endpoint is what actually validates production tokens). A is a parallel scheme used by NO production caller — `git grep ParseUnsubToken` returns only its own test file. A is dead.
- **Merge proposal:** **Delete `features/platform/common/token/token.go`** and its test. It is a phantom contract. Move B's token math (`buildUnsubToken(campaignID, contactID, email, secret)`) into `features/platform/common/token/unsub.go`, export a parallel JS helper `features/platform/outreach-dashboard/src/lib/unsubToken.js` so the 3 JS callers (server.js, campaign-send-batch, dry-run) stop redefining the formula.

### 3. `envOr` — 8 redefinitions in Go services (drift risk on env semantics)
- `features/platform/common/config/config.go:354`
- `features/platform/common/telemetry/sentry.go:273`
- `features/platform/mail-lab-api/cmd/mail-lab-api/main.go:89`
- `features/outreach/mailboxes/mailbox/testdb_helper_test.go:60` (test-only, fine)
- `features/platform/operator-practice/cmd/seed-from-prod/main.go:172`
- `features/inbound/orchestrator/cmd/outreach/main.go:2870`
- `features/outreach/relay/cmd/relay/main.go:642`
- `features/outreach/relay/internal/config/config.go:159`
- **Status:** All implementations are textually equivalent today (`os.Getenv` + empty-string fallback) but there is no shared symbol. New caller in `features/acquisition/contacts/...` would inevitably copy-paste a 9th. Adding trim/lowercase semantics later means hunting 8 sites.
- **Merge proposal:** Promote one canonical export — `features/platform/common/envconfig.GetOr(key, fallback string) string` (the package already exists for `MustHave`/`Required`). Delete all 7 non-test private copies.

### 4. `envBoolOr` — 4 redefinitions, 2 different boolean dialects
- `features/platform/common/config/config.go:387` — explicit allow-list (`1|true|yes|on`).
- `features/outreach/relay/cmd/relay/main.go:664` — same allow-list as common/config.
- `features/outreach/relay/internal/config/config.go:190` — uses `strconv.ParseBool` (rejects `yes`).
- `features/compliance/privacy-gateway/internal/config/config.go:120` — `envBoolOrDefault` using `strconv.ParseBool` (rejects `yes`).
- **Status:** privacy-gateway and relay/internal/config silently disagree with relay/cmd/relay and common/config on `LAB_ONLY=yes` and similar values. Already biting in §1 above.
- **Merge proposal:** Single export `envconfig.BoolOr(key string, fallback bool) bool` with documented dialect. Deprecate `strconv.ParseBool` path; pick the `1|true|yes|on` semantics so it matches LAB_ONLY's documented operator-facing alias set.

## HIGH duplicates (developer confusion, behavior may diverge)

### 5. `slog_op_audit_test.go` — 8 copies of the same AST scanner
- 8 files: `services/{campaigns/sender, campaigns/campaign, orchestrator/web, privacy-gateway/internal/httpapi, privacy-gateway/internal/inbox, contacts/enrichment, mailboxes/watchdog, relay/internal/transport}/slog_op_audit_test.go`.
- Verified IDENTICAL byte-for-byte: contacts/enrichment vs mailboxes/watchdog; privacy-gateway/httpapi vs privacy-gateway/inbox.
- Others (sender, campaign, orchestrator/web) drift on the baseline integer + a few comment lines but the AST walker is the same.
- **Merge proposal:** Move `scanSlogOpViolations` into `features/platform/common/audit/slogscan_test.go` as exported test helper, OR (cleaner) create `features/platform/common/auditbuild/slogop` non-test package with the scanner, then each per-package test becomes ~10 lines: `violations := slogop.Scan("."); assertBaseline(t, violations, N)`. Saves ~700 LOC.

### 6. JS rate-limit primitives — 4 incompatible mechanisms in one process
- `features/platform/outreach-dashboard/src/lib/rateLimitMiddleware.js:18` — global Express middleware, two parallel `Map` stores, default+high-burst.
- `features/platform/outreach-dashboard/server.js:319` `_unsubAllow` — module-scoped `Map`, 10/min/IP for `/unsubscribe`.
- `features/platform/outreach-dashboard/server.js:436` `_dsrAllow` — same shape as `_unsubAllow`, 10/min/IP for `/api/dsr/*`. Code is a literal clone.
- `features/platform/outreach-dashboard/src/lib/enrichment.js:29` `SourceRateLimiter` — token bucket, used per enrichment source.
- `features/platform/outreach-dashboard/src/lib/heal-budget.js:13` `TokenBucket` — token bucket for healing actions.
- **Status:** Three of these (middleware + 2 Allow helpers) all do "N hits per IP per minute" but #2 and #3 use literal copy-paste rather than wrapping #1. This is exactly the issue PR #393 hit.
- **Merge proposal:** Have `_unsubAllow`/`_dsrAllow` use `createRateLimitMiddleware({ max: 10, windowMs: 60_000 })` mounted on `/unsubscribe` and `/api/dsr/*` paths instead. The existing middleware already supports per-prefix overrides via `highBurstPrefixes`, generalising it to `pathLimits` is a small change.

### 7. `outreach_suppressions ∪ suppression_list` UNION — 7 read sites
- `features/platform/outreach-dashboard/src/lib/suppression-union.js:33` (canonical helper).
- `features/platform/outreach-dashboard/src/lib/suppressionFilter.js:42` (BFF, parallel inline UNION).
- `features/platform/outreach-dashboard/campaignPreflight.js:46` (preflight CLI).
- `features/platform/outreach-dashboard/server.js:489-490` (DSR access — 2 SELECTs not a UNION).
- `features/platform/outreach-dashboard/server.js:6288-6292` (suppression listing endpoint — UNION ALL inline).
- `features/outreach/campaigns/campaign/preflight.go:193` `checkSuppressionUnion`.
- `features/outreach/campaigns/campaign/runner.go:44` `suppressionFilterFor(col)` (NOT-IN gate).
- **Status:** Production-correct today (each site does the UNION) but the SQL is rewritten by hand at every call site. A future `suppression_list_v2` migration must touch all 7. No shared SQL constant.
- **Merge proposal:** Promote `features/platform/outreach-dashboard/src/lib/suppression-union.js`'s SQL into a constant `SUPPRESSION_UNION_SQL` exported once; ditto in Go via `features/platform/common/sql/suppression.go` returning the canonical `WHERE NOT IN (UNION)` snippet. Each existing call site shrinks to template-substitution.

## MEDIUM duplicates (parallel APIs, same semantics — currently no harm)

### 8. `MonitoredJob` (Go) vs `timed(name, fn)` (BFF) — same job-wrapper pattern
- Go: `features/platform/common/telemetry/sentry.go:18` — wraps periodic job with Sentry cron monitoring.
- JS: `features/platform/outreach-dashboard/server.js:7596` — wraps cron with `[cron] <name> duration_ms=<n>` log.
- **Status:** Different runtimes, intentional. Not a true duplicate, just naming drift. Worth flagging only because operators reading both stacks see two different log shapes for the same intent.
- **Merge proposal:** None functional. Rename JS `timed` → `monitoredJob` and have it ALSO emit a Sentry breadcrumb when `SENTRY_DSN` is set so cross-stack dashboards align.

### 9. `Mailbox` struct (DB) vs `MailboxConfig` struct (JSON) — known parallel surfaces
- `features/outreach/mailboxes/mailbox/mailbox.go:62` — DB row representation.
- `features/platform/common/config/config.go:51` — JSON config representation.
- Bidirectional sync: `features/outreach/mailboxes/mailbox/sync.go:18,106` (FromConfig/ToConfig).
- **Status:** Known and accepted; documented in `features/outreach/mailboxes/CLAUDE.md`. Duplication is pinned by the dev↔prod migration: legacy YAML mailboxes still load via `LoadFromEnv`. Flagging only because adding a new mailbox field requires updating 4 places (struct A, struct B, FromConfig, ToConfig).
- **Merge proposal:** None now. When the YAML/env path is fully retired (S5 phase 4 per playbook), delete `MailboxConfig` and have the engine consume `mailbox.Mailbox` directly.

### 10. CSP / security headers — 2 surfaces with different policies
- `features/platform/outreach-dashboard/server.js:89-90` — sets `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY`. **No CSP.** Comment at `:85` explicitly notes nonce-per-request CSP is a TODO.
- `features/outreach/relay/web/server.go:129-133` — sets nosniff + DENY + `Content-Security-Policy: default-src 'none'`.
- **Status:** Different surfaces (BFF serves HTML; relay returns JSON+pixel/redirect), but the BFF is the one users actually load in a browser and it has the WEAKER policy. Per the global web/security.md rule, BFF should have a nonce-based CSP. Not a code duplicate, but worth flagging that the policy is split across two services with the more-exposed one being weaker.
- **Merge proposal:** Out of scope for this audit; track as security debt in `docs/audits/2026-04-30-security-pr-review-pack.md`.

## LOW (intentional, just flag for future readers)

### 11. Multiple `Config` struct definitions
8 packages each define `type Config struct {...}` for their own concerns (privacy-gateway, relay, llm, intelligence, etc.). This is idiomatic Go (config near consumer) — not a duplicate. Listed only so a future audit doesn't relitigate.

### 12. Multiple `/health` + `/healthz` endpoints
`features/inbound/orchestrator/web/server.go`, `features/outreach/relay/web/server.go`, `features/compliance/privacy-gateway/internal/httpapi/server.go`, `features/platform/mail-lab-api/internal/handler/handler.go`, `features/platform/outreach-dashboard/server.js` each expose health surfaces. Each is per-service contract. Not a duplicate. The BFF additionally fans out to `/api/health/{invariants,system,watchdog,...}` which is a UI aggregation surface, also fine.

### 13. Multiple `tokenBucket` implementations
- Go: `features/acquisition/contacts/ares/client.go:28` — channel-backed.
- JS: `features/platform/outreach-dashboard/src/lib/heal-budget.js:13` — math-based.
- JS: `features/platform/outreach-dashboard/src/lib/enrichment.js:29` — refill-rate math.
Different runtimes, different semantics (Go is hard rate cap; JS variants are soft healing budgets). Not a true duplicate.

## Recommendations (prioritized by blast radius)

1. **§1 + §4: Unify airtight boot gate.** Delete `enforceAirtightGate` from `cmd/outreach/main.go`, route through `cfg.Sending.ValidateAirtight()`. Promote one `envconfig.BoolOr` with documented dialect. Without this, `LAB_ONLY=yes` continues to behave inconsistently in prod, and PRs like #393 keep happening.
2. **§3: Promote `envconfig.GetOr`.** One-line change per call site, shrinks 7 helper bodies. Pre-condition for adding any env-validation logic later.
3. **§2: Delete dead `features/platform/common/token`. Promote shared unsub-token formula.** Then 3 JS files stop redefining the HMAC. The dead Go package is a foot-gun — first reader assumes it is the canonical scheme.
4. **§5: Extract `slogop.Scan` helper.** Saves ~700 LOC test code and means a slog convention change updates one file, not 8.
5. **§6: Replace `_unsubAllow`/`_dsrAllow` with `createRateLimitMiddleware`.** Same semantics, single shape.
6. **§7: Lift suppression-UNION SQL into shared constants.** Cheap; pre-condition for future suppression-table redesign.

## Out-of-scope but worth noting

- DSR (GDPR Art. 15/17) is BFF-only at `features/platform/outreach-dashboard/server.js:456,526`. `features/inbound/orchestrator/CLAUDE.md` was updated mid-audit (2026-04-30) to record "DSR endpoints jsou na BFF, ne tady" — earlier wording referenced a non-existent `web/handler_dsr.go`. No code change needed; mentioning here so future readers don't add a parallel Go cascade.
