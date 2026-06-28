**Status:** Archived
**Datum:** 2026-04-26
**Trigger:** Testing expansion initiative; deferred post-phase-0; comprehensive wave closes at phase 0 boundary

# Comprehensive Testing + Self-Healing Initiative

**Date opened**: 2026-04-26
**Owner**: Chat A (autonomous)
**Branch**: `feat/ui-epic-d-e-f-2026-04-26` (continues from UI EPIC D+E+F work)
**Status**: in-progress (Wave 1)

## Goal

Bring testing rigor + self-healing depth to production-grade across 8 surfaces:
spintax lib, Templates UI, CampaignNew dry-run, PreflightGateModal, SendCalendar,
CampaignDetail wiring, BFF replies/templates, Migration 008.

Add ~910 new tests across 7 categories: Monkey (M), Integration (I), E2E (E),
Unit (U), basic Self-Healing (H), sophisticated (HX), advanced (HXX).

## 6-Layered quality verification

1. **Mutation testing** — Stryker per pure-fn module, ≥85% kill score
2. **Real-state replay** — healing_log + Sentry incident replay against test suite
3. **Adversarial verification** — monthly red-team subagent + negative tests
4. **Formal invariants** — fast-check properties, state-machine model checking
5. **SLO enforcement** — production-tied histograms, error budget burns
6. **Soak + diversity** — 24h chaos sim weekly, long-tail event quarterly

## Plan

See conversation: 46 sprints across 6 waves. Track HXX = autonomic
(predictive, formal-verified, counterfactual-validated, root-cause-attributed).

## Shared modules (build first)

- `features/platform/outreach-dashboard/src/test/slo-helpers.js` — assertPercentile, assertHistogramBounded, assertConvergence
- `features/platform/outreach-dashboard/src/test/chaos-sim.js` — MarkovSim, FaultInjector, FakeClock, ShadowRunner
- `features/platform/outreach-dashboard/src/test/state-machine.js` — StateGraph, exhaustiveCheck
- `features/platform/outreach-dashboard/src/test/heal-fixtures.js` — mockMailbox, mockCron, mockEngine
- `features/platform/common/heal/heal.go` — HealAction, HealOutcome, ScopedExecutor, BudgetTokenBucket
- `features/platform/outreach-dashboard/src/lib/heal-explanations.js` — renderHealExplanation, parseHealLog
- `scripts/heal-replay.mjs` — Replay healing_log against test suite

## Migrations

- `scripts/migrations/009_heal_quorum_votes.sql` — HXX6 distributed quorum
- `scripts/migrations/010_heal_economy.sql` — heal_actions table (action, entity_id, outcome, latency_ms, rollback_at)

## Execution waves

```
W1 (infra+pure):    M1 M4 M5 I5 I6 U1 U2 H7 H8 HX10 HXX12        — 11 sprints
W2 (UI+single):     M2 M3 I1 I3 H1 H2 H6 HX5 HX8 HXX9            — 10 sprints
W3 (cross):         I2 I4 H3 H4 H5 HX1 HX2 HX6 HX7 HX9
                    HXX1 HXX5 HXX7 HXX10                          — 14 sprints
W4 (long sims):     HX3 HX4 HXX2 HXX3 HXX4 HXX8                   — 6 sprints
W5 (multi-region):  HXX6 HXX11                                     — 2 sprints
W6 (E2E):           E1 E2 E3                                       — 3 sprints
```

## Gates per merge

1. fast tests (vitest+go-race short) <5min
2. contract tests (full) <10min
3. mutation diff Stryker on touched modules
4. incident-replay tests for touched heal action types

## Status tracking

This file = canonical plan; per-sprint progress in `docs/handoff/TODO.md` Live tasks.
BOARD trailers: `Heals-Verified: <sprint-id>`.

## Out of scope

- LLM-based heal-decision policy (Track HXXX)
- Real distributed Raft (HXX6 uses pg advisory + voting table)
- Live prod data (anonymized snapshots only)

## Reference

Memory: `feedback_extreme_testing.md` (≥10 cases), `feedback_autonomous_work.md`,
`feedback_no_external_services.md`, `feedback_mailbox_passwords_via_db.md`.
