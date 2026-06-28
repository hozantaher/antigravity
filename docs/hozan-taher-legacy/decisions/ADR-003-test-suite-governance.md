# ADR-003 — Test Suite Governance

**Status:** Accepted
**Date:** 2026-04-27
**Supersedes:** —

## Kontext

Repo má ~11 000 testů (5 970 Go + 5 248 JS/TS). Při full-scope běhu vyšlo najevo:

1. **CI runuje úzký scope.** `pnpm test` (default vitest) → 0 failů. `pnpm test:full` (TEST_SCOPE=all) → 31 failů z 5 563 testů. PR gate skrývá realitu.
2. **Žádný kanonický runner.** `go test ./...` z workspace rootu nefunguje (musíš per-modul). `pnpm -r test` přejde JS workspaces, Go modules jsou mimo. Nikdo neví jak spustit "všechno".
3. **Verze závislostí rozbité.** vitest@2.1.9 + @vitest/coverage-v8@4.1.2 = MAJOR mismatch. Coverage báze rozbitá → pokrytí číslo v PR statusu = lež. Stryker mutation závisí na coverage → kaskáda.
4. **Audit scripty jsou stuby.** test:hallucination/density/fixture-drift/inverted-fault/shadow vrací 0 v <1s. Cosmetic checks bez assertů.
5. **Dead-code drift.** Smoke skripty `smoke-privacy-{r2,r4,r5,r7,all,restore}.sh` referencují smazaný `features/outreach/anti-trace-relay`.
6. **Test count metric je gameovaný.** 1 setup error (db undefined) zhasne 60 testů. Skutečný počet bugů ≪ count failů.
7. **Žádná governance.** "≥10 test cases per change" + "extreme testing" → kvantita bez kvality.

Iniciativa [2026-04-27-test-suite-recovery](../initiatives/2026-04-27-test-suite-recovery.md) řeší rehabilitaci. Tento ADR fixuje **operační konvence**, aby drift nebyl možný za 6 měsíců.

## Rozhodnutí

Zavádíme následující governance:

### 1. Single canonical runner

`scripts/test-all.sh` (+ `Makefile`) je **jediná oficiální cesta** spustit testy. Pokrývá Go workspace + pnpm workspaces + audit scripty + smoke + mutation. Filtry: `--filter=go`, `--filter=js`, `--filter=audit`, `--filter=smoke`, `--filter=area/<name>`, `--skip-mutation`, `--skip-smoke`.

PR contributors běží `make test` před push. CI běží stejný `make test` v pipeline. Dev sessions, ralhinho RFC pipelines, autonomous bot worker — všichni používají stejný runner.

### 2. Vitest version locked + aligned

`vitest`, `@vitest/coverage-v8`, `@stryker-mutator/vitest-runner` musí mít kompatibilní major verze. Lock-step upgrade = single PR co updatuje všechny tři současně. Drift = červený CI per `scripts/test-health.mjs` (S5 v initiative).

### 3. Default scope MUSÍ být reálný full scope

`pnpm test` (default vitest run) defaultně používá `TEST_SCOPE=all` po dokončení S2.6. Úzký scope dostupný přes `pnpm test:fast`. Default = pravda; opt-in pro rychlost.

### 4. Per-test naming convention pro discoverability

- Real test: `tests/{unit,integration,contract,e2e,property,chaos}/<file>.test.{ts,jsx}`
- Audit script: `scripts/audit-<name>.mjs` + `package.json` script `audit:<name>`
- Maintenance helper: `scripts/tools-<name>.mjs` + `package.json` script `tools:<name>`
- Stub: NIKDY nezůstává jako `test:*` script. Buď smaž, nebo přejmenuj na `audit:stub:*`.

### 5. Property tests musí mít determ. seed v failu

Při fail `go test` property/fuzz vypíše seed. Re-run `-seed=...` musí reprodukovat. Pokud test nemá deterministic replay → bug v test infra, ne v testovaném kódu.

### 6. Live-env testy oddělené

