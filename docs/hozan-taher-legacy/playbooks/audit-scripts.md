# Audit-script playbook

This file documents `features/platform/outreach-dashboard/scripts/*.mjs` scripts and
the `package.json` aliases that drive them. The intended split is
`test:*` (REAL gates) vs `tools:*` (MAINTENANCE captures), with
`audit:*` reserved for future informational audits. Sprint S4 of the
2026-04-27 test-suite-recovery initiative locked the convention in;
some legacy `test:*` aliases that don't actually gate are listed
explicitly below.

## Naming convention

| Prefix    | Intent                                                           | Runs in CI? |
| --------- | ---------------------------------------------------------------- | ----------- |
| `test:*`  | REAL — exits non-zero on threshold breach when a `--fail` flag is set | yes (gate)  |
| `audit:*` | reserved for non-PR-gating informational audits (none yet)       | optional    |
| `tools:*` | MAINTENANCE — captures baselines, snapshots, reports             | manual only |

Intended expectation: anything under `test:*` either fails the suite
or is wired to fail it from a higher level. `tools:*` never gates;
running them on a clean tree is fine. **Caveat**: a handful of
legacy `test:*` aliases (`test:bundle`, `test:security`,
`test:lighthouse`, `test:flaky`, `test:fixture-drift`) are de-facto
MAINTENANCE today and don't gate on anything — they're listed in the
"Capture-only `test:*` aliases" section below; promotion to `tools:*`
is a follow-up.

## REAL audits (gate-able)

Each section: **what it measures · how it's run · how to interpret ·
acceptance threshold**.

### `test:linkage` — orphan tests vs prod selectors

Script: `scripts/test-prod-linkage.mjs`.

- **Measures**: which test selectors are referenced by production code
  (i.e. used in real components/routes). Tests that hit selectors no
  prod page actually renders are "orphans".
- **Run**: `pnpm test:linkage` (informational), `pnpm test:linkage --fail`
  (gates).
- **Output**: `linkage-map.json`.
- **Threshold**: when `--fail` is passed, exits non-zero if
  `orphan_pct` exceeds the script-internal threshold.

### `test:density` — assertion density / tautology detector

Script: `scripts/assertion-density.mjs`.

- **Measures**: assertions per test file; flags tautological asserts
  (e.g. `expect(true).toBe(true)`, `expect(x).toBeDefined()` after just
  declaring `x`).
- **Run**: `pnpm test:density` (informational), `pnpm test:density --fail-on-violation`
  (gates).
- **Output**: `assertion-audit.json`.
- **Threshold**: violations >0 with `--fail-on-violation` set.

### `test:load` — endpoint regression load test

Script: `scripts/load.mjs`.

- **Measures**: per-endpoint latency under synthetic load, compared
  against per-endpoint regression budgets in the script.
- **Run**: `pnpm test:load`. **Always gates** — calls
  `process.exit(1)` on any budget breach (no opt-in flag).
- **Output**: `load-report.json` (if configured) + console summary.
- **Threshold**: per-endpoint latency budgets defined inline in the script.

### `test:inverted-fault` — no-signal test detector

Script: `scripts/inverted-fault-harness.mjs`.

- **Measures**: runs each unit test under an inverted-mock harness
  that breaks the dependencies the test claims to exercise. A test that
  still passes despite its dependency being broken provides "no signal"
  — it isn't actually testing what it says it is.
- **Run**: `pnpm test:inverted-fault` (informational),
  `pnpm test:inverted-fault --fail` (gates).
- **Output**: per-test no-signal classifications in JSON.
- **Threshold**: no-signal count >script-internal budget when `--fail`
  is set.

### `test:explain-gate` — query-plan regression gate

Script: `scripts/explain-gate.mjs`.

- **Measures**: runs `EXPLAIN ANALYZE` on a hand-picked set of hot
  queries (mirrored from `server.js`); fails when any plan contains a
  `Seq Scan` or `Filter (lossy)` on those endpoints.
