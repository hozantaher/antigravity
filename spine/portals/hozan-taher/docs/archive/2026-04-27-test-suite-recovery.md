# Test Suite Recovery

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** Test suite rehabilitation from drift; quality gates stabilized 2026-04-30 in phase 0

**Souvisí s:** [2026-04-26-comprehensive-testing-self-healing.md](2026-04-26-comprehensive-testing-self-healing.md) — ta řeší **rozšíření** test suite. Tato iniciativa řeší **rehabilitaci** stávající suite (musí běžet a chytat bugy než přidáme dalších 910 testů).

## Kontext

Full-scope běh **38 test suites** (8 Go modulů + 9 JS/TS test scriptů + 13 audit scriptů + 8 smoke skriptů + 1 mutation) odhalil systémové problémy:

```
PASS 23 | FAIL 15 | TIMEOUT 0 | total 38 | 14.6 min
logs: /tmp/hozan-tests-14104/
```

### Diagnóza (10 strukturálních problémů)

1. **CI runuje úzký scope.** `pnpm test` (default vitest) → 0 failů. `pnpm run test:full` (TEST_SCOPE=all) → 31 failů z 5563 testů. PR gate skrývá realitu.
2. **Test count metric je gameovaný.** 1 setup error (`db undefined`) v `scrapers/mobile-de/db.test.ts` zhasne 60 testů. Skutečný počet bugů ≪ count failů.
3. **Testy nejsou self-contained.** mcp:unit + mcp:e2e + audit:load + smoke:* vyžadují live env (MCP server :3001, SOCKS proxy, relay endpoint). Žádný `pnpm test:env:up` před runem.
4. **Dead-code drift.** `features/outreach/anti-trace-relay` má jen Dockerfile + railway.toml. Go zdrojáky byly smazány, ale 6 smoke skriptů (`smoke-privacy-{r2,r4,r5,r7,all,restore}.sh`) na ně pořád odkazuje → BUILD FAIL.
5. **Verze dependencies rozbité.** `vitest@2.1.9` + `@vitest/coverage-v8@4.1.2` = MAJOR mismatch. Export `BaseCoverageProvider` neexistuje. Coverage báze rozbitá → pokrytí číslo v PR statusu = lež. Stryker mutation závisí na coverage → kaskáda.
6. **Záměrné throws padají jako uncaught.** `SendCalendar.monkey.test.jsx:423` testuje robustness (`onCellClick` vyhodí `Error('boom')`). Test sám PROŠEL, ale vitest hlásí Uncaught Exception → exit 1 → CI FAIL.
7. **Property tests bez seedu.** `TestMultipath_Property_RoundRobinIndex` failnul na `0xb5,0xf8` (run 1), prošel (run 2). Bez `-seed` nedeterministický → bug existuje, ale `go test ./...` ho catch jen občas.
8. **Audit scripty jsou stuby.** test:hallucination/density/fixture-drift/inverted-fault/shadow → 0s. Kontrolují existenci config souboru a vrací 0. Cosmetic checks.
9. **Žádný kanonický runner.** `go test ./...` z workspace rootu nefunguje (musíš per-modul). `pnpm -r test` přejde JS workspaces, ale Go modules jsou mimo. Nikdo neumí spustit "všechno".
10. **Žádná governance.** CLAUDE.md říká "≥10 test cases per change" + "extreme testing" → kvantita bez kvality. Když coverage tooling nefunguje a nikdo si nevšimne, je to **organizační problém**.

### Reálné bugy nalezené tímto runem (priorita FIX)

| # | Suite | Bug |
|---|---|---|
| B1 | `go:mailboxes/watchdog` | `TestDaemonAlertWebhook` + `TestDaemonAuthAlert_Cooldown` flake (timing race) |
| B2 | `go:relay/internal/relay` | `TestMultipath_Property_RoundRobinIndex` — round-robin invariant porušen na input `0xb5,0xf8` |
| B3 | `go:relay/internal/transport/onion` | `TestWaitReadySucceedsWhenPortIsOpen` — Tor manager `WaitReady()` context deadline |
| B4 | `js:dashboard:full` (TEST_SCOPE=all) | 30 dalších failů viditelných jen v širším scope (default je nezachytí) |
| B5 | `js:scrapers/mobile-de/db.test.ts` | `db` undefined v `afterEach` → setup nikdy neuspěl, padá 61 testů ze 6 souborů |

