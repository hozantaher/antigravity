# Autonomous Ops — Handoff & Activation

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** Autonomous ops tasks closed in master plan 2026-04-30; handoff protocol documented in BOARD.md

**Souvisí s:**
- [2026-04-27-autonomous-ops.md](2026-04-27-autonomous-ops.md) — bootstrap (sprints A1–A6, většina hotová)
- [2026-04-27-test-suite-recovery.md](2026-04-27-test-suite-recovery.md) — pilot autonomous workload
- [ADR-002](../decisions/ADR-002-autonomous-ops-architecture.md) — architektonické rozhodnutí
- [bot-operations.md](../playbooks/bot-operations.md) — operační runbook

## Kontext

Z iniciativy autonomous-ops zbyly 5 blokátorů co vyžadují **user action** (interactive auth, web UI, secrets management, default branch merge). Bot kostra je nasazená v `feat/ui-epic-d-e-f-2026-04-26` branchi (commit `9ac2083`), ale cron triggers v GH Actions fungují jen z default branche → systém **není live** dokud nedokončíme handoff.

Tato iniciativa rozepisuje **každý user step + AI follow-up** v jasných sprintech, aby aktivace nezůstala uvíznutá v "až někdy".

### Aktuální stav (2026-04-27)

```
HOTOVO (bootstrap):
  ✓ 39 GH labels
  ✓ 5 issue templates
  ✓ 6 GH Actions workflows
  ✓ 8 supporting scripts
  ✓ ADR-002 + playbook + README operating model
  ✓ 63 GH issues backfilled (#27..#89)
  ✓ Bot agent prompt s 10 hard NEVER red-lines

PENDING (user action required):
  ⏸ A1.1   gh auth refresh -s read:project,project   → AI: create Project board
  ⏸ A2.1   Sentry → GH integration v 4 projektech    → AI: verify signal flow
  ⏸ A4.5   ANTHROPIC_API_KEY + BOT_GITHUB_TOKEN     → AI: wire Claude Code Action
  ⏸ ext    "Bot Reports" Discussion category         → AI: verify daily digest
  ⏸ A6.5   merge feat → main + první dry-run         → AI: monitor + iterate
```

## Cíle

1. **Všechny 5 blokátorů odblokované** během 1 work session (user-side ~30 min total).
2. **Bot worker je live** v cronu na main branchi (cron */30 min).
3. **První [bot] PR otevřen úspěšně** v dry/staging mode.
4. **Daily digest produkuje GH Discussion** ráno následujícího dne.
5. **Sentry signál proudí** automaticky → GH issues s correct labels.
6. **Eskalační procedury hotové** pro běžné incident scenarios.

## Non-cíle

- Neměníme bot architekturu — to je v ADR-002.
- Nepřidáváme funkce nad rámec bootstrap iniciativy.
- Negarantujeme že bot fixne první issue správně — to je iterativní práce po merge.

## Plán (sprinty)

### Sprint H1 — gh auth refresh + Project board (user 10s, AI 5 min)

**User:**
```bash
gh auth refresh -h github.com -s read:project,project
# Otevře browser, schvál scope, vrať se do terminálu
```

**AI follow-up:**
- [ ] **H1.1** `gh project create --owner messingdev --title "Hozan Ops"` → save project number
- [ ] **H1.2** Přidat 5 sloupců via `gh project field-create`:
  - Backlog (default), Ready, In Progress, Review, Done (single-select on `Status` field)
- [ ] **H1.3** Iterate přes 73 open issues, `gh project item-add <project-num> --owner messingdev --url <issue-url>`
- [ ] **H1.4** Mapping: `automation/ok` issues → "Ready", `status/in-bot` → "In Progress", všichni ostatní → "Backlog"
- [ ] **H1.5** Project view: group by `priority/`, sort by created date desc
- [ ] **H1.6** Sdělit user URL na board

**Acceptance:** `gh project view <num>` ukáže 73 items rozdělených do 5 sloupců.

### Sprint H2 — GH Actions secrets + Claude Code Action wire-up (user 5 min, AI 15 min)

**User:**
```bash
# 1. Anthropic API key (z console.anthropic.com → API Keys)
gh secret set ANTHROPIC_API_KEY --body 'sk-ant-...' --repo messingdev/hozan-taher

# 2. Bot GitHub PAT (github.com/settings/tokens → Generate new (classic), scope: repo)
gh secret set BOT_GITHUB_TOKEN --body 'ghp_...' --repo messingdev/hozan-taher

# 3. Sentry token (z sentry.io/settings/account/api/auth-tokens, scope: project:read)
gh secret set SENTRY_AUTH_TOKEN --body '...' --repo messingdev/hozan-taher
gh variable set SENTRY_ORG --body 'messingdev' --repo messingdev/hozan-taher
gh variable set SENTRY_PROJECTS --body 'relay,privacy-gateway,mailboxes,campaigns' --repo messingdev/hozan-taher
```

