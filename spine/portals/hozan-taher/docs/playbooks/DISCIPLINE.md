# DISCIPLINE — pravidla rytmu a kvality

**Status:** active
**Owner:** tomas
**Last review:** 2026-04-22
**Kind:** operational playbook (living)

## Úvod

Tento playbook existuje proto, že projekt sklouzl do driftu: CI 10/10 runs red, PR #8 CONFLICTING >24h, 65 auditovaných HIGH/MEDIUM bugů napříč 6 službami s 0 fixy v 5 dnech, plaintext secrets v lokálním `.env`. Root cause není nedostatek úsilí — je to absence vynutitelných gate, které by rytmus změn držely v rovnováze s rytmem konsolidace. Tento dokument kodifikuje minimální sadu pravidel pro **kohokoliv, kdo commituje do tohoto monorepa** (Tomáš + jakýkoliv AI agent/Chat A/Chat B/Codex). Pravidla jsou actionable: každé má konkrétní enforcement mechanismus (hook, gate, SLA, nebo review check). Když pravidlo nedává smysl v konkrétní situaci → dokumentovaná exception, ne tichý bypass.

## Merge pravidla

| Pravidlo | Enforcement |
|---|---|
| PR nelze mergnout, pokud CI není green (unit + integration + E2E) | `branch protection rule` na `main`, GitHub required checks |
| PR se statusem CONFLICTING > 24 h → rebase nebo close | Weekly rollup check + `gh pr list --search "is:open"` audit |
| Přímý push na `main` je zakázán | `.githooks/pre-push` blokuje, exceptions viz CLAUDE.md (`docs/handoff/*.md` + `CLAUDE.md` doc-pointer edits) |
| Squash merge preferred pro features | GitHub default merge strategy = squash; merge commit jen pro release branches |
| PR ≤ 500 změněných řádků (target) | Reviewer komentář, jinak split; exception pro migrace (test-to-test) |

Force-push na `main` nebo na kohokoliv jiného PR branch = HARD NO, bez výjimky.

## Definition of Done

PR je **done** teprve když všechny body prošly:

- [ ] **CI green** — unit + integration + E2E, poslední run na HEAD commitu
- [ ] **Rebased on main** — žádné merge konflikty, HEAD je fresh vůči main
- [ ] **Docs update v tom samém PR** — CLAUDE.md (pokud mění workflow), README (pokud mění veřejné API), relevant playbook (pokud mění operational flow)
- [ ] **Audit items resolved** — žádný unaddressed HIGH v dotčeném kódu (viz `memory/project_*_quality_debt.md`); pokud HIGH existuje a není v scope → explicit note v PR description s odkazem na tracking issue
- [ ] **Owner sign-off** — pokud autor není owner dotčeného kódu (viz `docs/playbooks/SERVICES.md` až vznikne), vyžaduje se approval od ownera
- [ ] **Tests** — happy path + minimálně 1 edge case; bez tests žádný merge (exception: pure docs/comment-only PR)
- [ ] **Commit trailers** — pokud PR mění kontrakt (`Breaks-Contract:`), potřebuje testy (`Needs-Tests:`), nebo kryje PR (`Covers:`/`Resolves-Trailer:`) — trailery přítomny

PR, který nesplňuje DoD, je **WIP** — nedostává review capacity kromě direction-level feedbacku.

## Audit → Fix SLA

Audity z `memory/project_*_quality_debt.md` mají tvrdá SLA okna. Pokud item v okně nedostane fix ani vědomou deprecation, eskaluje se.

| Severity | SLA do fixu | Co se stane po expiraci |
|---|---|---|
| CRITICAL (security, data loss, prod outage) | ≤ 24 h | Immediate stop-the-line; žádné další featury, dokud není fix/mitigation |
| HIGH | ≤ 7 dní | Eskalace: item se přesouvá z auditu do aktivního backlogu (GitHub issue) s autorem jako assignee; jinak **remove jako "won't fix"** s důvodem v memory |
| MEDIUM | ≤ 30 dní | Deprecate (remove jako "won't fix") nebo explicit extension v memory s novým termínem |
| LOW | Best-effort | Fix při oportunitní úpravě dotčeného souboru |

**Týdenní audit review** (30 min): projít memory `*_quality_debt.md`, posunout expirované itemy, smazat vyřešené. Bez review se dluh nehlídá.

## Secret rotation policy

Secrets jsou **jediný nereversibilní typ bugu** — leakovaný klíč nelze "fixnout", jen rotovat. Pravidla jsou proto tvrdá:

| Situace | Akce | Timeline |
|---|---|---|
| Secret logged do souboru (včetně chat transcriptu, session logu) | Rotate + smazat z logu | ≤ 24 h |
| Secret pasted do chat (Claude, Slack, cokoliv) | Rotate | ≤ 24 h |
| Secret commited do gitu (i později amended/force-pushed) | Rotate + `git filter-repo` / BFG | ≤ 24 h |
| Secret ve screenshotu nebo PDF | Rotate | ≤ 24 h |

