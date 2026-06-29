# Bootstrap — wm/development worktree (Chat A)

**Cesta:** `/Users/messingtomas/Documents/Projekty/hozan-taher-dev`
**Branch:** `wm/development`
**Role:** feature work — Go backend (`modules/outreach/`), React frontend (`features/platform/outreach-dashboard/`), Express BFF, infrastruktura

## Start turn

```bash
cd /Users/messingtomas/Documents/Projekty/hozan-taher-dev
git fetch origin
git rebase origin/main
# Pokud rebase skipne vlastní commity jako cherry-pick (normální po squash-merge):
#   → v pořádku, pokračuj
# Pokud conflict:
#   → vyřešit manuálně, NE `git rebase --abort`
cat ../hozan-taher/docs/handoff/BOARD.md
gh pr list --state open --json number,title,headRefName,body
```

Přečíst:
1. Sekci "Active — wm/development" (co mám rozdělané)
2. Sekci "Cross-branch signals" (zprávy od Chatu B)
3. Open PRs z `wm/tests` (co Chat B zrovna testuje)

## Aktivní iniciativa: Kampaň výkupu techniky (od 2026-04-30)

Chat A pracuje na 15 sprintech označených KT-A1 až KT-A15 (GH issues #295-#309). Pořadí čtení dokumentů:

1. [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-master.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md) — společný cíl, hard rules, hand-off protokol
2. [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-A-build.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-A-build.md) — všech 15 sprintů Chat A v lidštině s přesnými acceptance kritérii
3. BOARD.md sekce "Aktivní iniciativa" — aktuální sprint cursor + pořadí

Aktuální sprint vždy v BOARD.md sekci "Active — wm/development". Po dokončení sprintu zavřít odpovídající GH issue (#295-#309) komentářem s odkazem na merged PR a posunout cursor v BOARD.

## Anti-drift kontrola (vždy na začátku session)

```bash
git log --oneline origin/main..HEAD   # co mám lokálně navíc
git log --oneline HEAD..origin/main   # co mi chybí z main
```

Behind > 10 → něco jsi propásl, rebase first.

## Práce — TDD loop

```bash
# Go (pokud měníš modules/outreach/)
cd modules/outreach
go test ./... -race                                 # full suite
go test -run TestXxx ./internal/foo/ -race -v       # targeted

# React (pokud měníš features/platform/outreach-dashboard/)
cd features/platform/outreach-dashboard
pnpm test                                           # vitest watch mode
pnpm test -- --run path/to/file.test.jsx            # single file
pnpm build                                          # sanity check před commitem
pnpm e2e                                            # Playwright E2E
```

**Self-healing loop:** implementuj → testuj → selže? → oprav → testuj. Autonomně, bez zastavení (dle CLAUDE.md).

## End turn

1. **Commit** s trailerem (pokud zavádíš novou funkcionalitu nebo měníš kontrakt):
   ```
   feat(<scope>): <popis>

   Needs-Tests: <modul> <co potřebuje pokrytí>
   Breaks-Contract: <api|event|schema>   # volitelně, jen pokud změna breaking
   ```

2. **Push** na `wm/development`:
   ```bash
   git push origin wm/development
   ```

3. **PR** s trailery zopakovanými v body (pre-merge signál pro Chat B skrz `gh pr list`):
   ```bash
   gh pr create --base main --head wm/development --title "feat(...): ..." --body "..."
   ```

4. **Po merge** aktualizuj `docs/handoff/BOARD.md` sekci "Active — wm/development" **přímo na main**:
   ```bash
   cd /Users/messingtomas/Documents/Projekty/hozan-taher
   git pull --ff-only origin main
   # edit docs/handoff/BOARD.md (pouze svou sekci + Cross-branch signals pokud odpovídáš B→A)
   git commit -am "chore(board): dev update"
   git push origin main
   ```

## Post-merge sync (MUSÍ po každém squash-merge tvého PR)

Squash-merge v main = nová SHA, `wm/development` remote drží starou. Bez sync = Chat B rebase selže příště.

```bash
cd /Users/messingtomas/Documents/Projekty/hozan-taher-dev
git fetch origin
git rebase origin/main                  # git skipne cherry-picked commity
git push --force-with-lease origin wm/development
```

`--force-with-lease` ne `--force`: chrání před přepsáním cizí práce mezitím.

## Zakázané

- Direct push do `main` krom `docs/handoff/*.md` a `CLAUDE.md` doc-pointer edits
- Úpravy sekce "Active — wm/tests" v BOARD (read-only pro Chat A)
- Merge bez rebase na `origin/main`
- `git push --force` bez `--with-lease`
- `--no-verify` na commit/push hooks (pre-push hook blokuje direct-to-main mimo exceptions)

## Services (neřešit pokud běží)

- **Go outreach backend** na `:8080` — spouští se `cd modules/outreach && go run ./cmd/outreach-server`
- **Express BFF** na `:3100` — `cd features/platform/outreach-dashboard && pnpm dev:server`
- **Vite dev** na `:5175` — `cd features/platform/outreach-dashboard && pnpm dev`
- **Postgres**: Railway (DSN z `OUTREACH_DATABASE_URL` nebo `.env`)

## Diagnostika

```bash
cd features/platform/outreach-dashboard
pnpm report                                         # unified diagnostic (12 protection layers)
pnpm report:json | jq '.'                           # JSON output
```
