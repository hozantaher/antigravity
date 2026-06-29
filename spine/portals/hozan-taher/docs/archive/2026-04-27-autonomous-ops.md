# Autonomous Ops — GitHub Issues + Sentry + Bot Worker

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** Autonomous issue tracking + bot worker infrastructure implemented per ADR-002; closed in master plan

**Souvisí s:** [2026-04-27-test-suite-recovery.md](2026-04-27-test-suite-recovery.md) — test-suite-recovery je první autonomous workload (32 tasks → 32 issues → bot picks P0 v off-hours)

## Kontext

Současný stav vývoje má dvě bolesti:

1. **Žádný durable backlog.** Chat-scoped TaskList umírá s session. Issue tracker (GH) máme, ale není integrovaný s prací — žádná auto-detekce co je P0, žádný autonomní worker mimo session.
2. **Real-time signály se ztrácejí.** Sentry zachytí runtime error v prod (Go services + dashboard), ale neskončí jako issue. Test fail v CI vznikne jako červený checkmark, ale neproudí do backlogu. Když user nepíše PR, bot nemá co dělat — ale bugy existují, jen je nikdo nečte.

Cílový stav: **GitHub Issues = single source of truth**, signály z Sentry + CI tečou automaticky dovnitř, algoritmický re-prioritizer udržuje priority čerstvé, autonomní bot worker v off-hours claimuje P0 + `automation/ok` issues a otevírá PRs (nikdy nemerguje sám).

### Architektura (high-level)

```
                     ┌─────────────────────────────┐
                     │   GitHub Issues + Project    │  ← single source of truth
                     │   "Hozan Ops" board          │
                     │   (Backlog→Ready→WIP→Review) │
                     └────┬──────────┬─────────┬────┘
                          ↑          ↑         ↓
        ┌─────────────────┘          │         │
        │                            │         │
   ┌────┴─────┐         ┌────────────┴───┐  ┌──┴──────────────┐
   │ Sentry   │         │ CI test fails  │  │ Bot worker      │
   │ → Issue  │         │ → Issue (junit)│  │ (cron */30 min) │
   │ (native+ │         │                │  │  + idle gate    │
   │ cron     │         │ GH Actions:    │  │                 │
   │ scrape)  │         │ triage-failures│  │ Spawns Claude   │
   └──────────┘         └────────────────┘  │ in worktree:    │
                                            │ /hozan-taher-bot│
   ┌──────────────────────────────────┐     └─────────────────┘
   │ Re-prioritizer (cron */30 min)   │
   │ - Sentry frequency → priority    │
   │ - Recent user commits → de-prio  │
   │ - Release health → P0 bump       │
   └──────────────────────────────────┘
```

## Cíle

1. **Single source of truth** = GitHub Issues, organizováno do GH Project "Hozan Ops".
2. **Signály automaticky** vznikají jako issues: Sentry errors, CI test fails, weekly health check.
3. **Algoritmický re-prioritizer** běží každých 30 min, score-based (žádný LLM v prioritizaci).
4. **Bot worker** v off-hours otevírá PRs proti issues s `automation/ok`. Nikdy nemerguje. Max 3 open PRs.
5. **Presence detection** přes git commit timestamp + override soubor `.agent-status`.
6. **Žádné nové externí služby.** Vše Sentry + GitHub + Anthropic API.
7. **Hard red-lines respektované**: `campaign send`, push na `main`, edit s uncommitted user changes, SMTP/IMAP probes — vše blokované v bot kódu.

## Non-cíle

- Nesnažíme se nahradit user-driven planning. Plánování zůstává v `docs/initiatives/`. Bot pracuje **na úrovni operací**, ne strategie.
- Neauto-mergujeme. Ever.
- Neposíláme notifikace mimo GitHub (žádný Slack/email). Sentry + GH PR notifikace stačí.
- Neimplementujeme on-call rotation, oncall paging, eskalaci. Tohle je 1-osobový projekt.

## Datový model (GitHub labels)

