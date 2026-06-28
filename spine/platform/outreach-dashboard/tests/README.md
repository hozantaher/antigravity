# tests/ — Test root

Single source of truth for all tests in `apps/outreach-dashboard`. Migrated
from collocated layout (Phase 0 of "Tests as Heart of App" initiative —
`docs/initiatives/2026-04-26-comprehensive-testing-self-healing.md`).

## Layout

```
tests/
├── unit/          ← Fast unit tests (jsdom + MSW)
│   ├── lib/       ← lib/* unit tests (spintax, heal-*, …)
│   ├── components/← React components
│   ├── hooks/     ← custom hooks
│   ├── pages/     ← page-level units
│   └── legacy/    ← src/*.test.* root files (gradually migrate up)
├── integration/   ← Real backend (pg-mem / testcontainers)
├── contract/      ← BFF contract (vi.mock pool, supertest)
├── property/      ← fast-check properties (long random runs)
├── chaos/         ← Markov simulations + multi-entity invariants
├── audit/         ← Discipline tests (ratchet baselines)
├── synthetic/     ← PROD continuous monitoring (run via cron)
├── regression/    ← Incident replay (auto-generated from Sentry)
├── e2e/           ← Playwright specs
├── fixtures/      ← Shared test data (mailboxes, campaigns, healing-log)
└── helpers/       ← Shared test infra (slo-helpers, state-machine, chaos-sim, …)
```

## Run commands

```bash
pnpm test                  # all projects (sequential)
pnpm test:fast             # unit + property (CI gate, <5min)
pnpm test:full             # +integration +contract +chaos (nightly)
pnpm test:prod             # synthetic + regression (every 60s in prod)
pnpm test --project=unit   # single project
pnpm test --project=audit  # discipline ratchet checks
pnpm e2e                   # Playwright (separate config)
```

## Why this layout

See `docs/initiatives/2026-04-26-comprehensive-testing-self-healing.md` —
"tests as heart of app": continuous validation, self-healing selectors,
incident-replay loop. Single root makes discoverability + tooling easier.

## Conventions

- **data-testid** required for action elements (button/link). `getByText`
  forbidden by lint rule (Phase 5 H1).
- **Czech UI strings** in JSX (memory `feedback_language.md`).
- **Extreme testing** — ≥10 cases per change (memory `feedback_extreme_testing.md`).
- **No external services** — Sentry only (memory `feedback_no_external_services.md`).

## Migration status

| Source | Target | Status |
|---|---|---|
| `src/lib/*.test.*` | `tests/unit/lib/` | K2 |
| `src/components/*.test.*` | `tests/unit/components/` | K3 |
| `src/pages/__tests__/*` | `tests/unit/pages/` | K4 |
| `src/hooks/*.test.*` | `tests/unit/hooks/` | K5 |
| `src/test/*` | `tests/{helpers,audit,chaos}/` | K6 |
| `src/*.test.*` (legacy) | `tests/unit/legacy/` | K7 |
| `test/contract/*` | `tests/contract/` | K8 |
| `test/integration/*` | `tests/integration/` | K9 |
| `e2e/*.spec.ts` | `tests/e2e/` | K10 |