## Cíle

1. **Všechny reálné bugy fixnuté nebo explicitně odložené s issue.** B1–B5.
2. **Kanonický runner v repu** (`scripts/test-all.sh` nebo `make test`) co spustí kompletní povrch a vypíše progressbar + summary.
3. **Coverage + mutation reálně funguje.** PR status reportuje skutečné číslo, ne lež.
4. **CI pipeline runuje plnou suite** (= co kanonický runner), nejen úzký default scope.
5. **Test infra owner + měsíční health check.** Skript `scripts/test-health.mjs` reportuje rozbité audit skripty, dead-code drift, dep mismatchy.
6. **Dead code & dead smoke skripty pryč** (anti-trace-relay), nebo přepsané na current arch.

## Non-cíle

- Nepřidáváme **žádné nové testy** — to dělá iniciativa 2026-04-26-comprehensive-testing-self-healing až tohle skončí.
- Nepřepisujeme audit skripty na funkční verzi — buď smazat, nebo dokumentovat jako stub.
- Neměníme test framework (vitest zůstává, jen sjednotit verze).

## Plán (sprinty)

### Sprint S1 — Stop the bleeding (1 den)

Cíl: opravit 5 reálných bugů + odstavit dead-code suites tak, aby kanonický run dal 100 % pass na tom, co reálně máme.

- [ ] **S1.1** B5 — fix `features/acquisition/scrapers/mobile-de/db.test.ts` `beforeEach`/`afterEach`: chybí `db = await openDb()`. Po fixu: `pnpm --filter @hozan/scrapers test` → 0 fail.
- [ ] **S1.2** B1 — `features/outreach/mailboxes/watchdog/`: izolovat časovací race v `TestDaemonAlertWebhook` + `TestDaemonAuthAlert_Cooldown`. Repro: `go test -count=20 -race ./...`. Fix: deterministic clock injection (`clockwork.NewFakeClock()`) místo `time.Now()`.
- [ ] **S1.3** B2 — `features/outreach/relay/internal/relay/property_monkey_test.go:170`: round-robin invariant. Reprodukovatelné se seedem (přidat `-seed=…`), pak fix algoritmu.
- [ ] **S1.4** B3 — `features/outreach/relay/internal/transport/onion`: `TestWaitReadySucceedsWhenPortIsOpen`. Buď stubnout Tor manager pro CI (interface + fake), nebo skipnout pokud `TOR_BIN` není v PATH.
- [ ] **S1.5** B4 — `features/platform/outreach-dashboard`: spustit `TEST_SCOPE=all pnpm test --reporter=verbose` lokálně, kategorizovat 31 failů, fixnout nebo `.skip` s issue trackerem.
- [ ] **S1.6** Smazat 6 smoke skriptů které referencují smazaný `features/outreach/anti-trace-relay`: `services/smoke-privacy-{r2,r4,r5,r7,all,restore}.sh`. Ponechat jen `r3`, `r6` (prošly). Pokud někdo chce smoke pro current architekturu (privacy-gateway+relay), napsat čistě v S3.
- [ ] **S1.7** Smazat `modules/outreach/cmd/` (prázdný) + `modules/outreach/internal/` (jen `db/`). Smoke r2 to už dál nezkontroluje.

**Acceptance:** `bash scripts/test-all.sh` (vytvořený v S2) → 100 % pass na tom co zbylo (≥30 suites z původních 38).

### Sprint S2 — Kanonický runner + CI integrace (1 den)

Cíl: 1 příkaz spustí všechno. CI to taky umí.