```
priority/    p0  | p1 | p2 | p3
kind/        flake | bug | infra | test | docs | refactor | dep
area/        relay | mailboxes | dashboard | scrapers | mcp | bff |
             campaigns | contacts | inbox | privacy-gateway | orchestrator |
             common | worker | extension
from/        sentry | test-fail | manual | health-check | ralphinho
automation/  ok | blocked | needs-design
status/      triaged | in-bot | needs-review | parked
```

`automation/ok` = explicit allowlist pro bota. Bez něj bot issue ignoruje.

## Issue body schema (parseable)

```markdown
## Symptom
<co se děje, jeden odstavec>

## Repro
<přesný příkaz / kroky / test name>

## Acceptance
- [ ] kritérium 1
- [ ] kritérium 2

## Context
<volitelné — odkazy na Sentry event, CI run, related PRs>
```

Bot parser (`scripts/issue-parse.mjs`) extrahuje sekce. Pokud chybí Repro/Acceptance, bot skipne (vrátí labelem `automation/blocked` + komentář).

## Plán (sprinty)

### Sprint A1 — GitHub foundation (0.5 dne)

Cíl: GH Project + labels + issue templates jsou připravené, žádný kód ještě neběží.

- [ ] **A1.1** `gh project create --owner <org> "Hozan Ops"` + 5 sloupců (Backlog / Ready / In Progress / Review / Done).
- [ ] **A1.2** `gh label create` pro 30+ labels (priority/, kind/, area/, from/, automation/, status/). Skript `scripts/setup/labels.sh` deklarativně.
- [ ] **A1.3** Issue templates v `.github/ISSUE_TEMPLATE/`:
  - `bug.yml` — generic bug report (Symptom/Repro/Acceptance schema)
  - `test-fail.yml` — auto-filled by triage-failures workflow
  - `sentry-error.yml` — auto-filled by sentry-triage cron
  - `health-drift.yml` — auto-filled by test-health
  - `manual.yml` — pro tebe, ručně
- [ ] **A1.4** `.github/CODEOWNERS` — bot ne-může mergovat svoje PRs (CODEOWNERS = uživatel).
- [ ] **A1.5** `gh repo edit --enable-discussions` + Discussion category "Bot Reports".

**Acceptance:** `gh project view "Hozan Ops"` ukáže prázdné sloupce + labely + templates jsou dostupné v UI.

### Sprint A2 — Signal pipelines (1.5 dne)

Cíl: Issues vznikají automaticky ze 3 zdrojů (Sentry, CI, weekly health).

- [ ] **A2.1** Sentry → GitHub native integration. Per-project konfigurace ve 4 Sentry projektech (relay, privacy-gateway, mailboxes, campaigns — možná víc):
  - Alert rule: "issue is seen more than 100 times in 24h" → create GH issue
  - Alert rule: "release health crash-free rate drops below 95%" → create GH issue (P0)
  - Issue auto-tagged `from/sentry`, `area/<service>`
- [ ] **A2.2** `scripts/sentry-triage.mjs` (Node, ESM):
  - Pulls open Sentry issues via `@sentry/node` API + `SENTRY_AUTH_TOKEN`
  - Pro každý: lookup matching GH issue (search by Sentry event ID v body), upsert
  - Updates count + last-seen + affected release tag
  - Cron každých 6h (`.github/workflows/sentry-triage.yml`)
- [ ] **A2.3** `.github/workflows/triage-failures.yml`:
  - Trigger: `workflow_run` po `test-all.yml` (z initiative test-suite-recovery)
  - Pokud failed: parse junit XML / vitest JSON, deduplikuj per testname
  - Vytvoří issue per nový failing test (skip pokud existuje open issue se stejným title hashem)
  - Tagy: `from/test-fail`, `kind/bug` nebo `kind/flake` (heuristika: pokud test failnul ≥3× za 7 dní = flake), `area/<inferred from path>`
