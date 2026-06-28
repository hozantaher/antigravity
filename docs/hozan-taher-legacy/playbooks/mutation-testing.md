# Mutation Testing — playbook

> **Sprint:** KT-B9 (initiative
> [B-quality](../initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md))
> **Stav (2026-04-30, after survivor rescue):** **79.43%** —
> `features/platform/outreach-dashboard`,
> `src/lib/{suppression-union,suppressionFilter,llmReplyClassifier}.js`.
> Cíl iniciativy ≥75% **splněn**. Per-soubor: suppression-union 73.13%,
> suppressionFilter 100%, llmReplyClassifier 82.86%. Original baseline
> byl 66.29%.

## Co to je a proč

Mutation testing aplikuje malé úmyslné regrese do produkčního kódu (`x ===
y` → `x !== y`, `>` → `>=`, `'foo'` → `''`, …) a spouští testy. Mutant
**killed** = test spadl. Mutant **survived** = chybí test, který by tu
změnu zachytil. Tj. odhalí díry, které normální line/branch coverage
neukáže.

V hozan-taher to běží přes Stryker (`@stryker-mutator/core` +
`@stryker-mutator/vitest-runner`). Konfigurace je per-modul — viz
[features/platform/outreach-dashboard/stryker.conf.mjs](../../features/platform/outreach-dashboard/stryker.conf.mjs).
Konfigurace musí ukazovat na `vitest.config.ts`, **ne** na `vite.config.js`
(viz memory `project_stryker_setup`).

## Jak spustit lokálně

```bash
cd features/platform/outreach-dashboard
pnpm test:mutation                                    # plný scope (~35 s)
pnpm exec stryker run --mutate src/lib/<file>.js      # jeden soubor
```

Reporty: `features/platform/outreach-dashboard/reports/mutation/index.html`. Otevři
v prohlížeči, klikni na soubor → vidíš každý survived mutant + diff.

## Jak číst report

| Sloupec | Význam |
|---|---|
| `% Mutation score total` | Killed / (killed + survived + timeout) |
| `# killed` | Test spadl → mutace zachycena |
| `# survived` | **Díra v testech** — žádný test si nevšiml |
| `# timeout` | Test se zacyklil → počítá se jako killed |
| `# no cov` | Mutant na řádku, který žádný test nespustí |

`# survived` a `# no cov` jsou akční — každý znamená "napiš nový test
nebo rozšiř existující".

## Ratchet (ikonický one-way)

Baseline je `thresholds.break` v `stryker.conf.mjs`. Když si někdo přidá
nový test, který killne dosud-survived mutanta, **zvedni `break`** na
nové měřené minus 5pp safety margin. Nikdy nesnižuj — to by retro-uzavřelo
regrese.

CI: `.github/workflows/mutation-testing.yml` — cron týdně (Po 04:00 UTC)
+ manual `workflow_dispatch`. Per-PR gate záměrně **není** (běh trvá
30+ min na full repo a duplikoval by signál z hallucination-score gatu).

## Když survived mutant je prokazatelně nemožný

(equivalent mutant — sémanticky shodný kód) → přidej do
`mutator.excludedMutations` v `stryker.conf.mjs` s komentářem proč. Nikdy
ne `// stryker-disable next-line` v produkčním kódu (rozptyluje při
review).

## Rozšíření scope

Dnes mutuje pouze `src/lib/{suppression-union,suppressionFilter,llmReplyClassifier}.js`.
Než přidáš další soubor:

1. Ověř, že má unit-test suite v `tests/unit/lib/` co stabilně prochází.
2. Spusť `pnpm exec stryker run --mutate src/lib/<file>.js` pro odhad.
3. Když total > 5 min, soubor je moc velký — rozděl nebo nech mimo scope.
4. Přidej do `mutate` array v `stryker.conf.mjs`.