**Storage pravidla:**

- Live heslo patří do DB (AES-GCM encrypted) — ne do env vars
- Env vars na Railway jen pro **bootstrap** secrets (DB URL, master key)
- `.env` lokálně **nikdy** s prod credentials — používat `railway run <cmd>` místo exportu do shellu
- `.env.example` musí obsahovat placeholders pro všechny required env vars (bez real hodnot)

**Monthly rotation review** (1. den měsíce, 15 min): projít `docs/playbooks/SECRET-ROTATION-LOG.md`, ověřit, že žádný secret není starší než 90 dní bez rotace, zapsat rotation events. Bez logu se rotace nehlídají.

## Code review

| Pravidlo | Detail |
|---|---|
| Minimum 1 approval před merge | I vlastní PR potřebuje self-review průchod + sign-off od druhého agenta/přes BOARD pokud je autor AI |
| Kdokoliv může review | Není "assigned reviewer" pipeline — kdokoliv s kontextem |
| Review SLA: ≤ 48 h response | I krátké "podívám se zítra" je valid response. Ticho = eskalace |
| "Request changes" jen pro blocker | Security, correctness, CI-breaking change, missing tests. Jinak `comment + approve` a merger si rozhodne |
| Review covers diff + test coverage + docs | Ne jen kód — docs a testy jsou první-class review artifacts |

Pokud review neboří merge timeline a reviewer je neresponzivní > 48h → self-merge s PR comment "merged after 48h silence per DISCIPLINE.md".

## TDD / E2E pravidla

| Scénář | Pravidlo |
|---|---|
| Nový feature | Test-first: RED (failing test) commit → GREEN (implementation) commit; oba v PR |
| Refactor | Existing tests musí projít **beze změn**. Pokud test changes nutný → separate commit s review reason v message |
| Bug fix | Regression test v RED/GREEN párování; bez regression testu žádný merge |
| Pure docs / comments | Tests not required |
| Performance optimalizace | Benchmark před/po v PR description; test že původní behavior nezměněn |

**E2E suite spustit před každý production deploy.** Railway auto-deploy na merge → E2E musí být součást CI gate před merge, ne post-deploy check.

Coverage target: **80%** pro nový kód (viz `~/.claude/rules/common/testing.md`). Legacy kód zůstává na aktuálním coverage; každý touched file by měl mít net-positive delta.

## Co dělat když

| Situace | Reakce |
|---|---|
| **CI je red** | Fix nebo skip s tasklinkem (GitHub issue), nikdy nemerguj "we'll fix later". Red CI blokuje merge queue ostatních |
| **PR visí > 3 dny open** | Weekly rollup rozhoduje: merge (pokud DoD splněno), rebase (pokud CONFLICTING), nebo close (pokud out-of-scope) |
| **Audit debt roste** | Týdenní review — deprecate nejstarší HIGHs, které nejsou load-bearing, nebo je přesuň do aktivního backlogu s ownerem |
| **Secret leak detected** | Stop-the-line; rotate → audit všech logů → commit s rotation note v `SECRET-ROTATION-LOG.md` |
| **Main worktree má uncommitted changes > 8 h** | Commit relevant changes, revert noise. "Hanging state" je P0 cleanup |
| **Railway deploy FAILED** | Nezkoušej restart bez root cause. Check logs → fix → re-deploy; max 2 retry, pak eskalace |
| **PR autor není dostupný** | Po 48 h ticha: kdokoliv s kontextem může převzít, rebase a dokončit. Attribution zůstává v commit history |

## Odkazy

- [`CLAUDE.md`](../../CLAUDE.md) — monorepo workflow, branch model, handoff protokol
- [`docs/initiatives/2026-04-22-discipline-and-domain-migration.md`](../initiatives/2026-04-22-discipline-and-domain-migration.md) — master plan, který tento playbook naplňuje (P1-1, P2-3)
- [`docs/playbooks/SERVICES.md`](./SERVICES.md) — deploy ownership per service (vzniká v P2-4)
- [`docs/playbooks/SECRET-ROTATION-LOG.md`](./SECRET-ROTATION-LOG.md) — rotation events + monthly reviews
- [`docs/playbooks/DOMAIN-MIGRATION.md`](./DOMAIN-MIGRATION.md) — checklist pro migraci domén (vzniká v M0-3)
- [`docs/handoff/BOARD.md`](../handoff/BOARD.md) — sdílený stav mezi Chat A / Chat B
- `memory/project_*_quality_debt.md` — audit items pod SLA režim
- [`~/.claude/rules/common/code-review.md`](~/.claude/rules/common/code-review.md) — general code review standards (tento playbook je projekt-specific overlay)