- [ ] **A2.4** Weekly health check workflow (`.github/workflows/test-health.yml`) — pokrývá test-suite-recovery sprint S5.2. Vystvoří issue `from/health-check` při driftu.
- [ ] **A2.5** Backfill: skript `scripts/setup/backfill-tasks.mjs` čte současné Tasks z TaskList (export přes pipe) + initiative TODO checkboxes a vytvoří 32+ issues s vhodnými prioritami a labels.

**Acceptance:** Po týdenním běhu jsou v Backlog sloupci issues z Sentry + CI bez ručního zásahu.

### Sprint A3 — Re-prioritizer (1 den)

Cíl: Algoritmický scoring běží, priority labels se mění bez LLM.

- [ ] **A3.1** `scripts/reprioritize.mjs`:
  ```js
  // Pseudokód scoring rules:
  score = 0
  if from/sentry && sentryCount24h > 100: score += 30
  if from/sentry && sentryCount24h > 1000: score += 20
  if kind/flake: score += 20  // flake hides other signal
  if blockingMerge (CI red on main/wm-development): score += 15
  if affects user's recent commits area (last 24h): score -= 10  // user řeší
  if age > 30 days && status != in-bot: score -= 5  // stale
  if from/health-check: score += 10
  ```
  - Mapuje score → label `priority/p0` (≥40), `p1` (20–39), `p2` (5–19), `p3` (<5)
  - Updates GH Project board column dle priority + status
  - Kombo Sentry API + gh CLI + git log
- [ ] **A3.2** `scripts/reprioritize-audit.mjs` — pro každou změnu priority napíše komentář na issue: `Bot reprioritized: p1 → p0 (sentryCount24h=523, blocking CI)`. Audit trail.
- [ ] **A3.3** `.github/workflows/reprioritize.yml` — cron `*/30 * * * *`. Volá oba skripty.
- [ ] **A3.4** Dry-run mode: `node scripts/reprioritize.mjs --dry-run` jen vypíše co by změnil. Použij v initial spuštění.

**Acceptance:** Týden běhu → P0/P1/P2 distribuce odpovídá realitě (žádný issue v P0 který je >7 dní bez signálu, žádný flake v P3).

### Sprint A4 — Presence detection + bot worker (2 dny)

Cíl: Bot v off-hours claimuje top P0 issue s `automation/ok`, otevírá PR. Nikdy nemerguje. Bezpečné.

- [ ] **A4.1** `scripts/presence.sh`:
  ```bash
  # Bot decides if user is "active" or "idle"
  GIT_USER="Tomáš Messing"
  THRESHOLD_MIN=90
  last_human_commit=$(git log --author="$GIT_USER" --since="${THRESHOLD_MIN} minutes" -1 --format=%ct 2>/dev/null)
  if [ -n "$last_human_commit" ]; then echo active; exit 0; fi
  # Override file (manual kill switch)
  if [ -f .agent-status ] && grep -q paused .agent-status; then echo paused; exit 1; fi
  echo idle
  ```
- [ ] **A4.2** `scripts/agent-claim.mjs`:
  - Pulls top issue: `priority/p0` + `automation/ok` + no assignee + status=triaged
  - Assignee = `bot@hozan` (GitHub Actions identity)
  - Returns issue ID + body parsed
- [ ] **A4.3** `.github/workflows/bot-worker.yml`:
  - Cron `*/30 * * * *`
  - Steps:
    1. Checkout `wm/development` (bot pracuje vždy z dev base)
    2. Run `presence.sh` → exit pokud active/paused
    3. Count open `[bot]` PRs (`gh pr list --label automation/bot --state open`) → exit pokud ≥3
    4. `agent-claim.mjs` → output ISSUE_NUMBER, ISSUE_BODY
    5. `git worktree add ../hozan-taher-bot auto/issue-${ISSUE_NUMBER}` (siblng worktree, dedicated branch)
    6. Spawn Claude Code: `claude code --agent autonomous-fix --issue ${ISSUE_NUMBER}` (uses Anthropic API key)
    7. Po dokončení: `scripts/test-all.sh --filter=area/<area>` musí projít, jinak label `automation/blocked` + komentář
    8. Push branch + open PR with title `[bot] Fix #${ISSUE_NUMBER}: <issue title>`, body "Closes #${ISSUE_NUMBER}", label `automation/bot`
    9. Komentář na issue: link na PR
    10. `git worktree remove ../hozan-taher-bot --force` (cleanup)
