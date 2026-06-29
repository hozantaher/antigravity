# docs/rollups/

Týdenní rollupy projektu hozan-taher. Každý pátek 30 min review — viz runbook
[`docs/playbooks/WEEKLY-ROLLUP.md`](../playbooks/WEEKLY-ROLLUP.md).

## Struktura

- `TEMPLATE-weekly.md` — markdown template s `{{PLACEHOLDER}}` poli
- `YYYY-WW-weekly.md` — konkrétní rollup pro ISO týden (např. `2026-W17-weekly.md`)

## Workflow

1. **Generuj:** `./scripts/weekly-rollup.sh` z root repa
   - defaultně `today - 7 days` .. `today`, nebo předej explicit dates:
     `./scripts/weekly-rollup.sh 2026-04-15 2026-04-21`
2. **Review + dopiš** ručně (Notable, Blockers, Next week focus, Audit delta interpretaci)
3. **Commit** pod `chore(rollup): week YYYY-WWNN`

## Retence

- **6 měsíců** v této složce
- Starší → `docs/archive/rollups-YYYY/`
- Starší než 2 roky → odstranit (historie je v gitu)

## Purpose

Visibility → drift prevention. Rollup sám nic nefixuje, ale odhalí pattern:
audit dluh rostoucí 2 týdny v řadě, PR stárnoucí bez pohybu, CI pass rate
klesající. **Findings → akce v [`DISCIPLINE.md`](../playbooks/DISCIPLINE.md)
(SLA eskalace, consolidation week, feature freeze).**