**AI follow-up:**
- [ ] **H2.1** Upravit `.github/workflows/bot-worker.yml`:
  - Nahradit current "PLACEHOLDER" step real Claude Code Action call
  - Použít `anthropics/claude-code-action@v1` nebo equivalent (zkontrolovat dostupnost)
  - Předat issue body + .github/agents/autonomous-fix.md jako system prompt
  - Pass ANTHROPIC_API_KEY + GH_TOKEN env
- [ ] **H2.2** Upravit `.github/workflows/sentry-triage.yml` — odebrat early exit `if [ -z "$SENTRY_AUTH_TOKEN" ]`
- [ ] **H2.3** Test: `gh workflow run sentry-triage.yml -f dry_run=true` z `feat/ui-epic-d-e-f-2026-04-26`
  - Ověřit že fetchne Sentry issues, dryRun output ukáže correct upserts
- [ ] **H2.4** Commit + push do feat branche

**Acceptance:** Sentry triage workflow projede bez SENTRY_AUTH_TOKEN missing chyby. Bot-worker step volá real Claude (i kdyby fail na něčem jiném — důkaz že key je accessible).

### Sprint H3 — Bot Reports Discussion category + verify (user 1 min, AI 3 min)

**User:**
```
1. Otevři https://github.com/messingdev/hozan-taher/discussions/categories
2. Klik "New category"
3. Name: Bot Reports
4. Format: Announcement
5. Description: Daily bot digest from .github/workflows/daily-digest.yml
6. Save
```

**AI follow-up:**
- [ ] **H3.1** Verify category existence: `gh api graphql -f query='{repository(owner:"messingdev",name:"hozan-taher"){discussionCategories(first:20){nodes{name slug}}}}' | jq`
- [ ] **H3.2** Test daily-digest manually: `gh workflow run daily-digest.yml`
- [ ] **H3.3** `gh run watch` → ověřit že discussion vznikl v "Bot Reports"
- [ ] **H3.4** `gh discussion list --category "Bot Reports" --limit 1` → URL discussion
- [ ] **H3.5** Pokud něco failne (template error, GraphQL params), opravit `daily-digest.yml` + commit

**Acceptance:** GH Discussion `Bot Report 2026-04-27` viditelný v Bot Reports kategorii.

### Sprint H4 — Sentry → GitHub native integration (user 15 min, AI 5 min)

**User:**
```
A) ORG-LEVEL INSTALL (jednorázově):
   1. https://sentry.io/settings/<org>/integrations/github/
   2. "Install GitHub" → OAuth flow → vyber repo messingdev/hozan-taher
   3. Confirm permissions (issues:write, contents:read)

B) PER-PROJECT (4×, pro každý: relay, privacy-gateway, mailboxes, campaigns):
   1. https://sentry.io/settings/<org>/projects/<project>/alerts/
   2. "New Alert" → "Issue" → Conditions:
        "When event count > 100 in 24h"
      Actions:
        "Send a notification via GitHub" → Repo: messingdev/hozan-taher
        Labels: from/sentry, kind/bug, area/<project>, priority/p1
   3. Save

   Bonus: druhá rule per projekt:
        "When release health crash-free rate < 95%"
      Action: GH issue with priority/p0 label
```

**AI follow-up:**
- [ ] **H4.1** Po prvním Sentry alert (= Sentry pošle test issue): ověřit `gh issue list --label from/sentry --limit 5`
- [ ] **H4.2** Pokud chybí labels (priority/area), opravit Sentry alert config + dokumentovat v playbook
- [ ] **H4.3** Manuálně spustit fallback cron: `gh workflow run sentry-triage.yml`
- [ ] **H4.4** Aktualizovat `docs/playbooks/bot-operations.md` — sekce "Sentry signal verification"

**Acceptance:** Cron sentry-triage projede bez chyby. Při jakékoli Sentry incidence vznikne GH issue s `from/sentry` labelem do 6h.

### Sprint H5 — Merge na main + první bot dry-run (user 10 min, AI 30 min)

**User:**
```bash
# Option A: PR review path (preferred per CODEOWNERS)
gh pr create --base main --head feat/ui-epic-d-e-f-2026-04-26 \
  --title "feat(autonomous-ops): activate bot worker + signal pipelines" \
  --body "Activates initiative 2026-04-27-autonomous-ops on main. See ADR-002."
# Po review:
gh pr merge --squash <pr-num>

# Option B: pokud máš pre-push hook exception pro docs+bot kostra
git checkout main && git merge --no-ff feat/ui-epic-d-e-f-2026-04-26 && git push origin main
```

**AI follow-up:**
- [ ] **H5.1** Po mergi na main: cron triggers se aktivují automaticky (do 30 min první reprioritize cron)
- [ ] **H5.2** Manuálně forced run pro rychlou verify:
  - `gh workflow run reprioritize.yml` → check audit comments na issues
  - `gh workflow run bot-worker.yml -f force=true` → first attempt at issue claim