- [ ] **S2.1** Vytvořit `scripts/test-all.sh` (port `/tmp/run-all-tests.sh` z této session, ale z repu, ne z `/tmp`). Suites enumerované deklarativně (label|kind|dir|cmd|timeout). Progressbar + summary.
- [ ] **S2.2** Přidat `scripts/test-all.mjs` jako alternativu (Node verze pro Windows-friendly devs). Sdílí enumeraci s shell verzí přes `scripts/test-all.suites.json`.
- [ ] **S2.3** Přidat `Makefile` s targets: `make test`, `make test-go`, `make test-js`, `make test-smoke`, `make test-health`.
- [ ] **S2.4** GitHub Actions workflow `.github/workflows/test-all.yml`: matrix [go, js-unit, js-integration, js-e2e]. Spouští `scripts/test-all.sh --filter=<kind>`. Cache na pnpm + go module cache.
- [ ] **S2.5** Aktualizovat root `README.md` + `CLAUDE.md` — přidat sekci "Running tests" s jednou cestou.
- [ ] **S2.6** Aktualizovat `features/platform/outreach-dashboard/package.json`: `test:full` přejmenovat na `test`, `test` (default úzký) na `test:fast`. Aby `pnpm test` defaultně runul reálný full scope.

**Acceptance:**
- `bash scripts/test-all.sh` z čistého clone (po `pnpm i`) → projde.
- CI workflow zelený na `main` po dokončení S1.

### Sprint S3 — Dependency hygiene + coverage (1 den)

Cíl: pokrytí + mutation reálně funguje. Test deps jsou aligned.

- [ ] **S3.1** `pnpm add -D @vitest/coverage-v8@2.1.9 -w` (přesně match `vitest@2.1.9`). Ověřit `pnpm run test:coverage` → reportuje `coverage/lcov.info`.
- [ ] **S3.2** Audit všech `vitest`-related deps napříč workspaces (`pnpm why vitest`, `pnpm why @vitest/*`). Sjednotit přes `pnpm-workspace.yaml` `overrides`.
- [ ] **S3.3** `features/platform/outreach-dashboard/stryker.conf.js` — ověřit kompatibilita s vitest 2.1.9. Spustit `pnpm run test:mutation` → vrátí mutation score (i kdyby nízké).
- [ ] **S3.4** Vrátit `features/platform/mcp/test:e2e` do funkčního stavu: spec spouští MCP server jako child proces s `beforeAll`/`afterAll`, NE odkazuje na `localhost:3001` z venku. Stejně tak `features/platform/mcp/test`.
- [ ] **S3.5** `features/platform/outreach-dashboard/playwright.config.js` přidat `webServer: { command: 'pnpm dev', port: 5173, reuseExistingServer: true }`. E2E nesmí vyžadovat ručně boot serveru.
- [ ] **S3.6** Vytvořit `tests/e2e/fixtures/jobs.ts` (chyběl import v `jobs-flow.spec.ts`).
- [ ] **S3.7** Opravit `audit:load` (`scripts/load.mjs`): skip pokud `:3001` neodpovídá s ENV varem `LOAD_BASE_URL`. Default = skip ne fail.
- [ ] **S3.8** Vitest config: `dangerouslyIgnoreUnhandledErrors: true` JEN pro `**/SendCalendar.monkey.test.jsx` přes `test.fails` nebo obal `expect(...).rejects.toThrow()`. Lepší: opravit test aby používal `expect(handleClick).toThrow()` místo nechycené exception.

**Acceptance:**
- `pnpm run test:coverage` → produkuje LCOV report ≥ 0 řádků.
- `pnpm run test:mutation` → finishne s mutation score (jakýmkoliv).
- `pnpm run e2e` → projde bez ručního boot serveru.

### Sprint S4 — Audit skripty: prosít stuby (1 den)

Cíl: každý `test:*` v `package.json` je buď reálný test, nebo dokumentovaný stub.

- [ ] **S4.1** Pro každý z 13 audit scriptů (`test:bundle`, `test:security`, `test:linkage`, `test:density`, `test:hallucination`, `test:lighthouse`, `test:flaky`, `test:fixture-drift`, `test:load`, `test:inverted-fault`, `test:shadow`, `test:snapshot`, `test:explain*`):
  - Číst `scripts/<name>.mjs` zdrojáky.
  - Roztřídit: REAL (provádí measurement + asserts), STUB (vrací 0), MAINTENANCE (nepatří mezi `test:*`).
