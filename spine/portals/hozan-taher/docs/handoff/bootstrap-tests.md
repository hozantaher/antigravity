# Bootstrap — wm/tests worktree (Chat B)

> **Status 2026-04-30: REAKTIVOVÁNO** pro iniciativu "Kampaň výkupu techniky".
>
> Chat B pracuje na 15 quality sprintech KT-B1 až KT-B15 (GH issues #310-#324):
> kontrakt mezi BFF a Go backendem, validace LLM klasifikátoru, lab feedback loop,
> brutal testing pass (mutation testing, chaos extensions, fuzzing scrapers),
> bug bash. Plán vytvořen 2026-04-30 v `docs/initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md`.
>
> **Pořadí čtení dokumentů na startu session:**
> 1. [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-master.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md) — společný cíl, hard rules, hand-off protokol
> 2. [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md) — všech 15 sprintů Chat B v lidštině
> 3. BOARD.md sekce "Aktivní iniciativa" — co Chat A právě dokončil + signály A→B
>
> **Spouštěcí signál:** Chat B začíná až po merge sprintu KT-A6 (ramp 5→20 + 24h dohled),
> kdy je první kampaň živá a generuje reálná data. Do té doby může běžet KT-B1 (kontraktní
> testy BFF↔Go), který je nezávislý na produkční kampani.
>
> Po dokončení sprintu zavřít odpovídající GH issue (#310-#324) komentářem s odkazem na
> merged PR a posunout cursor v BOARD sekci "Active — wm/tests".

**Cesta:** `/Users/messingtomas/Documents/Projekty/hozan-taher-tests`
**Branch:** `wm/tests`
**Role:** test coverage — Go unit/integration/property/fuzz, React unit (vitest), BFF kontrakt, E2E (Playwright)

## Start turn

```bash
cd /Users/messingtomas/Documents/Projekty/hozan-taher-tests
git fetch origin
git rebase origin/main
# Po squash-merge vlastního PR: git skipne cherry-picked → OK
cat ../hozan-taher/docs/handoff/BOARD.md
gh pr list --state open --head wm/development --json number,title,body
git log origin/main --grep="Needs-Tests:" --format="%h %s%n%b" -20
```

Přečíst:
1. Sekci "Active — wm/tests" (co mám rozdělané)
2. Sekci "Cross-branch signals" (zprávy od Chatu A)
3. Open PRs z `wm/development` — pre-merge signály v PR body (`Needs-Tests:`, `Breaks-Contract:`)
4. Merged `Needs-Tests:` trailery → historický backlog

**Priorita:** PR body (in-flight) > merged trailer (historický) > BOARD (kurátovaný).

## Anti-drift kontrola

```bash
git log --oneline origin/main..HEAD
git log --oneline HEAD..origin/main
```

Behind > 10 → rebase first.

## Práce

**Test frameworky:**
- Go: `go test ./... -race` (v `modules/outreach/`, `modules/anti-trace-relay/`, atd.)
- Go property: `go test -tags=property ./...` (pokud package implementuje property testy)
- Go fuzz: `go test -fuzz=FuzzXxx -fuzztime=30s ./internal/foo/`
- React unit: `cd features/platform/outreach-dashboard && pnpm test`
- BFF kontrakt: `cd features/platform/outreach-dashboard && pnpm vitest run test/contract/`
- E2E: `cd features/platform/outreach-dashboard && pnpm e2e` (Playwright)

**TDD — RED cycle (Chat B primary):**
1. Napiš test pokrývající `Needs-Tests:` signál z Chatu A
2. Ověř že selhává (RED — volitelně commit jako "RED" marker)
3. Chat A implementuje → Chat B po merge sync a ověří GREEN
4. Refactor (volitelně) → commit s `Resolves-Trailer:`

## End turn

1. **Commit** s trailerem (pokud reaguje na konkrétní dev PR nebo signál):
   ```
   test(<scope>): <co pokrývám>

   Covers: #<PR číslo>
   Resolves-Trailer: Needs-Tests: <modul>
   ```

2. **Push**:
   ```bash
   git push origin wm/tests
   ```

3. **PR** s trailery v body:
   ```bash
   gh pr create --base main --head wm/tests --title "test(...): ..." --body "..."
   ```

4. **Update BOARD** sekce "Active — wm/tests" **přímo na main**:
   ```bash
   cd /Users/messingtomas/Documents/Projekty/hozan-taher
   git pull --ff-only origin main
   # edit docs/handoff/BOARD.md (vlastní sekci + Cross-branch signals pokud odpovídáš A→B)
   git commit -am "chore(board): tests update"
   git push origin main
   ```

5. **Pokud test selhal kvůli bugu** (ne kvůli špatnému testu):
   - Přidej `B→A` signál do BOARD "Cross-branch signals"
   - Volitelně komentář na A-PR: `Blocks-On: <test PR#>`
   - **NEPOUZIVEJ PROD KÓD** — bug fix je úkol pro Chat A, ne pro tebe

## Post-merge sync (MUSÍ po každém squash-merge tvého PR)

```bash
cd /Users/messingtomas/Documents/Projekty/hozan-taher-tests
git fetch origin
git rebase origin/main                  # git skipne cherry-picked commity
git push --force-with-lease origin wm/tests
```

## Zakázané

- Direct push do `main` krom `docs/handoff/*.md` a `CLAUDE.md` doc-pointer edits
- Úpravy sekce "Active — wm/development" v BOARD (read-only pro Chat B)
- Merge bez rebase na `origin/main`
- `git push --force` bez `--with-lease`
- **Psaní prod kódu** (jen testy; bug = signál zpět Chatu A přes BOARD nebo PR comment)
- Commit co mixuje prod změny + testy (pokud refactor odhalí bug, oddělit: test commit sem, prod fix → signál Chatu A)

## Coverage cíle (per `docs/handoff/BOARD.md` → výše)

- Go business logic packages: ≥85%
- React komponenty + BFF: ≥80%
- E2E: happy path každé kritické user flow (campaigns, inbox, segments, analytics)

```bash
# Go coverage
cd modules/outreach
go test -cover ./...
go test -coverprofile=cover.out ./... && go tool cover -html=cover.out -o cover.html

# React coverage
cd features/platform/outreach-dashboard
pnpm test -- --coverage
```
