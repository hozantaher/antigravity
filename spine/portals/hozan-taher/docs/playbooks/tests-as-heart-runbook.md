# Tests as Heart of App — operator runbook

> Continuous validation, self-healing tooling, self-learning loops.
> Initiative `docs/initiatives/2026-04-26-comprehensive-testing-self-healing.md`.

## Quick reference

```bash
# Run tests
pnpm test                   # default scope (unit + audit + chaos + property + regression + synthetic)
pnpm test:fast              # alias
pnpm test:contract          # BFF contract (vi.mock pool)
pnpm test:integration       # pg-mem + testcontainers
pnpm test:full              # everything except real-server legacy
pnpm test:coverage          # default + coverage report

# E2E
pnpm e2e                    # Playwright

# Schema parity
node scripts/refresh-schema-baseline.mjs    # regen schema-manifest.json
curl /api/__schema-check                    # live drift check

# Synthetic / SLO
curl /api/health/invariants                 # latest synthetic
curl /api/synthetic-runs?limit=100          # history

# Learning loops
node scripts/sentry-to-regression-test.mjs --event=event.json
node scripts/mutation-propose-tests.mjs --report=mutation.json

# Anti-hallucination toolkit (A1-A8)
node scripts/test-prod-linkage.mjs            # orphan tests (no prod-path trace)
node scripts/assertion-density.mjs            # zero-asserts + tautology
node scripts/fixture-prod-diff.mjs --target=...   # MSW shape vs prod
node scripts/prod-snapshot-capture.mjs --target=. # capture sanitized fixtures
node scripts/inverted-fault-harness.mjs           # transform shadow tree
node scripts/inverted-fault-harness.mjs --run     # transform + classify (slow)
node scripts/hallucination-score.mjs              # aggregate score 0-100
node scripts/halluc-precommit.mjs --staged        # pre-commit ratchet
```

### Hallucination Score components

| Component | Weight | Source |
|---|---|---|
| Mutation kill rate | 0.30 | `reports/mutation/mutation.json` (Stryker) |
| Linkage (1−orphan%) | 0.20 | `linkage-map.json` (A4) |
| Assertion density | 0.20 | `assertion-audit.json` (A3) |
| Fixture-drift reachability | 0.10 | `fixture-drift.json` (A1) |
| No-signal absence | 0.10 | `inverted-fault-report.json` (A2 --run) |
| Flaky inverse | 0.10 | `flaky_quarantine.json` |

Severity: green ≥ 85, yellow ≥ 70, orange ≥ 50, red < 50.

### Anti-hallucination markers

- `// @linkage-allowed: <reason>` — exempt test from orphan flag (audit/synthetic/discipline tests that scan files dynamically)
- `// @analyzer-self-test` (alias `@tautology-fixtures`, `@density-fixtures`) — suppress tautology + low-density flags for analyzer self-tests that contain code-as-strings as input data

## Architecture (9 layers)

| # | Layer | What | Where |
|---|---|---|---|
| 1 | Static unit | Fast jsdom + MSW | `tests/unit/` |
| 2 | Schema parity | BFF ↔ Go column manifest match | Boot + `/api/__schema-check` |
| 3 | Real-backend | testcontainers Postgres + real BFF | `tests/integration/` |
| 4 | Visual regression | Playwright screenshots | `tests/e2e/visual-regression.spec.ts` |
| 5 | Synthetic monitor | 60s prod cron, 11 invariants | `tests/synthetic/` + BFF cron |
| 6 | Incident replay | Sentry → regression test scaffold | `tests/regression/` + script |
| 7 | Self-healing | data-testid lint, flaky quarantine, autosuggest | scripts + ESLint rule |
| 8 | Self-learning | telemetry → coverage gaps → AI proposals | weekly crons |
| 9 | Runtime invariants | `invariant()` macros in code | `src/lib/invariant.js` + Go pkg |