- **Run**: `pnpm test:explain-gate`. Requires `DATABASE_URL` —
  skips silently otherwise.
- **Output**: `reports/explain/gate.json`.
- **Threshold**: any seq scan or lossy filter on the gated query set →
  exit code 2.

### `test:hallucination` (chain) — composite signal

Script: `scripts/test-prod-linkage.mjs && assertion-density.mjs && hallucination-score.mjs`.

- **Measures**: combines linkage + density + a 0–100 hallucination
  score from the prior two outputs.
- **Run**: `pnpm test:hallucination`.
- **Status**: **Wiring bug as of 2026-04-29.** The chain calls
  `test-prod-linkage.mjs` and `assertion-density.mjs` without their
  gate flags (linkage uses `--fail`, density uses
  `--fail-on-violation`), so both exit 0 regardless of violations.
  The final `hallucination-score.mjs` is itself MAINTENANCE (no
  threshold). Net effect: the chain currently passes silently
  regardless of input quality. Fix: pass `--fail` to linkage and
  `--fail-on-violation` to density inside the chain, or add an
  exit-code threshold to `hallucination-score.mjs`.
- **Threshold**: none today (see status).

## Maintenance tools (`tools:*`, no gating)

These never fail PR CI. They produce baselines / snapshots that other
audits read.

| Alias                          | Script                          | What it captures |
| ------------------------------ | ------------------------------- | ---------------- |
| `tools:explain`                | `explain.mjs`                   | EXPLAIN output for hot queries → `reports/explain/plans.json`. Read by `kpi.mjs`. |
| `tools:hallucination-baseline` | `hallucination-score.mjs` then `cp` | Refreshes `hallucination-score.baseline.json` from the latest run. Must be run from `features/platform/outreach-dashboard/` — the chained `cp` uses relative paths. |
| `tools:shadow`                 | `shadow-capture.mjs`            | Captures API response skeletons → baseline/current JSON for shape comparison. |
| `tools:snapshot`               | `prod-snapshot-capture.mjs`     | Captures + sanitizes prod endpoint snapshots into `prod-snapshots/`. |

### Capture-only `test:*` aliases that are de-facto MAINTENANCE

These still live under `test:*` for legacy reasons but do not gate
today (no exit-code threshold). They're listed here so the inventory
is accurate; promotion to `tools:*` is a follow-up.

| Alias               | Script                  | What it captures |
| ------------------- | ----------------------- | ---------------- |
| `test:bundle`       | `bundle.mjs`            | gzip bundle sizes → `reports/bundle/summary.json`. |
| `test:security`     | `security.mjs`          | npm-audit + license inventory → `reports/security/`. |
| `test:lighthouse`   | `lighthouse.mjs`        | Lighthouse CI runs → `reports/lighthouse/summary.json`. |
| `test:flaky`        | `flaky.mjs`             | Flaky-test detection report. |
| `test:fixture-drift` | `fixture-prod-diff.mjs` | Probes prod endpoints, compares shapes → `fixture-drift.json`. |

## Reading the outputs

Most scripts emit a JSON file in the dashboard root or under
`reports/<area>/`. To get a single-pane view of the latest run, read
`scripts/system-report.mjs` output (`pnpm report`) or, for the
human-readable digest, `scripts/kpi.mjs` (`pnpm kpi`).

## Sprint S4 acceptance signal

- **S4.1 [done]** — every `test:*` classified (above).
- **S4.2 [done]** — no STUBs found; nothing to delete or rename to
  `audit:stub:*`. Documented as "no-op — all scripts are REAL or
  MAINTENANCE".
- **S4.3 [done]** — `test:explain`, `test:hallucination-baseline`,
  `test:snapshot`, `test:shadow` renamed to `tools:*` (matching
  issue #81 spec). Five additional capture-only aliases stay under
  `test:*` for legacy compatibility — listed in "Capture-only `test:*`
  aliases" above; promotion to `tools:*` deferred to keep this PR
  scoped to issue #81 verbatim.
- **S4.4 [done]** — this file.
