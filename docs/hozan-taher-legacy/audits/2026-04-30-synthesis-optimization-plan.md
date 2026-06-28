# Synthesis — Optimization Plan (2026-04-30)

> Status: complete
> Datum: 2026-04-30
> Trigger: User direction — synthesize 4 deep inventories (PR #420/421/422/427) + project_autonomous_dev_north_star do prioritized step-change roadmap. Pure docs, žádný code change.
> Inputs: `2026-04-30-deep-inventory-code.md`, `2026-04-30-deep-inventory-autonomous-dev.md`, `2026-04-30-deep-inventory-plans.md`, `2026-04-30-deep-inventory-infra.md`, memory rules `project_autonomous_dev_north_star.md` + `feedback_haiku_classifier_heuristics.md`.

## 1. Cross-cutting findings

Pět patterns recurring přes ≥2 inventory reports:

**A. Drift jako default — metadata bez enforcement.**
- 22/36 (61 %) initiative MD bez Status header (plans §1) — porušuje `feedback_initiative_status_required`.
- 191 ad-hoc `os.Getenv` vs 10 `envconfig` imports (code §exec-summary §recs P1) — porušuje envconfig boot-time validation pattern.
- 6+ docs s legacy "12 sender" po PR #418 24-mailbox cutover (code §doc-gaps).
- 6 audit findings missing Status / lifecycle metadata (code §doc-gaps + plans §1).
*Root cause:* žádný PR-time gate co metadata enforced; rely na human discipline.

**B. Half-finished migrations livem dlouho.**
- M6.2 re-export shims `features/platform/dashboard-core` + `services/{mailboxes,campaigns,inbox,contacts}/ui/` (code §dead-code #9-10) — barrel říká "M6.2-B will move files" ale move pending od 2026-04-21.
- ADR-001 collision (code §dead-code #8 + plans §1) — dvě immutable ADRs sdílí číslo.
- Duplicate-hunt PR #403 7 kategorií duplikátů — found AFTER #393 shipped (autodev §search-compliance).
*Root cause:* incremental shipping bez "complete or revert" verdict.

**C. Reactive memory churn.**
- 14 nových `feedback_*` rules per den 2026-04-30 (autodev §recency-cohorts), 7 user pushbacks (autodev §pushback) — memory rules vznikají AFTER violation.
- Rule contradictions: `feedback_max_mode_throughput` vs `feedback_subagent_token_economy` (autodev §contradictions); `feedback_iteration_workflow` vs `feedback_no_premature_iteration`.
*Root cause:* žádný pre-spawn enforcement co testuje rule compliance.

**D. Token economy mismatch.**
- 55 % PRs Haiku-grade na Sonnet (autodev §exec) — direct token cost driver.
- 53 worktrees vs cap 4-5 (autodev §exec) — fleet beyond visibility.
- Search-before-implement compliance 29 % (autodev §search-compliance) — duplicates ship.
*Root cause B+C+D shared:* automation jde do Sonnet bez procedural classification.

**E. Worker + scrapers chybí healthcheck** (infra §services) — odděleně orthogonal infra-only finding; nepřenáší na ostatní reports.

**Strictly orthogonal:** infra (E) je svébytný; ostatní (A-D) jsou silně provázané — A je důsledek C (reactive enforcement), B je důsledek D (no time to finish before next spawn).

## 2. Prioritized step-change roadmap

### Tier 1 — Quick wins (≤1 týden, mechanické)

| # | Item | Scope | Effort | Impact | Source |
|---|---|---|---|---|---|
| T1.1 | Smaž `features/platform/common/invariant/` (197 LoC + 324 LoC test) | Drop pkg + go.mod entry | 30 min | -521 LoC dead | code §dead-code #1, §recs P0 |
| T1.2 | Smaž `features/platform/common/token/GenerateUnsubToken` 8-byte BE phantom | Drop fn + test | 20 min | -53 LoC | code §dead-code #2 |
| T1.3 | Bump `vite` v `features/platform/outreach-dashboard/package.json` | Single-line bump | 15 min | Clear 4 high CVE (dev-only) | code §dep-health, §recs P0 |
| T1.4 | Renumber kolize `ADR-001-dashboard-core-design.md` → `ADR-007-*.md` | Filename + index | 5 min | Resolves immutable-ADR violation | code §dead-code #8, plans §1 |
| T1.5 | Add Status header k 22 non-conformant initiatives + move 7 do `docs/archive/2026-04-30-epoch-close/` | Mechanical sweep | 1 h | -22 drift items | plans §1, §rec IMMEDIATE |
| T1.6 | Add `/healthz` endpoint k worker + scrapers services | 2 fn + Dockerfile prop | 1 h | Railway auto-restart visibility | infra §recs #1 |
| T1.7 | Sweep "12 sender" → "24 sender" v 6+ docs | Mechanical replace | 30 min | Doc accuracy | code §doc-gaps |

**Total Tier 1:** ~3.5 h work, -574 LoC dead, +1 healthcheck pair, -22 drift items, +1 ADR collision resolved.

### Tier 2 — Step-change toward north star (1-4 týdny, design + impl)

Mapped k 8 north-star aspirations (`project_autonomous_dev_north_star`):

| # | Aspiration | Concrete deliverable | Effort | Source |
|---|---|---|---|---|
| T2.1 | **#1 Self-classifying task tier** | Pre-spawn hook script (`.claude/hooks/pre-spawn-classify.sh`) co reads agent prompt title prefix + override keywords (per `feedback_haiku_classifier_heuristics`), auto-applies `model:` param. Block spawn pokud prefix neexistuje v table. | 1 týden | autodev §rec #3, haiku-classifier §procedural |
| T2.2 | **#4 Self-cleaning worktrees** | Post-merge hook v `.githooks/post-merge` co detekuje `git worktree list` >8 + prune locked dirs k merged PRs. Hard cap enforce. | 3 dny | autodev §rec #2 |
| T2.3 | **#5 Self-enforcing search-before-implement** | Pre-spawn agent prompt template enrichment: STEP 1 (BLOCKING) `mcp__claude-context__search_code(query: <concept>)`. Reject spawn pokud absent. | 2 dny | autodev §rec #4 |
| T2.4 | **#3 Self-consolidating memory** | Rule conflict detector — script (`.claude/scripts/memory-rule-audit.sh`) co po každém `feedback_*` create scan existing rules pro >40 % keyword overlap → propose merge. Run weekly cron lokálně. | 4 dny | autodev §rec #6 |
| T2.5 | **#2 Self-auditing fleet** | Recurring inventory agent — schedule týdenní `audit/inventory-*` re-run, diff vs předchozí týden. Sentry-style trend dashboard. | 1 týden | autodev §rec #7 |
| T2.6 | **Server.js extract — top 2 modules** | Z 8744 LoC split out `routes/dsr.js` + `routes/privacy.js` (lowest-risk, isolated surface). Contract tests existují. | 4 dny | code §recs P0 #3 |
| T2.7 | **envconfig adoption ratchet** | Promote `envconfig.GetOr` + `GetBoolOr`; replace 7 `envOr` + 4 `envBoolOr` private copies; add audit test enforcing zero new ad-hoc os.Getenv. | 3 dny | code §recs P1 #5, duplicate-hunt-deep §3 |

**Total Tier 2:** ~5 týdnů parallelizable; 4 z 8 north-star aspirations krytých.

### Tier 3 — Long-term architectural (M+1 to M+3)

| # | Item | Why ADR-grade | Source |
|---|---|---|---|
| T3.1 | **server.js monolith decomposition (full)** — 6-8 route modules: dsr, companies, campaigns, mailboxes, observability, system, unsubscribe, privacy. ADR + multi-PR (one per module). | 8744 LoC + 154 routes; biggest deferred risk | code §recs P0 #3 |
| T3.2 | **env-config single source of truth** — replace 191 ad-hoc `os.Getenv` napříč všemi services. Boot-time validation per ADR pattern. Audit test enforces zero new direct refs. | Cross-service contract change | code §exec-summary, infra §env-vars |
| T3.3 | **Compounding learning loop (north-star #7)** — accumulated operator overrides auto-injected do agent system prompt jako few-shot examples. Replaces manual rule write per pushback. | Foundation infra change to agent harness | autodev §rec, north-star #7 |
| T3.4 | **Predictive operator UI (north-star #6)** — AI suggests which message-pre-send fields operator nejspíš edituje, flagne přednostně k review. Vs current reactive override capture. | Product surface + ML scoring layer | north-star #6 |
| T3.5 | **inbox↔orchestrator cycle resolve** — extract `orchestrator/llm` + `orchestrator/mime` do `features/platform/common/llm/` + `features/platform/common/mime/`. | Architectural import-graph fix | code §dep-health, §recs P3 #12 |

## 3. Anti-patterns to retire

Z inventory + memory rules — 8 patterns ready to deprecate:

1. **Dead memory rules** (autodev §dead-rules): `feedback_no_external_services`, `feedback_no_ci_nag` — single-shot direction, no recurring violation. Archive.
2. **Rule pair `feedback_max_mode_throughput` ⊕ `feedback_subagent_token_economy`** — explicit contradiction (autodev §contradictions). Consolidate do `feedback_agent_fleet_manual.md`.
3. **Rule pair `feedback_iteration_workflow` ⊕ `feedback_no_premature_iteration`** — `Pokračujeme` token ambiguity. Consolidate s explicit grammar.
4. **Half-finished M6.2 re-export shims** — `features/platform/dashboard-core` + 4× `services/*/ui/`. Decision: complete OR revert (code §recs P3 #13).
5. **Coverage-padding tests** — `*coverage_gaps*test*.go`, `coverage_test.go` >800 LoC (~5000 LoC). Build-tag-gate (code §recs P2 #9).
6. **`time.Sleep` v 45 Go test files** — 113 call-sites, flake risk (code §test-pyramid). Replace s testclock.
7. **ADR-001 dual collision** — immutable doc convention violated (code §dead-code #8).
8. **`modules/outreach/CLAUDE.md` orphan** — directory now obsahuje pouze configs/templates; CLAUDE.md content přesunout do root nebo smazat (code §dead-code #11).

## 4. Concrete next 48h plan

Sequence: T1.1-T1.7 paralelně (independent files), pak T2.1 + T2.2 v sekvenci (T2.1 musí land před T2.2 protože worktree cleanup hook reads tier classification z hook log).

| # | Branch | Model tier | Est. LoC delta | Ordering | Depends on |
|---|---|---|---|---|---|
| T1.1 | `chore/delete-common-invariant` | **haiku** (chore + dead code) | -521 | parallel | none |
| T1.2 | `chore/delete-common-token-phantom` | **haiku** (chore + dead code) | -110 | parallel | none |
| T1.3 | `chore/bump-vite-cve` | **haiku** (chore bump) | +1/-1 | parallel | none |
| T1.4 | `docs/adr-001-renumber` | **haiku** (docs rename) | +0/-0 (rename) | parallel | none |
| T1.5 | `docs/initiative-status-headers-batch` | **haiku** (docs sweep) | +44 (22 headers) | parallel | none |
| T1.6 | `feat/worker-scrapers-healthcheck` | **sonnet** (feat + 2 services) | +60 | parallel | none |
| T1.7 | `docs/24-sender-doc-sweep` | **haiku** (docs replace) | +6/-6 | parallel | none |
| T2.1 | `feat/pre-spawn-classify-hook` | **sonnet** (new harness layer) | +180 | sequential | T1.* land |
| T2.2 | `feat/worktree-lifecycle-hook` | **sonnet** (new ops layer) | +120 | sequential | T2.1 |

Handoff points:
- T1.1-T1.7 → admin-merge as ready, no Chat A↔B handoff (mechanical).
- T2.1 → emit `Needs-Tests: pre-spawn-classify hook contract` trailer for Chat B unit test coverage.
- T2.2 → `Needs-Tests: worktree-lifecycle post-merge integration` trailer.

## 5. Self-evaluation criterion (re-inventory za 1 týden)

5 measurable metrics co po týdnu ukáží zda optimization shipped:

| # | Metric | Baseline (2026-04-30) | Target (2026-05-07) | Source |
|---|---|---|---|---|
| M1 | % PRs Haiku-grade running on Sonnet | 55 % (33/60) | < 20 % | autodev §exec |
| M2 | `git worktree list` count (live worktrees) | 53 | < 10 | autodev §exec |
| M3 | Initiatives bez Status header | 22/36 (61 %) | < 5 (< 14 %) | plans §1 |
| M4 | Search-before-implement compliance (PR titles citing existing work) | 29 % (proactive 0) | > 70 % proactive | autodev §search-compliance |
| M5 | `features/platform/outreach-dashboard/server.js` LoC OR route-module split count | 8744 LoC, 1 file | < 7000 LoC OR ≥ 3 modules | code §exec, §recs P0 #3 |

Bonus signal: nové `feedback_*` rules per týden < 3 (vs baseline 14 v jeden den) — indicates pre-spawn hooks zachytávají friction před pushback.

---

**Methodology:**
- 4 inventory reports + 2 memory rules read fully before tier ordering.
- Tier ordering = ROI (effort vs LoC/drift impact + north-star aspiration coverage), ne FIFO.
- Per item cite `<inventory-file>.md §<section>` nebo file:line.
- Žádné nové findings — pure synthesis.

**Branch:** `audit/synthesis-optimization-plan-2026-04-30` (base=main).
**Generated:** 2026-04-30.