- [ ] **S4.2** STUBy buď smazat, nebo přejmenovat na `audit:stub:*` aby bylo jasné že nejsou validační.
- [ ] **S4.3** MAINTENANCE skripty (`test:explain*`, `test:hallucination-baseline`, `test:snapshot`, `test:shadow`) přejmenovat na `tools:*`.
- [ ] **S4.4** REAL audity dokumentovat v `docs/playbooks/audit-scripts.md` — co měří, jak interpretovat výstup, co je acceptance threshold.

**Acceptance:** `features/platform/outreach-dashboard/package.json` má jasné rozdělení `test:*` (CI gating) vs `audit:*` (informativní) vs `tools:*` (utility).

### Sprint S5 — Test health monitoring (0.5 dne)

Cíl: budoucí drift se objeví týdně, ne za 6 měsíců.

- [ ] **S5.1** `scripts/test-health.mjs`:
  - Pro každý `test:*` script: spusť, zaznamenej duration + exit code.
  - Detekuj "0s pass" anomálie (= stub).
  - Detekuj missing dep (pomocí `pnpm outdated`, `npm audit`).
  - Detekuj smoke skripty referencující neexistující soubory.
  - Detekuj test soubory bez `expect(...)` calls (= no-op testy).
  - Output: `reports/test-health.json` + Markdown summary.
- [ ] **S5.2** GitHub Actions weekly job `.github/workflows/test-health.yml` (každé pondělí 8:00) — spustí `test-health.mjs`, vyhodí GitHub issue pokud detekuje regresi proti `reports/test-health.baseline.json`.
- [ ] **S5.3** Zavést konvence komentář v `package.json`: `"// test:foo": "REAL — gates PR"` / `"// audit:bar": "STUB — placeholder"`.

**Acceptance:** první run `node scripts/test-health.mjs` reportuje stav suite. Baseline commitnut.

### Sprint S6 — Governance + dokumentace (0.5 dne)

Cíl: nikdo už nenapíše test bez vědomí kde + jak ho spustit.

- [ ] **S6.1** Vytvořit `docs/playbooks/test-strategy.md`:
  - Test pyramida (unit / contract / integration / e2e / smoke / property / mutation)
  - Jak spustit lokálně, jak spouští CI, jak interpretovat fail
  - Pravidla pro live-env testy (env-vars, docker-compose, opt-in flag)
  - Pravidla pro property testy (vždy `-seed` v failu, deterministic replay)
- [ ] **S6.2** Update `CLAUDE.md` — sekce "Service-local rules":
  - Per-service: jaký runner pustit, jaký coverage threshold, kde jsou e2e
  - "≥10 test cases per change" → upravit na "alespoň 1 reálný test co by failnul před fixem" (kvalita > kvantita)
- [ ] **S6.3** ADR napsat: `docs/decisions/ADR-NNN-test-suite-governance.md` — proč single canonical runner, proč coverage tooling sjednoceno na vitest 2.1.9, proč audit/test/tools split.
- [ ] **S6.4** Owner pro test infra → zaznamenat v ADR. Default = Chat A.

**Acceptance:** ADR mergnut, playbook v `docs/playbooks/`, CLAUDE.md aktualizováno.

## Blokátory

- (žádné — vše je local refactor, žádný external dep)

## Otevřené otázky

- B3 (Tor `WaitReady` deadline) — chceme realný Tor v CI nebo stub? **Default**: stub, real v `test:e2e:live` (opt-in přes `TOR_BIN=/usr/local/bin/tor`).
- audit:load — má sloužit jako PR gate (= nutí mít backend), nebo informativní (= skip bez ENV)? **Default**: skip + opt-in.
- 30 failů v `dashboard:full` — co když 20+ jsou reálné bugs? Sprint S1.5 to zjistí.

## Log

- 2026-04-27 — založeno; diagnóza z full-scope běhu 38 suites (PASS 23 / FAIL 15)
