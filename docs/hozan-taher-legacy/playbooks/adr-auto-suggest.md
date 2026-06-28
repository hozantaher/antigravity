# ADR auto-suggest playbook

> **Status:** Active
> **Date:** 2026-05-01
> **Trigger:** north-star aspirace #8 — pre-merge hook scans diff for architectural patterns.

## Co to dělá

Při každém open / sync PR proti `main` běží
`.github/workflows/adr-auto-suggest.yml`. Workflow zavolá
`scripts/audit/adr-suggest.sh`, který skenuje diff + commit messages
proti 8 heuristikám. Když match, bot přidá / aktualizuje jeden komentář
na PR s ADR template snippetem k vyplnění.

Není to merge gate — autor může ignorovat nebo `/skip-adr <důvod>`.

## Heuristiky (8)

| ID | Trigger | Příklad |
|---|---|---|
| H1 | Nový top-level adresář pod `services/` | `features/platform/llm-runner/` |
| H2 | Commit message obsahuje `design`, `architecture`, `ADR-NNN`, nebo `Decision:` trailer | `feat: design new transport` |
| H3 | Nový soubor `scripts/migrations/NNN_*.sql` | `005_contacts_status_sync.sql` |
| H4 | Nový top-level adresář pod `packages/` nebo `modules/` | `packages/relay-client/` |
| H5 | `Breaks-Contract:` trailer v commit body | API/event/schema změna |
| H6 | Nový soubor pod `services/*/internal/{auth,security}/` | `services/bff/internal/auth/oauth.go` |
| H7 | Přidání `envconfig.Required(` v novém `cmd/<svc>/main.go` | nová boot schema |
| H8 | Nový soubor `.github/workflows/<new>.yml` | CI rozšíření |

Heuristiky jsou conservative: false-positive cost = jeden ignorovatelný
komentář, false-negative cost = chybějící ADR pro reálnou architektonickou
změnu. Volíme spíš false-positive.

## Co dělat když workflow zakřičí

1. **Otevři komentář na PR.** Komentář obsahuje seznam triggered
   heuristik + detected paths + fill-in-the-blank ADR template.
2. **Posuď: je to architektonické rozhodnutí?**
   - Ano → vytvoř `docs/decisions/ADR-NNN-<slug>.md` z templatu, commit
     do PR (= součást změny, ne separate PR).
   - Ne → reply `/skip-adr <důvod>` (např. "refactor only, no decision").
3. **Po merge** je ADR součástí stejného PR, takže history je atomická.

## Co dělat když workflow neřekne nic ale ADR potřebuješ

Heuristiky jsou dolní hranice. Pokud autor / reviewer cítí
architektonické rozhodnutí (např. nová cron strategie, nová
deployment topologie) → manually vytvoř ADR. Workflow je safety net,
ne authoritative gate.

## Lokální použití skriptu

```bash
# Default: diff vs origin/main
bash scripts/audit/adr-suggest.sh

# Explicit base
bash scripts/audit/adr-suggest.sh --base origin/develop

# Explicit range
bash scripts/audit/adr-suggest.sh --range main...HEAD

# Past PR (vyžaduje gh CLI)
bash scripts/audit/adr-suggest.sh --pr 442
```

Exit codes:
- `0` — žádný architektonický pattern, žádný komentář
- `10` — pattern detected, payload na stdout
- `64` — bad usage
- `2` — `gh` chybí v `--pr` módu

## Idempotency

Workflow používá hidden marker `<!-- adr-auto-suggest:v1 -->` na začátku
komentáře. Druhý + N-tý sync update existující komentář místo posílání
nového. Žádný spam.

## Když chceš změnit heuristiky

1. Edituj `scripts/audit/adr-suggest.sh` — přidej `detect_h9_*` funkci
2. Přidej do `TRIGGERED` aggregator bloku
3. Aktualizuj tabulku v tomto playbooku
4. Test: `bash scripts/audit/adr-suggest.sh --range origin/main...HEAD`
   na nějakém recent PR co fired

## Reference

- [project_autonomous_dev_north_star aspirace #8](../../../.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory/project_autonomous_dev_north_star.md)
- `.github/workflows/recurring-inventory.yml` — pattern source pro CI flow
- `docs/decisions/README.md` — ADR format spec
- PR #439 — recurring-inventory (precedent autonomy workflow)
