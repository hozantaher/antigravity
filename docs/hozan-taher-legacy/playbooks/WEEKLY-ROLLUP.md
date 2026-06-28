# WEEKLY ROLLUP — týdenní 30min projektový review

**Status:** active
**Owner:** tomas
**Kind:** operational runbook (recurring)
**Cadence:** pátek, 30 min (17:00–17:30 lokálně)

## Kdy a proč

Každý pátek 30 min projít, co se reálně zavřelo, co zůstává viset, jak se hnul
audit dluh. Cíl je **visibility → drift prevention** — vyhnout se opakování
2026-04-17/21, kdy audit dluh rostl rychleji, než se zavíral, a nikdo to nezachytil,
dokud nebyl projekt v deadlock stavu (10/10 CI red, PR #8 CONFLICTING >24h, 65
HIGH/MEDIUM bugs bez fixů).

Rollup **není status reporting** — je to **týdenní kontrola zdraví systému**:
zachytit trendy dřív, než se stanou incident.

## Inputs (data collection checklist)

Dělá se z `main` worktree. Data získáváme z `gh` CLI + `git log` — skript
`scripts/weekly-rollup.sh` většinu sesbírá automaticky, ale čísla si reviewer
**musí ověřit** než je uloží.

| Co | Kde/jak | Proč |
|---|---|---|
| PRs merged tento týden | `gh pr list --state merged --limit 50 --search "merged:>=YYYY-MM-DD"` | Velocity signál |
| PRs still open | `gh pr list --state open --limit 30` | Aging detection |
| Issues closed tento týden | `gh issue list --state closed --search "closed:>=YYYY-MM-DD"` | Bug throughput |
| Commits na main | `git log --since=YYYY-MM-DD --oneline main` | Aktivita baseline |
| CI pass rate tento týden | `gh run list --limit 50 --json conclusion --jq '[.[] \| select(.conclusion!=null)] \| group_by(.conclusion) \| map({status: .[0].conclusion, count: length})'` | Zdraví CI |
| Memory delta | `git log --since=YYYY-MM-DD -- memory/` na `~/.claude/projects/<projekt>/memory/` | Co se nově auditovalo/vyřešilo |
| Audit debt per service | `memory/project_*_quality_debt.md` head diff vs last week | Drift heuristika |

Pokud `gh` kroky selhávají auth chybou, `gh auth status` a re-login.

## Output template

Do `docs/rollups/YYYY-WW-weekly.md` (ISO week, např. `2026-W17-weekly.md`).
Template je v [`docs/rollups/TEMPLATE-weekly.md`](../rollups/TEMPLATE-weekly.md),
skript ho zkopíruje a předvyplní placeholdery. Reviewer **dopíše analýzu** —
template je struktura, ne autofill.

**Minimum k vyplnění ručně:**

- Notable commits (které změny stojí za zmínku)
- Blockers / risks (co hrozí příští týden)
- Next week focus (3–5 bullet items)
- Audit debt delta per service (interpretace čísel — roste to nebo klesá?)

## Kam uložit

```text
docs/rollups/
├── README.md
├── TEMPLATE-weekly.md
├── 2026-W17-weekly.md      ← tento týden
├── 2026-W16-weekly.md
└── 2026-W15-weekly.md
```

Retence: **6 měsíců**. Starší rollupy → `docs/archive/rollups-YYYY/`.

## Co dělat s findings

Rollup **sám o sobě nic nefixuje** — jen odhalí pattern. Akce:

| Finding | Akce |
|---|---|
| HIGH audit item > 7 dní bez fixu | Eskaluj v DISCIPLINE.md `Audit → Fix SLA`: přesun do GitHub issue s ownerem, nebo remove jako "won't fix" s důvodem v `memory/*_quality_debt.md` |
| PR open > 3 dny bez pohybu | Weekly rollup rozhoduje: merge / rebase / close (viz `DISCIPLINE.md` → `Co dělat když`) |
| CI pass rate < 80 % | Stop-the-line: otevři P0 tasklink, fix před další feature |
| Audit debt delta roste 2 týdny v řadě | Vyhlas "consolidation week" — feature freeze, jen audit fixes |
| Memory obsahuje nový `*_quality_debt.md` bez tracking PR | Otevři GitHub issue nebo zařaď do příštího sprint planu |

## Odkazy

- [`DISCIPLINE.md`](./DISCIPLINE.md) — merge gate, DoD, SLA pro audit
- [`docs/rollups/TEMPLATE-weekly.md`](../rollups/TEMPLATE-weekly.md) — markdown struktura
- [`docs/rollups/README.md`](../rollups/README.md) — složka purpose + retence
- [`scripts/weekly-rollup.sh`](../../scripts/weekly-rollup.sh) — automatizační helper
- [`docs/initiatives/2026-04-22-discipline-and-domain-migration.md`](../initiatives/2026-04-22-discipline-and-domain-migration.md) — P2-2 kontext