## Sentry tags routing alerts

| Tag | When fires | Severity |
|---|---|---|
| `playbook=schema_drift` | Boot detects BFF↔Go schema mismatch | warn |
| `playbook=synthetic_smoke` | 60s synthetic check fails | warn |
| `playbook=sender_panic` | superviseSender catches engine panic | warn |
| `category=invariant` | Production `invariant()` violation | warn |
| `boot invariant fatal` | FATAL boot check failed → process.exit(1) | fatal |

## SLO bounds (enforced)

| Metric | P50 | P99 |
|---|---|---|
| Mailbox auto-pause → resume | <2 min | <15 min |
| Cron stall recovery | <30 s | <2 min |
| Proxy pool refresh | — | <90 s |
| Synthetic prod-smoke fail rate | — | <1% over 7d (burn-rate `caution`) |

Burn-rate severity:
- `ok` — under budget
- `caution` — 1-6× budget rate
- `warn` — 6-14.4× (review trends)
- `page` — ≥14.4× (budget exhausted in <2h, page on-call)

## CI workflows

`.github/workflows/dashboard-real-backend.yml`:
- **real-backend-smoke** — testcontainers + integration suite + drift regression
- **schema-parity** — Go schema package -race tests
- **flaky-quarantine** (main only) — auto-update flaky_quarantine.json + GH issue

## Triage flow when synthetic fails

1. Check `/api/health/invariants` — which invariant failed?
2. If `schema_parity` → run `refresh-schema-baseline.mjs` after operator confirms intentional schema change
3. If `mailbox_pipeline_fresh` → check cron heartbeats (`pnpm report`)
4. If `heal_slo_p99` → inspect heal-escalation thresholds + recent healing_log entries
5. If `no_thrash` → mailbox stuck in pause-resume cycle → check `heal-escalation.js` thresholds

## When to write a regression test

Every Sentry incident with reproducer → file in `tests/regression/`.
Auto-generate: `node scripts/sentry-to-regression-test.mjs --event=...`
Manual: copy `tests/regression/_template.test.ts`.

Test must FAIL on broken main, PASS after fix.

## When to update schema baseline

Schema baseline (`schema-manifest.json`) updates require explicit PR with reason:
1. Apply migration in `scripts/migrations/`
2. Run `node scripts/refresh-schema-baseline.mjs --url=http://prod-go-backend`
3. Review diff in `git diff schema-manifest.json`
4. Commit with message explaining schema change

## When to refine flaky quarantine

`flaky_quarantine.json` is auto-managed but operator should:
1. Weekly: review newly_quarantined entries (GH issue auto-created)
2. Investigate root cause (race? timing? non-determinism?)
3. Fix or document why test is genuinely flaky
4. After 3 consecutive passes, test auto-restores (no manual action)

## When mutation testing reveals gaps

Surviving mutants = uncaught code paths.
1. Run `pnpm exec stryker run stryker.bottleneck.config.json`
2. `node scripts/mutation-propose-tests.mjs --report=reports/mutation/mutation.json`
3. Review proposals → write real tests
4. Re-run Stryker → kill rate increases

## Escalation: when self-healing isn't enough

If a heal action cycles >3× in 30min OR >5× in 24h:
- `heal-escalation.detectEscalation()` flips state to `needs_human`
- Auto-heal disabled until manual ACK via `acknowledgeEscalation(state, { operator })`
- Sentry tag `escalated=true` fires alert

Operator clears via DB:
```sql
UPDATE outreach_mailboxes SET status = 'active' WHERE id = X;
DELETE FROM healing_log WHERE entity_id = X AND action = 'manual_review_required' AND resolved_at IS NULL;
```

## Reference

- Initiative: `docs/initiatives/2026-04-26-comprehensive-testing-self-healing.md`
- Heal libs runbook: `docs/playbooks/heal-action-runbook.md`
- Initial 46-sprint plan: see initiative doc