Testy vyžadující běžící backend / SOCKS proxy / Tor / SMTP server jsou ve scriptu `test:e2e:live` nebo skipnuté default přes `process.env.LIVE_BACKEND`. Default test run nesmí selhat protože něco neběží. Žádné silent-skip — fail explicit s "skip protože XX neběží".

### 7. Coverage threshold + mutation score = jediná governance metrika

- vitest `thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 }` per package.
- Stryker mutation score ≥ 60 % per package (postupně zvyšovat).
- Žádné jiné "kvalita" metriky (linkage, density, hallucination, fault, shadow, snapshot) NEJSOU CI gate. Jsou informativní; mohou viset jako weekly health check, ne PR blocker.

### 8. Test infra owner

Owner: **Chat A (dev)**. Backup: **uživatel** (Tomáš). Bot worker NEMÁ pravomoc měnit test infra (vitest config, runner script, CI workflows) bez explicitního `automation/ok` na issue + dvojitý review.

### 9. Weekly health check je závazný

`scripts/test-health.mjs` běží každé pondělí 8:00 UTC (`.github/workflows/test-health.yml`). Drift = GH issue s `from/health-check` + reprioritizer ho hodí na P1. Ignorování > 4 týdny = automation/blocked + eskalace.

## Důsledky

### Pozitivní

- **Jednotná pravda** o tom co testy říkají. PR coverage % je reálné.
- **Onboarding-friendly**: nový dev spustí `make test`, vidí výsledek, nečte 5 různých CLAUDE.md.
- **Bot-friendly**: autonomous worker volá `make test-area AREA=<x>` pro affected suite, nemusí vědět per-service triky.
- **Drift je viditelný**: weekly health check + GH issue.
- **Eliminuje stub spam**: 13 audit scriptů → ~5 reálných + zbytek smazán/přejmenován.

### Negativní

- **Migrace bolí**: existující CI workflows (`go-services-ci.yml`, `node-services-ci.yml`, `test-quality.yml`) musí přejít na `make test-*` orchestraci. Postupný cutover.
- **`pnpm test` po S2.6 bude pomalejší** (full scope vs současný úzký). Mitigace: `test:fast` alias pro dev iteration.
- **Mutation testing je drahé** (30+ min). Threshold ≥60 % první kolo bude vysoký bar. Postupně zvyšovat.
- **Override pravidel = ADR amendment**. Žádné ad-hoc skip-coverage v PR.

### Neutrální

- **Konfigurační režije**: jeden `vitest.config.ts` + `vitest.workspace.ts` per repo. Single source.
- **Audit scripty**: některé zůstávají jako informativní (lighthouse, bundle, security). Označené `audit:` prefixem.

## Alternativy zvažované

### Alt 1 — Status quo (per-service runner, žádný kanonický)
- Nulová migrace.
- **Proč ne**: Dnes nikdo neví jak spustit "vše" (já 2× minul scope v té samé session). Drift se prohlubuje.

### Alt 2 — Bazel / Nx monorepo runner
- Industry-standard pro polyglot monorepa.
- **Proč ne**: Setup overhead pro ~10 services je ~3 měsíce. `make test` + `scripts/test-all.sh` dosáhne 90 % užitku za 1 den.

### Alt 3 — Per-PR scope detection (jen affected tests)
- Rychlejší CI.
- **Proč ne**: Předmětem oddělené iniciativy. Nejdřív musí být `make test` reliabilní baseline. Pak lze přidat filter dle changed files.

### Alt 4 — TEST_SCOPE jako per-PR opt-in (ne default)
- Backwards-compat.
- **Proč ne**: Skrývá realitu (původní problém #1). Default = pravda.

## Související

- ADR-002 — Autonomous Ops Architecture (orthogonal — bot worker volá `make test-area`)
- Initiative `2026-04-27-test-suite-recovery` (implementace tohoto ADR)
- Memory: `feedback_extreme_testing` (revidováno: kvalita > kvantita)
