# Test Strategy Playbook

Operační příručka pro spouštění a interpretaci testů v hozan-taher monorepu.

> Pro **proč** tato strategie viz [ADR-003](../decisions/ADR-003-test-suite-governance.md).
> Pro **rehabilitaci** stávající suite viz [iniciativa test-suite-recovery](../initiatives/2026-04-27-test-suite-recovery.md).

## Test pyramida

```
                  ╱╲
                 ╱E2╲              Playwright, ~424 specs
                ╱─────╲            tests/e2e/*.spec.ts
               ╱contract╲          BFF mock pool, ~50 specs
              ╱──────────╲         tests/contract/*.test.ts
             ╱integration╲         pg-mem real backend
            ╱──────────────╲       tests/integration/*.test.ts
           ╱property + chaos╲      fast-check, Markov sims
          ╱──────────────────╲     tests/property/, tests/chaos/
         ╱─────unit──────────╲     vitest, go test
        ╱──────────────────────╲   tests/unit/*, *_test.go
       ╱────────────────────────╲
      ╱─────static (lint, type)──╲ ESLint, tsc, golangci-lint
     ╱──────────────────────────────╲
```

## Jak spustit

### Lokálně (kanonický)

```bash
make test                # všechno (Go + JS/TS + audit + smoke; mutation skip)
make test-fast           # jen Go + JS/TS test scripty (no audit/smoke/mutation)
make test-go             # jen Go workspace
make test-js             # jen JS/TS pnpm test scripty
make test-audit          # jen audit/quality scripty
make test-smoke          # smoke shell scripty (vyžadují live env)
make test-mutation       # Stryker mutation testing (30+ min)
make test-area AREA=relay   # vše pro jednu area
```

Pod kapotou = `bash scripts/test-all.sh` s filtry. Logy v `/tmp/hozan-tests-<pid>/`.

### Per-služba (debug konkrétního selhání)

```bash
# Go service
cd services/<name> && go test -count=1 -race ./...
cd services/<name> && go test -count=20 -race -run TestX ./...   # flake repro

# JS/TS package
cd features/platform/outreach-dashboard && pnpm test:full --reporter=verbose
cd features/acquisition/scrapers && pnpm test -- scrapers/mobile-de/db.test.ts

# E2E single spec
cd features/platform/outreach-dashboard && pnpm exec playwright test jobs-flow.spec.ts --headed
```

### CI

GitHub Actions (per ADR-003) volá `make test` jako jediný entry point. Per-area workflows postupně přepnou na `make test-area AREA=<x>`.

## Test scope konvence (vitest)

`pnpm test` (default) bude po S2.6 ekvivalent `TEST_SCOPE=all`. Do té doby:

