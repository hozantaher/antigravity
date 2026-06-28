# ADR-002 — Autonomous Ops Architecture

**Status:** Accepted
**Date:** 2026-04-27
**Supersedes:** —

## Kontext

Vývojový workflow má dvě bolesti:

1. **Žádný durable backlog.** Chat-scoped TaskList umírá s session. Issue tracker (GitHub) máme, ale není integrovaný — žádný auto-flow ze signálů (Sentry runtime errors, CI test fails, weekly health checks) do backlogu, žádný autonomní worker mimo session.
2. **Real-time signály se ztrácejí.** Sentry zachytí runtime error v prod, ale neskončí jako issue. Test fail v CI vznikne jako červený checkmark, ale neproudí do backlogu. Když user nepíše PR, bot nemá co dělat — ale bugy existují, jen je nikdo nečte.

Cílový stav: GitHub Issues = single source of truth, signály z Sentry + CI tečou automaticky dovnitř, algoritmický re-prioritizer udržuje priority čerstvé, autonomní bot worker v off-hours claimuje P0 issues s explicit `automation/ok` opt-in a otevírá PRs (nikdy nemerguje sám).

Související dokumenty:
- [docs/initiatives/2026-04-27-autonomous-ops.md](../initiatives/2026-04-27-autonomous-ops.md) — implementační plán
- [docs/initiatives/2026-04-27-test-suite-recovery.md](../initiatives/2026-04-27-test-suite-recovery.md) — pilot autonomous workload
- [docs/playbooks/bot-operations.md](../playbooks/bot-operations.md) — operační runbook

## Rozhodnutí

Zavádíme autonomous ops vrstvu nad GitHub Issues + Sentry, s těmito stavebními kameny:

1. **GitHub Issues + GH Project "Hozan Ops"** = single source of truth. Žádný Linear, žádný TODO.md, žádná externí služba.
2. **Sentry → GitHub** native integration + `scripts/sentry-triage.mjs` (cron 6h) jako fallback signal pump.
3. **CI test failures → GH issues** přes `.github/workflows/triage-failures.yml` (parsuje junit/vitest/go-test JSON, dedup hashem).
4. **Weekly test health → GH issues** přes `scripts/test-health.mjs` (drift detector pro stub skripty, missing deps, dead-code reference).
5. **Algoritmický reprioritizer** (`scripts/reprioritize.mjs`, cron */30 min) — pure scoring rules, žádný LLM. Audit comment v issue za každou změnu priority.
6. **Bot worker** (`.github/workflows/bot-worker.yml`, cron */30 min) — gate-d presencí (nikdy nepřekáží user práci), max 3 open `[bot]` PRs, max 20 runs/den, max 10 PRs/den. Nikdy auto-merguje. Pracuje pouze na issues s explicit `automation/ok` labelem.
7. **Daily digest** (`.github/workflows/daily-digest.yml`, cron 8:00 UTC) — sumarizuje jako GitHub Discussion v kategorii "Bot Reports". Žádný Slack/email.
8. **Hard red lines** embedded v `.github/agents/autonomous-fix.md` + `bot-worker.yml`:
   - NEVER `make send` / campaign send
   - NEVER push na main / wm/development
   - NEVER force push, amend, reset --hard
   - NEVER `--no-verify`
   - NEVER SMTP/IMAP probes
   - NEVER external services beyond Sentry+GH
   - NEVER bot bez `automation/ok` labelu

## Důsledky

### Pozitivní

- **Trvalý backlog**: issue přežije session, je viditelný (GitHub UI), public-facing pattern.
- **Auto-fed signály**: Sentry error → issue během 6h, test fail → issue během 5min od CI.
- **Off-hours work**: bot pracuje když user nepíše, otevírá PRs k review ráno.
- **Auditovatelný scoring**: každá změna priority má comment s pravidly. Žádný "magic LLM" v rozhodování.
- **Žádné nové externí služby**: zero vendor lock-in nad rámec GitHub + Sentry (už máme).
- **Bezpečné defaults**: `automation/needs-design` je default; user explicit opt-in přes `automation/ok`.
- **Hard scope**: bot nesahá na main, neamenduje, neforce-pushuje. Worktree-isolovaný.

### Negativní

- **GH Actions free tier limit**: cron */30 × ~5 min = 7200 min/měsíc (limit 2000 pro private repos). Riziko překročení po 2 týdnech provozu. Mitigace: monitor + fallback na hodinovou cadenci, případně placený tier.
- **Latence až 30 min**: bot není real-time; po opt-in label může trvat 30 min než začne pracovat.
- **Tuning scoring rules**: první týden bude vyžadovat kalibraci pravidel v `scripts/reprioritize.mjs` na základě reálných výsledků.
- **Bot může selhat tichu**: pokud agent step v `bot-worker.yml` skončí bez PR, neexistuje proaktivní notifikace (jen daily digest). Mitigace: digest obsahuje failed runs.
- **Reverse review burden**: user musí každý ráno projít `[bot]` PRs (limit 3 open znamená ~1-3 PRs denně k mergi).

### Neutrální

- **Bot identity = `github-actions[bot]`** — žádný separátní GitHub App ani PAT v první iteraci. Migrace na GH App možná v budoucí ADR pokud potřebujeme jemnější permissions.
- **Sentry → GH native vs custom skript**: oba zdroje běží paralelně. Native je rychlejší, custom pumps zachytí to co native vynechá.
- **CODEOWNERS = @messingtomas**: bot z definice nemůže schválit svůj PR. Existující config splňuje tuto podmínku.

## Alternativy zvažované

### Alt 1 — Linear + Linear API + Linear webhooks
- Lepší UX (Cycles, sub-issues, custom views).
- **Proč ne**: další služba (memory: "no external services beyond Sentry"), placená pro >10 členů (i pro 1 člověka stojí $8/mo), publikování stavu mimo GitHub komplikuje open-source narrative.

### Alt 2 — Markdown TODO.md v repu + manuální re-prioritizace
- Nulové dependencies, nulový vendor lock-in.
- **Proč ne**: žádná auto-feed pipeline (Sentry → markdown řádek je manual), žádná visual board, žádný labeling, řazení manuální.

### Alt 3 — TaskList Claude Code + ScheduleWakeup loop
- Čistá session-internal cesta, žádný GH overhead.
- **Proč ne**: TaskList umírá s session (memory: "memory should not be used for persisting information that is only useful within current conversation, ale TaskList je ještě uzšlejší"), žádný handover mezi devs/agentů, žádná web visibility.

### Alt 4 — Anthropic CronCreate (cloud schedule) místo GH Actions cron
- Cloud-resident, nezávislý na GH free tier.
- **Proč ne** (zatím): GH Actions má native přístup k repu (checkout, push, PR API) zdarma. CronCreate by vyžadoval další auth flow + nezávislý execution env. Možná v budoucí iteraci pokud GH tier překročíme.

### Alt 5 — LLM-based prioritization (agent rozhodne co je P0)
- Flexibilnější, zachycuje nuance.
- **Proč ne**: nedeterministické, neauditovatelné ("proč to skočilo z P2 na P0?"), drahé per-issue. Pure scoring rules jsou explicit a debuggovatelné. `priority/manual-override` label slouží pro nuance.

## Související

- ADR-007-dashboard-core-design (orthogonal)
- Initiative `2026-04-27-autonomous-ops` (implementace tohoto ADR)
- Memory: `feedback_no_external_services`, `feedback_campaign_send`, `feedback_no_direct_smtp`
