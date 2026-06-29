# Testing Guide — outreach-dashboard

## Stack

| Layer | Tool |
|-------|------|
| Unit | vitest + @testing-library/react |
| E2E | Playwright |
| Mutation | Stryker |
| Contract | Pact / OpenAPI (planned) |

## Running Tests

```bash
pnpm test                 # vitest unit (CI gate)
pnpm test:coverage        # with v8 coverage report
pnpm test:mutation        # stryker mutation score
pnpm e2e                  # Playwright headless
pnpm e2e:ui               # Playwright with UI
```

## Coverage Threshold

80% lines / functions / branches / statements (enforced in vitest.config.ts).

## Test Layout

```
test/
├── setup/
│   └── vitest-setup.ts   # jest-dom matchers
├── unit/                 # vitest unit tests (co-located or here)
├── integration/          # tests hitting Express BFF (msw or real server)
├── contract/             # OpenAPI / Pact contract tests
├── e2e/                  # Playwright specs
└── fixtures/             # shared test data
```

## Unit Test Conventions

- Test files: `*.test.ts` or `*.test.tsx`
- Prefer `@testing-library/react` for component tests
- Mock `fetch` with `msw` for API calls
- Reset Zustand stores in `beforeEach`

## E2E Conventions

- Entry: `test/e2e/*.spec.ts`
- Base URL: `http://localhost:5175` (Vite dev) or configured via `PLAYWRIGHT_BASE_URL`
- Use `page.getByRole` / `page.getByTestId` — avoid CSS selectors
- Each spec is independent (no shared state between tests)

## Degraded UI Test

When Go backend is unreachable (503 from `/api/daemons`):
- `useOutreachHealth.degraded` becomes `true`
- Dashboard shows `degradedBanner`
- Unit test: `test/unit/outreachHealth.test.ts`
- E2E test (planned): `test/e2e/degraded.spec.ts` — mock server returning 503

## CI Gate

All unit tests must pass before merge into `develop`. E2E runs nightly.
See `.github/workflows/machinery-outreach-dashboard-ci.yml`.