- [ ] **A4.4** Bot agent prompt v `.github/agents/autonomous-fix.md`:
  - Read issue body sekce Symptom/Repro/Acceptance
  - Reproduce → fail → fix → run affected tests → if green commit
  - Hard rules embedded: NEVER `make send`, NEVER `git push origin main`, NEVER amend, NEVER `git reset --hard`
  - Pokud Acceptance nelze automatizovat → `automation/blocked`
- [ ] **A4.5** Bot identity: GitHub PAT s scope `repo` + `project` (omezený na automation tasks). Stored v GitHub Actions secret `BOT_GITHUB_TOKEN`. Anthropic API key v `ANTHROPIC_API_KEY`.
- [ ] **A4.6** Hard-coded guards v `bot-worker.yml`:
  - Job-level `if: github.ref == 'refs/heads/wm/development'` — bot nikdy nestartuje z `main`
  - `permissions: contents: write, pull-requests: write` (žádný `actions: write`, žádný `secrets:`)
  - `timeout-minutes: 45` per run
- [ ] **A4.7** Daily limits via state file `.bot-state.json` (commitnutý v repu nebo v Actions cache):
  - `runs_today`, `prs_opened_today`, `last_run_at`
  - Hard limits: `MAX_BOT_RUNS_PER_DAY=20`, `MAX_BOT_PRS_PER_DAY=10`

**Acceptance:** Bot otevře 1 PR per cron run během off-hours, žádný PR mimo `automation/ok` issues, max 3 open `[bot]` PRs současně, 0 PRs proti `main`, 0 incidentů s rozbitým user worktree.

### Sprint A5 — Visibility + governance (0.5 dne)

Cíl: Single dashboard view, daily digest, ADR.

- [ ] **A5.1** GH Project board "Hozan Ops" view: Group by priority/, Sort by score, Filter by area/.
- [ ] **A5.2** Daily digest workflow `.github/workflows/daily-digest.yml`:
  - Cron `0 8 * * *` (8:00 UTC)
  - Sumarizuje za posledních 24h: PRs opened (bot vs user), issues created (per from/), priorities changed, top 5 P0 open
  - Vytvoří GH Discussion v kategorii "Bot Reports" s title `Bot Report YYYY-MM-DD`
- [ ] **A5.3** ADR `docs/decisions/ADR-NNN-autonomous-ops-architecture.md`:
  - Proč GitHub Issues jako SoT (vs Linear, vs markdown TODO.md)
  - Proč algoritmický scoring (vs LLM-based)
  - Proč žádný auto-merge (red line)
  - Proč Sentry + GH (vs Datadog/Better Stack)
  - Bezpečnostní guards
- [ ] **A5.4** `docs/playbooks/bot-operations.md`:
  - Jak ručně spustit bot worker (debug)
  - Jak pause-nout bota (`.agent-status`)
  - Jak povolit issue pro bota (`automation/ok`)
  - Jak číst daily digest
  - Postup pokud bot udělá zprávu kterou nechceš (revert PR + remove `automation/ok`)
- [ ] **A5.5** README.md update — sekce "Operating model" s odkazem na playbook.

**Acceptance:** ADR mergnutý, playbook v `docs/playbooks/`, daily digest se objeví následující ráno.

### Sprint A6 — Backfill + first autonomous workload (0.5 dne)

Cíl: 32 tasks z test-suite-recovery jsou v GH issues, bot začne na nich pracovat.

