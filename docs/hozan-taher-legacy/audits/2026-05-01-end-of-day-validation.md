---
status: Complete
date: 2026-05-01
trigger: 30 PRs merged today (CAD initiative complete)
head_sha: 4c1a60d1
---

# End-of-Day Validation — 2026-05-01

Full-monorepo regression after 30 PRs merged today (CAD initiative complete).
Baseline snapshot taken from `origin/main` @ `4c1a60d1`.

---

## Test Counts by Scope

| Scope | Total | Passed | Failed | Skipped |
|---|---|---|---|---|
| **vitest fast** (unit + audit + chaos) | 4889 | 4837 | 26 | 25+1 todo |
| **vitest contract** | 1834 | 1814 | 20 | — |
| **vitest audit** (subset of fast) | 585 | 581 | 4 | — |
| **go campaigns** | 1527 | 1521 | 1 | 4 |
| **go common** | 1011 | 1004 | 7 | 3 |
| **go mailboxes** | 657 | 657 | 0 | 0 |
| **go integration** (campaigns/integration) | 16 | 16 | 0 | 0 |
| **go remaining services** (broad run) | 7018 | 7009 | 9 | 29 |

Note: 5 of the 9 broad-run Go failures were parallel-execution flakes (relay transport ticker, llmclient photo parse × 2, orchestrator import resolution under load) — confirmed by isolated rerun (0/5 reproduced on isolated run). 4 are genuine regressions tracked below.

---

## Audit Ratchet Baselines — Snapshot

| Ratchet | Expected Baseline | Actual Count | Status |
|---|---|---|---|
| `sender/no_bypass_audit_test.go` | 0 | 0 | GREEN |
| `sender/airtight_audit_test.go` | 0 | 0 | GREEN |
| `sender/slog_op_audit_test.go` | 5 | 5 | GREEN |
| `envconfig/consumption_audit_test.go` | 0 | **14** | RED → #595 |
| `memory_tier_audit.test.mjs` (17 cases) | pass | pass | GREEN |
| `cad-drift-cron-shape.test.mjs` (22 cases) | pass | pass | GREEN |
| `cad-a5-rebuild-audit.test.js` (37 cases) | pass | pass | GREEN |
| `observability-audit surface 2` | 23 | **24** | RED → #593 |
| `observability-audit surface 3` | 23 | **24** | RED → #593 |
| `observability-audit surface 4` | 21 | **22** | RED → #593 |

---

## Build Verification

| Artifact | Status | Notes |
|---|---|---|
| `go build ./...` | GREEN | All binaries compile, exit 0 |
| `pnpm build` (Vite) | GREEN | 2069 modules, 11.62s |

### Vite Bundle Size (gzip)

| Asset | Gzip Size |
|---|---|
| CSS (`index-*.css`) | 14.72 kB |
| Main JS (`index-*.js`) | 13.95 kB |
| React vendor | 60.38 kB |
| Companies page | 24.85 kB |
| Mailboxes page | 21.10 kB |
| CampaignDetail | 8.40 kB |

CSS budget (50 kB limit): **14.72 kB ✓** (gzip). Bundle budget test flake noted below.

---

## Regressions Found — 6 Issues Filed

### RED — Confirmed reproducible

| Issue | Scope | Failure | Filed |
|---|---|---|---|
| #591 | Go / campaigns | `TestEngine_LabHook_NilEvaluator_DoesNotChangePath`: spy relay returns empty body; F3-3 guard rejects → `MailboxUsed=""`. Fails 3/3. | [#591](https://github.com/messingdev/hozan-taher/issues/591) |
| #592 | JS / UI | `PripravaRana.test.jsx` all 18 tests: PR #569 added 2nd `fetch('/api/anti-trace/egress')` to `Promise.all` but tests only mock 1 fetch call → `undefined.catch()` crash. | [#592](https://github.com/messingdev/hozan-taher/issues/592) |
| #593 | JS / audit | `observability-audit.test.js` surfaces 2, 3, 4: new heal site added in batch without bumping baselines (24 > 23, 22 > 21). | [#593](https://github.com/messingdev/hozan-taher/issues/593) |
| #594 | JS / contract | 20 BFF contract failures: route inventory desync (`GET /api/anti-trace/egress` new, campaigns family=0), `POST /api/campaigns/:id/run` returns 412 (new precondition gate not satisfied in fixtures). | [#594](https://github.com/messingdev/hozan-taher/issues/594) |
| #595 | Go / common | `envconfig` batch-2 migration: 14 raw `os.Getenv` violations remain in orchestrator anonymity cmds; `BoolOr` trims whitespace making `"yes "` truthy. | [#595](https://github.com/messingdev/hozan-taher/issues/595) |
| #596 | Go / common | `TestNoDirectSqlErrNoRowsCompare`: `orchestrator/cmd/anonymity-harvest/main.go:373` uses `err != sql.ErrNoRows` (bare compare) instead of `errors.Is`. | [#596](https://github.com/messingdev/hozan-taher/issues/596) |

### FLAKY — Isolated rerun green, parallel-contention only

| Failure | Rerun result | Diagnosis |
|---|---|---|
| `TestRotatingProxyTransport_TickerRefresh` | 1/1 PASS | Port/timer contention under 106-package parallel `-race` |
| `TestParsePhoto_HappyPathDecodes` + `TestParsePhoto_501ReturnsNotImplemented` | 2/2 PASS | Port binding conflict under parallel load |
| `orchestrator/intelligence` import resolution | Build succeeds solo | go workspace resolver ambiguity under parallel module scan |
| `bundle.budget.test.js T-0307` | 1/1 PASS | Concurrent `pnpm build` conflict with parallel Vite build |
| `tests/synthetic/prod-smoke.test.js` M1 shape (2 failures) | Expected — no BFF in CI | Tests require live BFF, appropriately skip/fail without it |
| `Inbox.collocated.test.jsx` filter tabs | 1/1 PASS | Isolated timing issue under parallel test runner |

---

## Subsystem Map Count + Drift Status

| Subsystem map | File count at HEAD | Drift status |
|---|---|---|
| `docs/subsystem-maps/anti-trace.md` | present | No drift detected (audit ratchet green) |
| `docs/subsystem-maps/` total | 7 files (CAD-A1) | No new subsystems added today |
| `features/platform/common/envconfig/` | consumed by 10+ packages | DRIFT: 14 raw `os.Getenv` in orchestrator cmds (#595) |

---

## Cross-PR Interaction Notes

1. **PR #569 × tests**: EgressCard added `fetch('/api/anti-trace/egress')` to PripravaRana but test mocks were not updated. Cross-PR gap between UI change and test baseline.

2. **PR #579 × orchestrator cmds**: envconfig batch-1 migration updated baseline to 0 but did not migrate all 4 anonymity-* cmd mains. The consumption audit test was written expecting a completed migration.

3. **F3-3 × engine_labhook_test.go**: The antitrace hardening (reject empty/non-JSON 2xx) broke the spy relay which returns bare 200. The labhook tests predate F3-3 and were not updated.

4. **PR #583 (reset-next-send-at) × contract tests**: The new precondition check on `/run` (412 when state preconditions not met) was not anticipated in the contract test fixtures — they assume unconditional 200.

---

## Wall Time

Test execution wall time: ~12 minutes (slightly over 10-min budget; Go `-race` on 106 packages under parallel load accounts for the delta).

All results based on `HEAD = 4c1a60d1` on `origin/main`.
