# Bot Operations Playbook

Operační runbook pro autonomous bot worker. Shrnuje jak bota spustit, pause-nout, debugovat a reagovat na chybné PRs.

> Pro **proč** a **architekturu** viz [ADR-002](../decisions/ADR-002-autonomous-ops-architecture.md) a [iniciativa autonomous-ops](../initiatives/2026-04-27-autonomous-ops.md).

## Komponenty

| Komponenta | Soubor | Účel |
|---|---|---|
| Backfill | `scripts/setup/backfill-tasks.mjs` | Naplň issues z initiative checkboxů |
| Labels | `scripts/setup/labels.sh` | Idempotent label setup (39+ labelů) |
| Reprioritize | `scripts/reprioritize.mjs` + `.github/workflows/reprioritize.yml` | Score-based priority recompute, cron */30 |
| Triage failures | `scripts/triage-failures.mjs` + `.github/workflows/triage-failures.yml` | CI fail → issue, dedup hashem |
| Sentry triage | `scripts/sentry-triage.mjs` | Sentry events → issues, cron 6h |
| Presence | `scripts/presence.sh` | active/idle/paused detekce přes git log |
| Agent claim | `scripts/agent-claim.mjs` | Vyber top P0 + automation/ok issue |
| Bot worker | `.github/workflows/bot-worker.yml` | Cron-driven autonomous fix runner |
| Agent prompt | `.github/agents/autonomous-fix.md` | Embedded red-lines + workflow |
| Daily digest | `.github/workflows/daily-digest.yml` | 8:00 UTC GitHub Discussion summary |
| State | `.bot-state.json` | Daily counters (runs, PRs) |

## Issue lifecycle

```
                       ┌─────────────────────┐
                       │ user opt-in label   │
                       │   automation/ok     │
                       └──────────┬──────────┘
                                  │
   ┌──────┐    cron */30 min      ▼
   │      │ ◀───── presence  ◀─────────  ┌──────────────┐
   │ Bot  │      check (idle?)            │ status/in-bot│
   │      │                               └──────────────┘
   │      │ ─────► claim issue ────►  set status/in-bot
   │      │ ─────► spawn Claude in worktree (../bot-workspace)
   │      │ ─────► run affected tests
   │      │ ─────► commit + push auto/issue-NNN
   │      │ ─────► open PR [bot] fix(area): ... → label automation/bot
   └──────┘
                                  │
                  PR review by user (CODEOWNERS)
                                  │
                                  ▼
                          merge → issue auto-close
```

## Operational tasks

### Spustit bot manuálně (debug)

```bash
gh workflow run bot-worker.yml
gh run watch          # tail latest run
```

### Pause-nout bota (kill switch)

Vytvoř soubor v repo root:

```bash
echo paused > .agent-status
git add .agent-status && git commit -m "ops: pause bot" && git push
```

Bot detekuje při dalším cron tiku a zahodí běh. Vrátit do provozu = `git rm .agent-status` + commit.

### Povolit issue pro bota (opt-in)

```bash
# manuálně v UI nebo:
gh issue edit <num> --add-label automation/ok
```

Reprioritizer ve následujícím cron tiku přepočte score. Bot na něm začne pracovat když přijde řada.

### Zablokovat issue pro bota (opt-out)

```bash
gh issue edit <num> --remove-label automation/ok --add-label automation/needs-design
```

Pokud bot zrovna pracuje, neutralizuj jeho PR (`gh pr close --delete-branch <pr-num>`).

### Reagovat na špatný bot PR

```bash
# 1. Zavřít PR + smazat branch
gh pr close <pr-num> --delete-branch

# 2. Otevřít issue s feedbackem co se stalo
gh issue comment <orig-issue> --body "Bot fix v #<pr-num> nepasoval, protože ..."

# 3. Pokud opakovaná chyba → odeber automation/ok
gh issue edit <orig-issue> --remove-label automation/ok --add-label automation/blocked

# 4. Pokud root cause v agent prompt → edit .github/agents/autonomous-fix.md
```