- [ ] **A6.1** Spustit `scripts/setup/backfill-tasks.mjs` — naplní Backlog ~32 issues z initiative test-suite-recovery.
- [ ] **A6.2** Manuálně otagovat které jsou `automation/ok` (= safe pro bota — typicky kosmetické refactory, test fixes, docs) vs `automation/needs-design` (= musíš nejdřív schválit přístup).
- [ ] **A6.3** Default safe tasks pro bot (z S1–S6):
  - S1.6 (smazat dead smoke skripty) ✓
  - S1.7 (smazat prázdné modules/outreach) ✓
  - S2.3 (Makefile s test targets) ✓
  - S3.6 (vytvořit chybějící e2e fixture) ✓
  - S5.3 (package.json komentáře) ✓
  - S6.4 (test infra owner v ADR) ✓
- [ ] **A6.4** Default `needs-design` (počkat na user):
  - S1.2 (mailboxes flake — racing strategy)
  - S1.3 (relay round-robin — algoritmický bug)
  - S2.6 (přejmenování `test` → `test:fast` — velký impact)
- [ ] **A6.5** Spustit první cron run manuálně (`gh workflow run bot-worker.yml`) v idle stavu. Sledovat output.

**Acceptance:** První `[bot]` PR otevřen úspěšně, prošel CI, čeká na review.

## Plán nasazení (timeline)

```
Den 1 ráno:    A1 (foundation)
Den 1 popoledne: A2.1 + A2.2 (Sentry pipeline)
Den 2:         A2.3 + A2.4 + A2.5 (CI + health + backfill)
Den 3:         A3 (reprioritizer) — týden běh on-paper, kalibrace pravidel
Den 4:         A4 (bot worker) — staging mode (dry-run, žádný git push)
Den 5 ráno:    A4 production switch
Den 5 popoledne: A5 + A6 (visibility + backfill)
```

## Bezpečnostní red-lines (z paměti + CLAUDE.md)

```
NEVER  campaign send (HARD RULE — modules/outreach/CLAUDE.md)
NEVER  push main / wm-development (bot pracuje vždy na auto/* branchích)
NEVER  merge own PR (CODEOWNERS gate)
NEVER  edit branch s uncommitted user changes (presence guard + worktree isolation)
NEVER  SMTP/IMAP direct probes (HARD RULE — feedback_no_direct_smtp)
NEVER  external services beyond Sentry+GH (HARD RULE — feedback_no_external_services)
NEVER  bot bez `automation/ok` labelu
LIMIT  MAX_BOT_PRS_OPEN=3
LIMIT  MAX_BOT_RUNS_PER_DAY=20
LIMIT  MAX_BOT_PRS_PER_DAY=10
```

Všechny limity hard-coded v `bot-worker.yml` a v `agent-claim.mjs`. Override jen explicit user akce v repu (např. zvýšení limitu = PR od usera s ADR amendment).

## Blokátory

- (žádné — vše využívá co už máme: Sentry + GitHub + Anthropic API)
- Pozor: GH Actions free tier má 2000 minut/měsíc pro private repos. Cron */30 min × 30 dní × ~5 min per run = 7200 min/měsíc → potenciálně překročí. **Akce:** monitor po 2 týdnech, případně přejít na `0 */1 * * *` (hodinový), nebo bot worker pouštět jen v noci (`0 0,3,6 * * *`).

## Otevřené otázky

- **Bot identity:** GitHub Apps vs PAT? GH Apps čistší (lépe limitované permissions), ale větší setup. **Default**: PAT s minimálním scope; migrace na GH App v budoucí iniciativě.
- **Reprioritizer LLM-augmented?** Pure scoring nemusí stačit pro nuance ("tohle je p0 protože blokuje launch"). **Default**: čistý algoritmus; `priority/manual-override` label = bot ho nepřepíše.
- **Co s `garaaage-law` worktree?** Memory note hovoří o paralelní práci tam. Bot by měl skipnout pokud current worktree není v `hozan-taher-bot/`. **Akce**: hard-coded check v `bot-worker.yml`.
- **Daily digest místo:** GH Discussion vs README badge vs separátní MD file? **Default**: Discussion (notifikuje GitHub native, žádný spam).

## Log

- 2026-04-27 — založeno; navazuje na test-suite-recovery jako pilot autonomous workload