| Script | Scope | Co spustí |
|---|---|---|
| `pnpm test` | default | Současný úzký vitest run (~262 souborů, ~5500 testů) |
| `pnpm test:fast` | alias | Stejný jako test |
| `pnpm test:contract` | TEST_SCOPE=contract | BFF kontrakty (mocked pool) |
| `pnpm test:integration` | TEST_SCOPE=integration | pg-mem reálný backend |
| `pnpm test:full` | TEST_SCOPE=all | **Vše dohromady** (210 souborů, 4040 testů) |
| `pnpm test:coverage` | + coverage | Default scope + LCOV report |
| `pnpm e2e` | playwright | tests/e2e/*.spec.ts |

## Jak interpretovat fail

### Go test fail

```
--- FAIL: TestX (0.12s)
    file_test.go:42: expected ...
FAIL    package/path    1.234s
```

1. Reprodukovat lokálně: `cd services/<svc> && go test -count=1 -run TestX ./<pkg>/`
2. Pokud flake (občas): `go test -count=20 -race -run TestX ./<pkg>/`
3. Pokud reprodukovatelné: `--verbose` + log inspection
4. Pokud property test: zachycený seed v output → re-run `-seed=...` musí reprodukovat
5. Vytvořit GH issue s `kind/bug` (nebo `kind/flake` pokud >2 reprodukcí v 7 dnech)

### Vitest fail

```
FAIL  tests/unit/foo.test.jsx > suite > test name
  AssertionError: expected ... to be ...
```

1. `pnpm test -- foo.test.jsx --reporter=verbose`
2. Pokud setup error (`db undefined`, `Cannot find module`): infra issue, ne test bug
3. Pokud DOM/assertion fail: real bug nebo test drift od refactoru
4. Native binding chyba (`bindings file not found`): `npm rebuild <pkg>` v root pnpm cache

### Playwright fail

```
✘  jobs-flow.spec.ts:22 › bulk-check: select rows
   TimeoutError: page.waitForResponse: Timeout 5000ms exceeded.
```

1. Lokálně s `--headed`: `pnpm exec playwright test foo.spec.ts --headed`
2. Network: zkontroluj `page.route()` mocks v souboru fixtures
3. Selector: `--debug` pro element inspection
4. Snapshot screenshots + traces v `test-results/`

## Live-env pravidla

Testy vyžadující externí service:
- **Default skip** s explicit message (`test.skip(true, 'NEEDS_LIVE_BACKEND')`).
- **Opt-in** přes env var: `LIVE_BACKEND=1 pnpm test:e2e:live`.
- **CI**: jen v dedicated `e2e-live` job po `docker compose -f infra/docker/docker-compose.yml up -d` setup.

Důvod: `make test` z čistého clone musí být zelený. Externí services jsou pro hardening, ne pro daily dev.

## Property test pravidla

```go
// CORRECT
func TestPropertyXY(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) { ... })
}
```

Při failu rapid vypíše:
```
[rapid] failed after 47 tests: arg = 0xb5,0xf8
[rapid] to reproduce, specify -run "TestPropertyXY" -rapid.failfile="testdata/foo.fail"
```

Re-run **musí** reprodukovat se seed/failfile. Pokud ne → infra bug v `rapid` setup, vytvořit issue `kind/infra`.

## Coverage threshold

Per `vitest.config.ts`:
```
thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 }
```

CI fail pokud kterákoli pod 80 %. Override jen ADR amendment.

Per Go service: zatím soft target 70 %. Měřeno přes `go test -coverprofile=coverage.out -covermode=atomic ./...` v CI.

## Mutation score

Per Stryker: target ≥60 % počáteční. Postupně zvyšovat per area. Měřeno týdně přes `make test-mutation` (slow, opt-in v lokálu).

## Audit scripts

Po dokončení S4 (audit triage):

| Skript | Účel | CI gate? |
|---|---|---|
| `audit:bundle` | Bundle size budget | Yes |
| `audit:security` | npm audit + dependency CVE | Yes |
| `audit:lighthouse` | Core Web Vitals | Informativní |
| `audit:linkage` | Test → prod code linkage analysis | Informativní |
| `audit:density` | Assertion density per test | Informativní |
| ostatní | Stuby k smazání | — |

CI gate audity blokují merge. Informativní audity loggují do `reports/`, vytváří issue `from/health-check` při driftu.

## Časté chyby (anti-patterns)

### Mockování DB v integration testech
> "Mocked tests passed but prod migration failed"

Integration testy musí hit real DB (pg-mem nebo testcontainers). Mockuj jen contract testy.

### Silent skip bez důvodu
```ts
if (!apiAvailable) return;  // BAD — neviditelný skip
```
```ts
if (!apiAvailable) return test.skip(true, 'API not available');  // GOOD
```

### Test name bez context
```go
func TestX(t *testing.T) {}  // BAD
func TestSubmitter_RetryOn5xx(t *testing.T) {}  // GOOD
```

### Záměrný throw bez expect().toThrow()
```jsx
const onClick = vi.fn(() => { throw new Error('boom') })  // padá jako uncaught
```
```jsx
expect(() => component.handleClick()).toThrow('boom')  // chytá ho
```

## Eskalace

| Symptom | Eskalace |
|---|---|
| `make test` chytá < 80 % coverage | PR fail; rozšiř testy nebo amend ADR-003 |
| Property test bez seed reprodukce | Infra bug; issue `kind/infra` |
| Flake (>3 fails / 7 days) | `kind/flake` label, fix do 1 týdne nebo skip s issue |
| Audit:security najde CVE | Patch nebo dependency override do 48h |
| Weekly health check otevře 5+ issues v jednom týdnu | Iniciativa pro test infra refactor |
| Coverage drift > 5 % vs minulý měsíc | Postmortem v Discussion + ADR amendment |
