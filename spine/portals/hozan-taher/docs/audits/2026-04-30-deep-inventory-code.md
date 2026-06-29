# Deep Inventory — Code Health (2026-04-30)

> **Trigger:** Operator request for monorepo-wide structural audit, code-health perspective. Baselines existing audits: `2026-04-30-duplicate-hunt-deep.md` (PR #403 dedup), `2026-04-30-blind-spot-audit.md` (rate-limit flake), `2026-04-29-medium-debt-tracker.md` (13 deferred MEDIUMs). Methodology: `git grep`, `find`, `wc -l`, `go vet`, `pnpm audit`, `pnpm-lock` parsing on branch `audit/inventory-code-health-2026-04-30` from `origin/main` (commit `3356230b`). Pure docs, no code change. Every finding cites `file:line`.

## Executive summary

Monorepo is **375,413 LoC** across 11 Go modules, 4 active JS workspaces, and 1 dashboard app. Test surface is **strongly over-indexed** (Go test/code 2.51, JS test/code 1.85) but pyramid is **inverted**: 159k lines of Go test code dwarf 63k lines of production code, and 7 of the top-22 largest files in the repo are test files >1000 LoC each.

**Top 3 health issues:**
1. `features/platform/outreach-dashboard/server.js` is an **8744-LoC monolith** with 154 routes, no module split — single biggest deferred risk in the repo (per `2026-04-29-medium-debt-tracker.md` and now confirmed quantitatively).
2. `features/platform/common/invariant` (197 LoC + 324 LoC test) has **zero non-test consumers** — verified dead since merge.
3. **191 ad-hoc `os.Getenv` calls** in production Go vs only **10 imports** of `features/platform/common/envconfig` — duplicate-hunt §3+§4 (`envOr` × 8, `envBoolOr` × 4) is symptomatic of broader drift.

**Top 3 strengths:**
1. Cross-module Go imports form a clean DAG (orchestrator → campaigns → contacts → mailboxes → common); only one cycle: `inbox/reply/classify.go` ↔ `orchestrator/web/threads.go` (verified bidirectional).
2. `pnpm audit --prod`: **0 critical, 0 high** (4 high in dev-only Vite). No production JS supply-chain blockers.
3. `go vet ./services/...` clean across orchestrator/relay/contacts (sample of 3 large modules).

**Tech debt severity: HIGH but contained.** Backlog of structural issues is well-documented (Issue tracker, BOARD.md, debt tracker). No silent rot — every item below is either tracked or trivially extractable.

## Per-service stats

| Service | Lang | Files | Code LoC | Test LoC | Test/Code | Pkgs | Cross-prod imports |
|---|---|---|---|---|---|---|---|
| `features/inbound/orchestrator` | Go | 179 | 16,599 | 32,439 | 1.95 | 15 | inbox/web (1) |
| `features/outreach/relay` | Go | 203 | 11,114 | 32,972 | 2.97 | 39 | common/* |
| `features/acquisition/contacts` | Go | 158 | 11,196 | 26,573 | 2.37 | 15 | common/* |
| `features/compliance/privacy-gateway` | Go | 92 | 8,213 | 14,289 | 1.74 | 16 | common/envconfig |
| `features/outreach/campaigns` | Go | 121 | 4,746 | 25,238 | 5.32 | 5 | contacts, mailboxes, common |
| `features/platform/common` | Go | 75 | 4,690 | 12,237 | 2.61 | 16 | (lib) |
| `features/outreach/mailboxes` | Go | 54 | 2,697 | 9,388 | 3.48 | 3 | common |
| `features/platform/mail-lab-api` | Go | 23 | 2,165 | 3,744 | 1.73 | 4 | common/envconfig |
| `features/platform/operator-practice` | Go | 9 | 1,359 | 1,158 | 0.85 | 5 | common, mail-lab-api |
| `features/inbound/inbox` | Go | 7 | 169 | 1,076 | 6.37 | 2 | orchestrator/llm,mime |
| `features/platform/llm-runner` | Go | 3 | 374 | 97 | 0.26 | 2 | common/envconfig |
| `features/outreach/relay` (anti-trace wrapper) | Dockerfile | 3 | — | — | — | 0 | rebuilds relay/ |
| `features/acquisition/scrapers` | TS | 110 | 11,831 | 12,287 | 1.04 | — | — |
| `features/platform/mcp` | TS | 29 | 2,801 | 3,309 | 1.18 | — | — |
| `features/platform/worker` | TS | 24 | 2,004 | 2,733 | 1.36 | — | — |
| `features/platform/outreach-dashboard` | JS/JSX | 564 | 38,010 | 79,828 | 2.10 | — | — |
| `features/platform/dashboard-core` | JS | 7 | 17 | 0 | 0 | — | re-export shim |
| `services/{mailboxes,campaigns,inbox,contacts}/ui` | JSX | 13 | ~30 | 0 | 0 | — | re-export shim |
| `modules/outreach` | tmpl | 4 | (templates only) | 0 | — | — | — |

`features/platform/common`-prod-imports column (cross-module use, not own tests):

| pkg | LoC | cross-prod | cross-test |
|---|---|---|---|
| `audit` | 150 | 7 | 0 |
| `envconfig` | 128 | 9 | 2 |
| `telemetry` | 273 | 6 | 0 |
| `metrics` | 450 | 5 | 1 |
| `health` | 86 | 4 | 7 |
| `config` | 522 | 4 | 43 |
| `alert` | 102 | 2 | 2 |
| `humanize` | 1,357 | 2 | 7 |
| `sqlsuppression` | 80 | 2 | 0 |
| `calendar` | 223 | 1 | 0 |
| `db` | 110 | 1 | 0 |
| `maillabclient` | 477 | 1 | 1 |
| `refreshcron` | 356 | 1 | 0 |
| `token` | 53 | 1 | 0 |
| `auditbuild/slogop` | 126 | 0 prod / 8 tests | (per-file `slog_op_audit_test.go`) |
| `invariant` | 197 | **0** | **0** |

## Dead code candidates (top 12)

1. **`features/platform/common/invariant/invariant.go:1`** — 197 LoC + 324 LoC test. `invariant.Check`/`invariant.CheckCtx`/`invariant.FailureCount` referenced **only** in `invariant_test.go` and self-doc comments. Never imported by any other package. Verified by `grep -r "common/invariant" services --include='*.go'` → only `features/platform/common/invariant/invariant_test.go:10`. **Delete the package + go.mod/go.sum entries.**
2. **`features/platform/common/token/token.go:15`** — `GenerateUnsubToken` (8-byte BE payload format). Already flagged in `2026-04-30-duplicate-hunt-deep.md §2` as the dead phantom; B/C/D formats (campaigns/runner.go + server.js) are the live ones. 53 LoC + matching `_test.go`.
3. **`features/platform/outreach-dashboard/tests/unit/legacy/server.test.js`** (954 LoC) — directory name suggests deprecation. Confirm via `grep -r "tests/unit/legacy" features/platform/outreach-dashboard/package.json features/platform/outreach-dashboard/vitest.config.ts` whether still in scope; if yes, fold; if no, delete.
4. **`features/outreach/relay/cmd/integration_test.go`** — Orphan: `features/outreach/relay/cmd/` directory has the test but no `main.go` next to it (subdirs `relay/`, `submit/`, `receive/` have their own mains). Test is gated behind `cli_integration` build tag — confirm CI runs it.
5. **`features/inbound/orchestrator/honeypot/validation_test.go`** — Orphan: `features/inbound/orchestrator/honeypot/` has no `*.go` non-test files. Honeypot detection logic lives in `internal/enrich/`. Either move test next to subject or delete if rules moved.
6. **`scripts/migrations/001_drop_campaign_enrollments.sql`** — Predecessor confirmed dead (`grep "campaign_enrollments"` returns one comment hit at `features/outreach/campaigns/.../*` referencing the migration itself). Migration runner already idempotent.
7. **`scripts/migrations/002_cleanup_contacts_first_name.sql`** — `first_name` is still actively used (e.g. `features/acquisition/contacts/.../*.go` `INSERT INTO contacts ... first_name`). Migration is one-shot data cleanup; can be marked archived after operator confirms it has run in prod.
8. **`docs/decisions/ADR-001-dashboard-core-design.md`** + **`ADR-001-outreach-dashboard-quality-primitives.md`** — **two ADRs share number 001**. One must be renumbered or marked superseded. `ADR-001-dashboard-core-design.md` is 3623 bytes (skeleton); the quality-primitives ADR is 6235 bytes (substantive). Per `docs/decisions/README.md` ADRs are immutable — pick a renumbering convention.
9. **`features/platform/dashboard-core/src/index.js`** — 10-line re-export barrel pointing at `features/platform/outreach-dashboard/src/lib/*`. Comments say "Phase M6.2-B will move files physically" but the move is still pending. Either complete M6.2 or revert the barrel; in-flight state has been live since commit history shows the barrel.
10. **`services/{mailboxes,campaigns,inbox,contacts}/ui/src/index.jsx`** — same pattern: re-export from `../../../../features/platform/outreach-dashboard/src/pages/*.jsx`. 4 separate workspaces of ~30 LoC each that exist solely to delay a physical move. Same "complete or revert" verdict as #9.
11. **`modules/outreach/CLAUDE.md`** — Service-tier CLAUDE.md still present although `modules/outreach/` directory now contains only `configs/templates/*.tmpl` and the CLAUDE.md itself. Real Go code migrated to `services/{orchestrator,campaigns,...}` long ago. Either move CLAUDE.md content into root `CLAUDE.md` "Service-local rules" or delete. Confirm with `find modules/outreach -type f`.
12. **`features/platform/common/db`** (110 LoC) — Single cross-prod consumer: `features/inbound/orchestrator/cmd/outreach/main.go:21`. Either inline or expand consumer base — currently doesn't justify being a shared package.

## Bloat top offenders

| Lines | File | Issue |
|---|---|---|
| 8744 | `features/platform/outreach-dashboard/server.js` | 154 routes, 95 functions, no split. Largest debt item in repo. |
| 3680 | `features/compliance/privacy-gateway/internal/httpapi/server_test.go` | Test file itself >800 limit. Split by handler. |
| 3132 | `features/inbound/orchestrator/cmd/outreach/main.go:1` | `func main()` is 448 LoC alone (line 55–503). 346 deeply-nested lines (5+ tabs). |
| 2586 | `features/compliance/privacy-gateway/internal/httpapi/server.go` | 160-LoC `handleDashboard` (`server.go:828`); 127 LoC `handleIntakeSubmissionByID` (`server.go:667`); 126 LoC `handleSubmissionByID` (`server.go:1842`). Split per-resource. |
| 1729 | `features/inbound/orchestrator/thread/unit_test.go` | Per-feature suite, split by inbound/outbound/persistence. |
| 1624 | `features/platform/outreach-dashboard/src/pages/Companies.jsx` | Single page component 2x over budget. |
| 1431 | `features/inbound/orchestrator/thread/property_monkey_test.go` | Property-fuzz suite, split by domain. |
| 1431 | `features/platform/outreach-dashboard/tests/unit/lib/mailboxUtils.test.js` | 1431-LoC unit test for one util — over-fragmented assertions. |
| 1420 | `features/outreach/relay/cmd/relay/smoke_test.go` | Smoke test should be thin; suspected coverage padding. |
| 1164 | `features/outreach/relay/cmd/relay/main.go:1` | `func main()` is only entry but multiple 100+ LoC helpers (`processDrainEnvelope` 146 LoC at `:1018`). |
| 1158 | `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` | Same as Companies.jsx — extract sub-views. |
| 1156 | `features/outreach/campaigns/sender/engine.go` | `Engine.Run` is 160 LoC (`:328`); `recordSendResult` is 130 LoC (`:712`). |
| 1108 | `features/platform/common/humanize/humanize_test.go` | `humanize.go` itself is large (1357 LoC); test follows. |
| 1051 | `features/outreach/relay/internal/transport/coverage_gaps_test.go` | "coverage_gaps" suffix = padding test. |
| 1046 | `features/outreach/relay/internal/transport/proxy_pool.go` | Real implementation file >800. Candidate for split: pool / probe / writer. |
| 1024 | `features/outreach/relay/web/probe_network_test.go` | Test file. |
| 1017 | `features/inbound/orchestrator/intelligence/coverage_test.go` | "coverage" suffix = padding. |
| 1015 | `features/inbound/orchestrator/web/server_test.go` | Test file. |
| 954 | `features/platform/outreach-dashboard/tests/unit/legacy/server.test.js` | "legacy" path — see dead-code #3. |
| 937 | `features/inbound/orchestrator/seed/prodlike/scenarios.go` | Seed/fixture data — acceptable as data-only file but split by scenario family. |

35 files exceed the 800-LoC budget; **4 of them are non-test production files**: `server.js`, `main.go` (orchestrator), `server.go` (privacy-gateway), `Companies.jsx`. Top non-test functions over 50 LoC threshold: orchestrator `func main()` 448 LoC, intelligence `RunOnce` 286 LoC, contacts/enrichment `PromoteCompanies` 227 LoC, `RecalculateFast` 212 LoC.

## Dependency health

**Go modules:** 11 modules under `go.work`. Largest direct-dep counts: `orchestrator` 11, `operator-practice` 7, `common` 6, `contacts` 5. Total `go.sum` lines per module max 31 (orchestrator) — transitive bloat is **low**, dominated by `lib/pq`, `golang-jwt`, `wireproxy/wgcf` paths in relay. `govulncheck` not installed locally; CI pipeline status unverified in this audit. `go vet ./features/outreach/relay/... ./features/inbound/orchestrator/... ./features/acquisition/contacts/...` returned clean.

**Cross-module Go imports (cycle scan):**
- Tree is mostly DAG: `orchestrator` → {campaigns/*, contacts/*, common/*, inboxweb}.
- **One cycle:** `features/inbound/orchestrator/web/threads.go` imports `inbox/web`, while `features/inbound/inbox/reply/classify.go` imports `orchestrator/llm` + `orchestrator/mime`. Compile-graph saved by Go because `inbox/reply` and `inbox/web` are different packages, so import-cycle is at the package level, not file level — but the architectural intent is muddled. Either move shared types to `common/` or split `orchestrator/llm`+`mime` into a third module.

**JS workspaces:**
- `features/platform/outreach-dashboard`: 17 prod deps, 29 dev deps. `pnpm audit`: 0 critical, 4 high (all 4 are in `vite` dev server — `server.fs.deny` bypass + WebSocket arbitrary file read, dev-only blast radius). 18 moderate. **Bumping `vite` from current pin should clear all 4 high.**
- `features/platform/mcp`: 10 prod / 10 dev. `features/acquisition/scrapers`: 14 / 15. `features/platform/worker`: 11 / 6. No flagged supply-chain issues in non-dashboard workspaces.
- `pnpm-workspace.yaml` references `services/{mailboxes,campaigns,inbox,contacts}/ui` — these are the in-flight M6 re-export shims (see dead-code #10).

**JS overrides** (`pnpm-workspace.yaml`): `axios: '>=1.15.0'`, `protobufjs: '>=7.5.5'` — tracked manually, not via Renovate. Add `pnpm outdated` to weekly cron or scope to `features/platform/outreach-dashboard` `dependencies` only.

## Test pyramid analysis

| Tier | Count | Source |
|---|---|---|
| Go unit tests | 620 files | `find services -name '*_test.go'` |
| Go E2E (`e2e_test.go`) | 5 | Sparse — only relay + smoke. |
| Go property tests | 71 files | Strong (CI ratchet present per `slog_op_audit_test.go`). |
| Go integration tests | 7 in name; 113 with `time.Sleep` | Sleep-based tests are flake risk. |
| JS test files | 393 | `features/platform/outreach-dashboard/tests/` heavy. |
| Playwright E2E specs | 58 | Solid coverage of operator flows. |
| BFF contract tests | 70 | New surface (per recent PR history #340/#367). |

**Inversion warning:** Go test LoC = 159,211, prod LoC = 63,322 (ratio 2.51). 7 of the top 22 largest files are tests >1000 LoC each (`*_test.go`, `coverage_*_test.go`, `*_property_test.go`). Coverage-padding files (`*coverage*test*.go`, `*coverage_gaps*`) sum to ≥4000 LoC; they bloat suite without business invariants. Recommend: gate "coverage" tests behind `-tags coverage` build tag and exclude from PR-blocking suite.

**Slow / flake risk:** `time.Sleep` appears 113 times across 45 Go test files. JS tests use `waitFor`/`setTimeout` in 74 files. Recent flake history (`git log --since=2-weeks`) shows 5 fixes in 2 weeks for cross-suite-pollution + rate-limit timing. The unresolved blind-spot rate-limit flake (`bff-mailboxes-extended.contract.test.ts:806/812`, captured 2026-04-30 in `blind-spot-audit.md`) is still latent.

**Mutation testing:** `features/platform/outreach-dashboard/stryker.conf.mjs:25` configured but `break: 0` — non-blocking. No baseline score recorded in repo. Initiative `KT-B9` (per stryker config header) hasn't ratcheted yet. Action: run `pnpm test:mutation`, capture score, set `break` to score - 5pp.

## Documentation gaps

**Go package doc coverage:** of first 200 non-test Go files sampled, 146 (73%) lack a leading `// Package` comment block. Target: 100% for exported packages. Prioritise `features/platform/common/*` (16 packages) — currently `humanize`, `metrics`, `auditbuild/slogop` all lack package-level docs while being broadly imported.

**JSX TSDoc:** of 72 `.jsx` files in `features/platform/outreach-dashboard/src`, 11 (15%) start with `/**`. Largest under-documented components are exactly the 1000+ LoC pages (Companies, Mailboxes, ThreadDetail, Inbox, Replies). When these are split, add component-level JSDoc as part of the split.

**ADR coverage:**
- 7 ADRs total in `docs/decisions/`, two of which share number 001 (collision — see dead-code #8).
- 41 living initiatives in `docs/initiatives/`, 13 archived in `docs/archive/`. 3 initiatives lack a Status header (`2026-04-25-garaaage-launch-plan-v4.md`, `M6-M7-EXECUTION-PLAN.md`, `TEST-COVERAGE-MATRIX.md`) — violation of the "initiative status hlavička" memory rule.
- 2 initiatives have non-active status but live in active dir: `2026-04-30-airtight-dev-env.md` (Phase 2+4 complete), `SPRINT-1-closeout.md` (CLOSED). Move to `docs/archive/`.

**CLAUDE.md drift:** 7 markdown files mention "12 sender" or "24 sender" mailbox configs. After PR #418 (24-mailbox config), 6+ initiative/playbook files still reference the legacy 12 number. Sweep needed.

**Cron observability claim** (root CLAUDE.md "Every cron logged via `timed(name, fn)` wrapper"): no `function timed` or `timed(` found in `features/platform/outreach-dashboard/`. Either the wrapper was removed/renamed or claim is stale; verify before next BOARD update.

## Recommendations (prioritized)

### P0 — wins large-blast / low-risk
1. **Delete `features/platform/common/invariant/`** (521 total LoC). Zero callers, fully test-only. Drop import from `go.work` if needed. *Estimated effort: 30min, blast radius: zero.*
2. **Bump `vite`** in `features/platform/outreach-dashboard/package.json` to clear 4 high CVEs. *15min.*
3. **Split `features/platform/outreach-dashboard/server.js` (8744 LoC)** into 6–8 route modules: dsr, companies, campaigns, mailboxes, observability, system, unsubscribe, privacy. The 154-route list is already mechanically extractable (line-numbered greps in this audit). *8–12h, isolated surface, contract tests already cover regressions.*
4. **Renumber colliding ADR-001s.** Rename `docs/decisions/ADR-001-dashboard-core-design.md` → `ADR-007-dashboard-core-design.md` (or supersede). *5min.*

### P1 — debt reduction by extraction
5. **Land duplicate-hunt §3 fix:** promote `envconfig.GetOr` and delete the 7 `envOr` private copies (per `2026-04-30-duplicate-hunt-deep.md`). Same for `envBoolOr` (§4). *2h, mechanical, full test coverage exists.*
6. **Land duplicate-hunt §5 fix:** consolidate 8 copies of `slog_op_audit_test.go` (259 LoC saved) into a `features/platform/common/auditbuild/slogop.Scan(dir)` helper. *3h.*
7. **Split `orchestrator/cmd/outreach/main.go` `func main()`** (448 LoC, 346 deeply-nested lines): extract config-load, scheduler-wire, and intelligence-loop bootstrap into named init functions. *4h.*
8. **Move closed initiatives to `docs/archive/`:** `2026-04-30-airtight-dev-env.md`, `SPRINT-1-closeout.md`. Add Status header to the 3 missing initiatives. *15min.*

### P2 — pyramid hygiene
9. **Build-tag-gate "coverage padding" tests** (`*coverage_gaps*test*.go`, `coverage_test.go` >800 LoC). Move under `//go:build coverage` so PR pipelines run only behavior tests. ~6 files, ~5000 LoC removed from default `go test` run. *2h.*
10. **Replace `time.Sleep` in 45 Go test files** with deterministic clocks (`testclock` interface or context cancellation). Quantitatively: 113 sleep call-sites. Largest offenders should be auto-listed via `git grep -n time.Sleep services/.../*_test.go`. *Per-package, ongoing.*
11. **Stryker baseline:** run `pnpm test:mutation` once, record score, raise `break` to score-5pp (one-way ratchet). *1h once.*

### P3 — slow burn
12. **Resolve the inbox↔orchestrator package cycle** (`inbox/reply/classify.go` ↔ `orchestrator/web/threads.go`): extract `orchestrator/llm` + `orchestrator/mime` into `features/platform/common/llm/` + `features/platform/common/mime/`, since both modules already depend on them. *4h.*
13. **Decide on M6 page-extraction completion:** either physically move pages to `services/{mailboxes,campaigns,inbox,contacts}/ui/src/` and cut the dashboard import, OR delete the 4 re-export shims + `features/platform/dashboard-core` barrel. The half-finished state is technical debt that has lived since 2026-04-21 (per `docs/initiatives/2026-04-21-outreach-dashboard-quality-refactor-39-bugs-3-anti-patterns-5-waves.md`). *Decision call, then 6h either way.*
14. **Sweep "12 sender" → "24 sender"** in 6+ initiative/playbook docs. Mechanical replace. *30min.*

## Methodology notes

- All counts via `find … -type f \( -name '*.go' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/vendor/*'` then `wc -l`.
- Cross-imports verified via `grep -rln '"common/<pkg>"' services --include='*.go'` excluding own-package and `_test.go` files.
- Function-LoC scan via awk balanced-brace counter on Go files (`^func ` start, brace match end).
- Deeply-nested = `^\t\t\t\t\t` (5+ tab indentation).
- Test/code ratios computed from `wc -l` totals, treating any `*_test.go` / `*.test.*` / `*.spec.*` as test.
- Dependency surface (`go.sum` line count) is a transitive proxy, not a strict count.
- `pnpm audit --json` parsed via `jq`; severity buckets are pnpm-reported.
- This audit changed zero source files; commit is docs-only.