### Číst daily digest

```bash
gh discussion list --category "Bot Reports" --limit 7
gh discussion view <num>
```

### Resetovat denní limity (po incidentu)

```bash
echo '{}' > .bot-state.json
git add .bot-state.json && git commit -m "ops: reset bot daily counters" && git push
```

## Hard limits

| Limit | Hodnota | Umístění | Reset |
|---|---|---|---|
| Open `[bot]` PRs | 3 | `bot-worker.yml` env `MAX_BOT_PRS_OPEN` | Při každém mergi/zavření PR |
| Runs/day | 20 | `bot-worker.yml` env `MAX_BOT_RUNS_PER_DAY` | Půlnoc UTC |
| PRs/day | 10 | `bot-worker.yml` env `MAX_BOT_PRS_PER_DAY` | Půlnoc UTC |
| Job timeout | 45 min | `bot-worker.yml` `timeout-minutes` | — |
| Cron interval | 30 min | `bot-worker.yml` schedule | — |

Změna limitu = PR + amendment ADR-002.

## Hard guards (technické)

Tyto checky jsou enforced v `bot-worker.yml`. Bot je nemůže obejít.

1. `if: github.ref != 'refs/heads/main'` — bot nikdy nestartuje z main.
2. `permissions: contents: write, pull-requests: write, issues: write` — nic víc.
3. `concurrency: bot-worker` — paralelní běhy se serializují.
4. `presence.sh` exit != 0 → skip (user paused) nebo presence != "idle" → skip (user active).
5. PR count > MAX_BOT_PRS_OPEN → skip.
6. Daily counter > MAX_BOT_RUNS_PER_DAY → skip.

## Hard guards (agent-level v autonomous-fix.md)

Bot agent prompt obsahuje 10 NEVER pravidel:

```
NEVER  campaign send / make send / pnpm campaign:send
NEVER  push main / wm/development
NEVER  force push (--force, -f, +)
NEVER  edit branch with uncommitted user changes
NEVER  amend commits
NEVER  git reset --hard
NEVER  --no-verify (skip hooks)
NEVER  SMTP/IMAP probes from localhost
NEVER  add new external services (S3, Slack, ...)
NEVER  auto-merge own PR (CODEOWNERS prevents anyway)
```

Pokud bot tato pravidla poruší → revert PR + issue s `bot-incident` label + amendment agentova promptu.

## Známé blokátory (set-up)

1. **`gh project create` vyžaduje token scope `read:project,project,write:project`.**
   Spusť: `gh auth refresh -s read:project,project,write:project`
2. **Sentry → GH integration** musí být ručně nastavena ve 4 Sentry projektech (web UI).
3. **Bot Reports** Discussion category neumožňuje GitHub API → ručně v UI.
4. **Anthropic API key** v Actions secret `ANTHROPIC_API_KEY` — placeholder agent step čeká na Claude Code Action / API klíč.

## Eskalace

- Bot otevřel 3+ PRs co rozbily CI → pause + comment v posledním PR + vytvořit `bot-incident` issue.
- Bot opakovaně failuje na stejném issue (3+ tries) → `automation/blocked` automaticky (`agent-claim.mjs` to detekuje skrz `status/in-bot` historii).
- GH Actions minutes překračují měsíční budget → fallback cron na `0 */1 * * *` (hodinová) přes PR.

## Ne-cíle

- Bot **není** sentient. Nerozumí business kontextu. Vyžaduje precise Acceptance v issue.
- Bot **není** code reviewer. Neoznačuje cizí PRs.
- Bot **nehází** notifikace mimo GitHub. Sentry digest + GH PR notify stačí.
- Bot **nemůže** mergovat. Ever. CODEOWNERS + nemá `actions: write` permission.
