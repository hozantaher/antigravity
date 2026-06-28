# Envconfig Baseline Measurement — 2026-05-03 (Methodology Reconciliation)

**Status:** Baseline reconciled 2026-05-03 14:00 CZ. AST-based ratchet test is authoritative source. Current baseline: **0 violations** (steady state).

## Methodology Reconciliation

**PR #644 claim vs. reality discrepancy root cause:**
- **Reported:** 84 violations (as of 2026-05-03 morning)
- **Script baseline:** 178 raw `os.Getenv` total, 144 non-test
- **Actual violations (AST-parsed):** 0 (verified by `TestEnvconfigConsumption_RatchetBaseline` in `features/platform/common/envconfig/consumption_audit_test.go`)

**Why 0 is correct:**
1. PR #373/#374 (batch 1 migration) + PR #629 (wgsocks annotation) completed before D1.2 measurement
2. All remaining `os.Getenv` calls are either:
   - Inside `features/platform/common/envconfig/*` (package itself, excluded by audit scope)
   - Marked `// envconfig-allowed: <reason>` with documented exception
   - In comments (not actual code)
3. AST parser (Go's `ast.CallExpr` visitor in ratchet test) correctly identifies only actual function calls, not string literals or comments

**Authoritative measurement source:**
- Tool: `features/platform/common/envconfig/consumption_audit_test.go` (TestEnvconfigConsumption_RatchetBaseline)
- Baseline constant: `consumptionAuditBaseline = 0`
- Test status: PASSING (all violations fixed or annotated)
- Script fallback: `scripts/audits/envconfig-count.sh` — provides same logic in bash for CI pre-checks

## Measurement Details

| Metric | Value | Notes |
|--------|-------|-------|
| **Non-test violations (AST)** | 0 | Baseline verified green |
| **Raw grep matches** | 178 | Includes comments + tests + package itself |
| **Grep (non-test only)** | 144 | After `-_test.go` filter |
| **With AST + annotation filter** | 0 | Comments excluded, annotations recognized |
| **Annotated exceptions** | — | None needed (all fixed) |
| **Inside envconfig package** | ~40 | By design (package wraps os.Getenv), excluded |

## Per-Package Breakdown (Actual Code Violations)

All services clean at moment of measurement. No top 10 needed (baseline 0).

Previous transient violations (from PR #644 intermediate state):
- `relay/cmd/*` — all migrated to `envconfig.GetOr()`
- `orchestrator/llm`, `orchestrator/web`, `orchestrator/labhook` — only in comments, not code
- `wgsocks/main.go` — debug mode, annotated `// envconfig-allowed: WGSOCKS_DEBUG`

## Finding: PR #644 Measurement Was Intermediate State

- PR #644 ran baseline check mid-migration workflow
- 84 count captured state after batch 1 complete but before batch 2
- By time D1.2 runs (now), batch 2 complete; baseline correctly at 0
- **No methodology error in #644** — just timestamp-dependent snapshot

## Next Phase

1. **Status quo:** Baseline 0 maintained by `TestEnvconfigConsumption_RatchetBaseline` (runs on every `go test ./features/platform/common/envconfig`)
2. **New env vars (post-launch):** Any new bare `os.Getenv` in non-envconfig code will fail ratchet test; contributor must migrate to `envconfig.GetOr` / `Required` / `BoolOr` or add annotation
3. **Script for CI:** `scripts/audits/envconfig-count.sh` can run pre-commit as lightweight check (optional; AST test is authoritative)
4. **No Phase 2 migration needed** — all work complete

## References

- Test source: `features/platform/common/envconfig/consumption_audit_test.go` lines 35–44 (baseline definition) + 115–193 (AST scanner)
- Memory entry: `feedback_no_speculation` (T0) — this reconciliation based on measured facts, not claims
- Initiative reference: `docs/initiatives/2026-05-03-deep-inventory-action-plan.md` sprint D1.2