- [ ] **H5.3** Sledovat run: `gh run list --workflow bot-worker.yml --limit 3`
- [ ] **H5.4** Pokud bot otevřel PR — review structure (title, body, branch, labels) ne kód
- [ ] **H5.5** Pokud bot fail — debug:
  - Read run log: `gh run view <run-id> --log`
  - Iterate na agent prompt nebo workflow yaml
  - Re-run: `gh workflow run bot-worker.yml -f force=true`
- [ ] **H5.6** První 24 hodin po aktivaci: monitor `.bot-state.json` daily counters
- [ ] **H5.7** Pokud GH Actions usage překročí 1500 min v prvním týdnu → fallback na hourly cron (PR amendment)

**Acceptance:** Bot otevřel alespoň 1 reálný `[bot]` PR proti issue s `automation/ok` labelem. PR má correct labels, branch `auto/issue-NNN`, body s `Closes #NNN`.

### Sprint H6 — Operational hardening (průběžně, ~2h work)

Cíl: po prvním týdnu provozu ošetřit edge cases a tuning.

- [ ] **H6.1** Sledovat dlouhodobé GH Actions usage. Pokud >50% měsíčního budgetu po 14 dnech → cron na hodinovou cadenci.
- [ ] **H6.2** Po prvním 5+ bot PRs: review akceptační míra (merged / opened). Pokud <50% → tuning agent prompt nebo zúžit `automation/ok` rozsah.
- [ ] **H6.3** Reprioritizer kalibrace: po 7 dnech zkontrolovat priority distribution (p0/p1/p2/p3 počty). Pokud P0 přebujelé → ladit thresholdy v `RULES`.
- [ ] **H6.4** Cleanup: smazat `automation/blocked` issues starší než 30 dní (po review že byly skutečně blocked).
- [ ] **H6.5** Aktualizovat `docs/playbooks/bot-operations.md` — sekce "Lessons learned" po 2 týdnech provozu.
- [ ] **H6.6** První incident postmortem: pokud bot udělá špatnou změnu → `bot-incident` label + dokumentace v playbook.

**Acceptance:** Po měsíci provozu existuje data o bot performance, escalation playbook je aktualizovaný, žádné překračování GH Actions budgetu.

## Závislostní graf

```
H1 (auth refresh) ─────► A1.1 + A5.1 board ────────────┐
H2 (secrets) ──────► H4 verify ──┐                      │
                                  ├─► H5 merge to main ─┴─► H6 hardening
H3 (discussion cat) ─────────────┘
H4 (Sentry integration) ─────────┘
```

H1, H2, H3, H4 jsou paralelní. Všechny 4 musí být done před H5 (merge), jinak bot bude failovat na missing secrets/categories.

## Časový odhad

| Sprint | User čas | AI čas | Celkový elapsed |
|---|---|---|---|
| H1 | 10s | 5 min | 5 min |
| H2 | 5 min | 15 min | 20 min |
| H3 | 1 min | 3 min | 5 min |
| H4 | 15 min | 5 min | 20 min |
| H5 | 10 min | 30 min (až 24h pro plný cron cycle) | 1h+ |
| H6 | průběžně | průběžně | 2 týdny baseline |

**Realisticky první bot PR během odpoledne.** Plný adoption (smerged, PR statistics, kalibrace) za 2 týdny.

## Blokátory + workaround

| Problém | Workaround |
|---|---|
| User nemá Anthropic API key | Skip H2.1 (placeholder zůstane), H5.1-H5.4 nepoužitelné, ale Sentry+CI signaly fungují |
| GH Actions usage limit překročen | Cron na hourly (`0 */1 * * *`) — sníží 4× usage |
| Sentry GitHub integration nelze nainstalovat (org-level perms) | `sentry-triage.mjs` cron je fallback (vyžaduje jen SENTRY_AUTH_TOKEN) |
| Discussion category create blokovaný | Daily digest workflow ne-failne, jen vypíše "category not found" + výstup do logu |
| Merge na main blokován hooky | Preview cron pomocí `pull_request` triggeru, ale to znamená každý PR push spustí bot — ne-doporučeno |

## Otevřené otázky

- **Anthropic Claude Code Action**: existuje oficiální verze nebo musíme rollat custom Node action s `@anthropic-ai/sdk`? Default: zkusit oficiální, fallback na custom.
- **Bot identity = `github-actions[bot]` vs separátní GH App**: současná iterace používá `GITHUB_TOKEN` (= github-actions[bot]), což je default a funguje. Migrace na GH App je v ADR uvedená jako budoucí možnost.
- **Multi-repo skalování**: pokud chceme stejný bot v garaaage-law nebo dalším repu, potřebujeme org-level workflow + secrets. Mimo scope této iniciativy.

## Log

- 2026-04-27 — založeno; reaguje na 5 user-blocking blokátorů z bootstrap iniciativy
