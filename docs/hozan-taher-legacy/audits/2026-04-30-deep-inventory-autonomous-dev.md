# Deep Inventory — Autonomous Development (2026-04-30)

> Status: complete
> Datum: 2026-04-30
> Trigger: user direction "Deep inventory autonomous development — memory rules + agent fleet effectiveness"
> Scope: 2026-04-29 → 2026-04-30 (60 PRs merged from 12:00 onwards), 49 memory rules, 56 agent worktrees

## Executive summary

Den 2026-04-30 vyprodukoval **60 mergnutých PRs** za ~12 h s **53 souběžnými agent worktrees** v běhu (peak). Throughput vysoký, ale data ukazují čtyři systémové slabiny:

1. **55 % Haiku-grade úkolů jelo přes Sonnet agenty.** 33/60 PR titulů nese mechanické značky (cleanup, audit, drift, refactor, sweep, ratchet, snapshot fix). Většina < 200 LOC delta. User /usage report (interní citace v `feedback_subagent_token_economy`): 91 % token usage → subagent-heavy, 81 % at >150k context. To je primární cost driver.
2. **Search-before-implement gate fungoval pouze reaktivně.** PR #393 vytvořil duplicate `enforceAirtightGate` → audit PR #403 odhalil 7 kategorií duplikátů (HMAC token 3×, envOr 8×, slogop scanner 8×, UNION SQL 7×, ratelimit 4×, airtight 2×). Memory rule `feedback_search_before_implement.md` byla vytvořena **v 21:42** — po faktu. 6 consolidation PRs (#404-#409) následovaly opravně.
3. **53 souběžných worktrees vs. dokumentovaný strop "max 4-5 simultaneously".** Memory rules `feedback_max_mode_throughput.md` (5 default) a `feedback_subagent_token_economy.md` (2 default, 3-4 výjimkou) jsou **explicitně contradictory** — druhá explicitně označuje první jako "TOO AGGRESSIVE". Žádná z těchto čísel ale neodpovídá faktickému stavu disku (53 locked agent dirs).
4. **Tři po sobě jdoucí "STOP musíme spát" pushbacky** dokumentované v `feedback_max_mode_throughput`. Trigger: status report bez nového výstupu. Rule existuje — porušení pokračovala dál.

Top recommendation: **uzavřít a sloučit duplicate memory rules** (max-mode + subagent-economy + spawn-first-solo-second + efficient-execution = jeden "agent fleet operating manual"), **přidat hard cap na live worktrees** (≤8 visible v `git worktree list`), a **přesunout všechny ratchet/drift/snapshot úkoly explicitně na Haiku tier** s memory rule trigger `if title.startswith("chore|test(contract)|docs(claude)|fix(test)") → Haiku`.

---

## Memory rules taxonomy + violations heat-map

49 memory files celkem (48 rule MDs + MEMORY.md index). Rozdělení podle prefixu:

| Prefix | Počet | Typ |
|---|---|---|
| `feedback_*` | 32 | User-feedback driven rules |
| `project_*` | 16 | Stable project facts |
| `worktree_convention` | 1 | Operational layout |
| `user_role` | 1 | Identity |

### Recency cohorts

| Cohort | Created | Count |
|---|---|---|
| Pre-2026-04-22 (founding rules) | Apr 19-22 | 7 |
| Mid-month (Apr 23-28) | Apr 23-28 | 22 |
| Last 48 h | Apr 29-30 | 19 |
| **2026-04-30 only** | Apr 30 (one day) | **14** |

**Finding:** 14 nových memory rules za jeden den = nejvyšší recorded rate. Růst diktovaný incidenty:
- `feedback_max_mode_throughput` (15:21) → user opakovaně 3× "sedíš na zadku"
- `feedback_check_backlog_when_idle` (17:44) → user "co jsi celou hodinu dělal"
- `feedback_efficient_execution` (17:57) → user "diminishing returns"
- `feedback_spawn_first_solo_second` (18:24) → procedural fix
- `feedback_search_before_implement` (18:42) → "to je demence"
- `feedback_subagent_token_economy` (20:26) → /usage report
- `feedback_verify_external_before_implement` (12:09) → 401 privacy URL near-miss

### Rule contradictions identified

| Rule A | Rule B | Konflikt |
|---|---|---|
| `feedback_max_mode_throughput` (default 4-5 agents) | `feedback_subagent_token_economy` (default 2 max, exception 3-4) | Numeric default. Rule B explicitně označuje A jako "TOO AGGRESSIVE" + "nahrazeno tímto pravidlem", ale A není smazaná, jen zdiskreditovaná. |
| `feedback_max_mode_throughput` (Caveman+RTK aby zbyly tokeny pro work) | `feedback_subagent_token_economy` (subagent run = full session-load) | Mental model. A: úspora ve výpisu. B: úspora ve spawn count. Obojí pravda; ale operator čte nesouvisle. |
| `feedback_iteration_workflow` ("propose → execute → summarize → propose next; never ask permission mid-flight") | `feedback_no_premature_iteration` ("Pokračujeme = status check, ne auto-execute") | Behaviorální. Konflikt vyřešen pouze pokud `Pokračujeme` jasně oddělen jako protokolární token. V praxi user píše "pokračuj" volně. |

### Dead rules (likely-not-applied)

Heuristika: rule >7 dní stará a žádný PR/audit/issue na ni necituje za poslední týden.

| Rule | Last touched | Dnes referenced? |
|---|---|---|
| `feedback_no_external_services` | Apr 19 | ne (žádný PR add S3/AWS) |
| `feedback_memory_explosion` | Apr 21 | ne (paradoxně proběhlo opačné — explosion happened today) |
| `project_protection_matrix` | Apr 21 | ne |
| `project_proxy_sources` | Apr 28 | ne (no proxy churn) |
| `feedback_no_ci_nag` | Apr 25 | ne |

Dead-rule audit doporučení: žádný cleanup nutný (rule cost ≈ 0 tokenů jakmile je v memory), ALE **`feedback_memory_explosion` selhala** — dnes přibylo 14 nových rules → review needed: jsou všechny `feedback_*` z dnešního dne mergeable?

### Gap (často-violated, no rule)

| Pozorovaný anti-pattern | Frekvence dnes | Memory rule? |
|---|---|---|
| Spawning 4-5 agentů pro Haiku-grade úkoly | ~33/60 PRs | částečně řešeno B (ne enforceable) |
| Worktree cleanup ne-na-konci-úkolu | 53 locked worktrees na disku | ❌ chybí |
| BOARD/handoff updates mid-flight místo end-of-session | ~6 PRs | ❌ chybí |
| Audit-only PR vytvořený a ignorovaný (no follow-up) | některé před-04-29 audits nečištěné | částečně `feedback_initiative_status_required` |
| Initiative documents bez search-before-write | #402 reality-check po faktu | ❌ chybí (=> initiative-mention drift rule) |

---

## Agent fleet efficiency analysis

### Throughput (2026-04-30 12:00 → 23:59)

| Metric | Hodnota |
|---|---|
| PRs merged | 60 |
| Lines changed (median est.) | ~250 |
| Active worktrees na konci dne | 53 |
| Souběžně spawnnutých agentů (peak per memory) | 5+ (cap "kolem 8 hits Anthropic limit") |
| Locked worktree dirs | 53 |
| Sessions ratelimit hit reportováno | ≥1 ("salvaged from rate-limited agent" v PR #369, #370, #371) |

### Sub-agent task taxonomy (dnes)

Heuristic z PR titulu + size:

| Kategorie | Count | % | Tier správný? |
|---|---|---|---|
| Audit/ratchet sweep | 8 | 13 % | Haiku ano |
| Drift fix (CLAUDE.md, snapshots) | 5 | 8 % | Haiku ano |
| Test infra fix (env restore, contract snapshot) | 7 | 12 % | Haiku ano |
| Refactor consolidation (post-#403) | 6 | 10 % | Sonnet (decisions) |
| Feature implementation (KT-A*, KT-B*) | 18 | 30 % | Sonnet ano |
| Docs/strategy | 9 | 15 % | Haiku/Sonnet split |
| Security/GDPR | 4 | 7 % | Sonnet ano |
| Cleanup (worktree, branches) | 3 | 5 % | Haiku ano |

**Estimate Haiku-grade share: 33/60 = 55 %.** Pokud běžely Sonnetem (default per CLI) → token ROI sub-optimal. Concrete saving příklad: PR #382 (9 LOC todo→it promotion), PR #395 (3 LOC docs ref), PR #396 (8 LOC sentinel ratchet) → byly run jako standalone agents = 3× full session-load pro 20 LOC celkem.

### Token-economy sentinel violations

Z `feedback_subagent_token_economy` rule pattern:
- Default max 2 simultaneous → **violated** (53 worktrees + report agentů hitsujících ratelimit)
- "Pokud /usage >85 % subagent-heavy → memory rule selhal" → **detected** (rule sama říká 91 %, vytvořena 20:26 — ale spawning pokračoval → 419 mergován ve 23:35)

---

## Search-before-implement compliance score

### Quantitative

PR titles/bodies obsahující "existing|searched|gh search|grep|duplicate|reuse":
- 25/60 (42 %) zmiňuje některý keyword v body
- 12/60 (20 %) explicitně řeší duplicate/consolidation

PR #403 audit našel 7 kategorií duplikátů. Per-domain breakdown s odhadem "kdyby byl search-first run":

| Duplicate | Original PR | Count | Catch rate kdyby search-first |
|---|---|---|---|
| `enforceAirtightGate` ↔ `ValidateAirtight` | #393 | 2 | 95 % (jméno explicit overlap) |
| HMAC unsubscribe token | various | 3+4 inline | 80 % (concept query) |
| `envOr` | many | 8 | 60 % (concept ano, ale "common pattern") |
| `slog_op_audit_test.go` AST scanner | various | 8 | 70 % (filename pattern) |
| `_unsubAllow` / `_dsrAllow` clones | various | 4 | 50 % (variable name overlap nutný) |
| Suppression UNION SQL | 7 read sites | 7 | 65 % |

Net: **konzervativní 12-15 PR** by zůstalo ushuffled, kdyby search-first proběhl. Celkové savings: ~6 PRs (consolidation #404-#409 by nebyly nutné jako separate cleanup).

### Qualitative

Search-first rule (`feedback_search_before_implement`) sama dnes vytvořena ve 21:42. Před-21:42 PRs žádný indikátor že agent provedl search. Post-21:42 PRs (#403-#419) — pět z nich jsou direct follow-up consolidation k #403 audit, takže search trigger byl audit findings, ne rule.

**Compliance score = 0/15 (proactive) + 6/6 (reactive post-audit) = 6/21 = 29 %**.

---

## Communication patterns

### Status report frequency

V dnešním 12 h okně neměří se conversation transcript, ale heuristika z PR descriptions + handoff BOARD entries:
- BOARD update PRs: #410 (single explicit handoff)
- Auto-merge PRs bez human-readable kontextu (jen `Co-Authored-By` block): vetšinou OK

`feedback_efficient_execution` říká "no status reports" — dnes 1 BOARD update PR (#410) + samostatné PR descriptions = mírné porušení (BOARD má být inline session, ne separate PR), ale acceptable.

### User pushback events (dnešek)

Detected v memory rule creation context:

| Čas | Pushback | Spuštěno čím | Výstup |
|---|---|---|---|
| ~12:09 | "ověř externí přede claim done" | privacy URL 401 broken-link incident | `feedback_verify_external_before_implement` |
| ~13:33 | (po předchozí session) "spawnuj background agenty paralelně" | sekvenční loop v hlavním vlákně | `feedback_agent_fleet` |
| ~17:44 | "co jsi celou hodinu dělal" | implicit idle gap | `feedback_check_backlog_when_idle` |
| ~17:57 | "diminishing returns = systemic fix not stop" | po několika malých PRs | `feedback_efficient_execution` |
| ~18:24 | (procedural) | spawn-first vs solo-second order | `feedback_spawn_first_solo_second` |
| ~18:42 | "to je demence, audit kódu zda neprogramuješ něco co už máme" | PR #393 duplicate | `feedback_search_before_implement` |
| ~20:26 | /usage report (91 % subagent-heavy) | implicit | `feedback_subagent_token_economy` |
| ~21:24 (3×) | "sedíš na zadku, dělej minimum" | spawn-1-and-wait | `feedback_max_mode_throughput` |

**Total: 7 distinct rule-creating pushback events za jeden den.** Memory rule churn = vysoká reaktivita, ale pravidla samotná neoperační (jiná pravidla je překrývají).

---

## Top 10 process improvements (prioritized)

1. **CRITICAL — sloučit `feedback_max_mode_throughput` do `feedback_subagent_token_economy`.** Vznikne `feedback_agent_fleet_operating_manual.md`. Single source of truth pro: spawn budget, per-task tier, caveman/RTK token economy, anti-patterns. Smazat rule které ji říká "TOO AGGRESSIVE".
2. **HIGH — přidat memory rule `feedback_worktree_lifecycle.md`.** Hard cap 8 live worktrees v `git worktree list`. Auto-cleanup task po každém merge: prune locked worktree directory.
3. **HIGH — Haiku-explicit list v rule.** "Pokud title startswith `chore(`, `docs(claude)`, `test(contract) snapshot`, `fix(test)`, `refactor: extract` → Haiku tier vždy." 33 dnešních PRs by tomu odpovídalo.
4. **HIGH — search-first MUST trigger v agent prompt template.** Prompt pre-amble: "STEP 1 (BLOCKING): mcp__claude-context__search_code(query: <concept>) before any new function/struct/test."
5. **MEDIUM — initiative reality-check rule.** Před implementací AT/KT sprint task: search for matching PR title or function name. PR #402 by byl pre-empted.
6. **MEDIUM — duplicate-rule detector.** Po každém memory rule create: scan existing rules pro overlap. Pokud >40 % keyword overlap → propose merge nebo deprecation.
7. **MEDIUM — pushback frequency dashboard.** Pokud >3 user pushbacky / 24 h → STOP spawning, audit posledních 10 PR proti memory rules. Dnes 7 pushbacků nikdy nezpůsobilo halt.
8. **MEDIUM — rule recency cap.** Po 7 dnech bez citation v PR/audit/issue → proposal to mark rule as `archived`. Memory cost je malý, ale signál o effectiveness chybí.
9. **LOW — BOARD updates inline, ne separate PR.** PR #410 byl pouze BOARD update — splitnout do "session-end summary" mechanismu (BF-G ops pattern).
10. **LOW — `Pokračujeme` token disambiguation.** Jasně define: "Pokračuj" = status check (read `feedback_no_premature_iteration`); "spawn next batch" = explicit verb. Aktuálně `feedback_iteration_workflow` říká opak.

---

## Memory rule additions/consolidations recommended

### Add (nové gaps)

- **`feedback_worktree_lifecycle.md`** — hard cap, auto-cleanup, post-merge worktree prune.
- **`feedback_haiku_grade_classifier.md`** — explicit title-prefix → tier mapping.
- **`project_search_first_query_book.md`** — sdílený seznam search queries per doména (extrahovat z `feedback_search_before_implement` table).

### Consolidate (overlapping)

- `feedback_max_mode_throughput` ⊕ `feedback_subagent_token_economy` ⊕ `feedback_spawn_first_solo_second` ⊕ `feedback_efficient_execution` → jedno **`feedback_agent_fleet_manual.md`**. Token saving ~250 lines → ~80 lines, single mental model.
- `feedback_iteration_workflow` ⊕ `feedback_no_premature_iteration` → jedno **`feedback_iteration_protocol.md`** s explicit `Pokračujeme` / `Spawn` token grammar.

### Deprecate / archive

- `feedback_no_ci_nag` (single-shot user direction, no recurring violation)
- `feedback_memory_explosion` paradoxně sama ironickou obětí dnešního růstu — buď enforce nebo retire. Doporučení: enforce přes "max 1 nová `feedback_*` rule per session" cap.

---

## Citation index

- 60 PRs analyzed: viz `git log origin/main --since="2026-04-30 12:00"`
- 49 memory files: `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory/`
- 53 worktrees: `git worktree list`
- Duplicate audit findings: PR #403 body
- Pushback events: rule creation timestamps + descriptions per `stat -f` output
- /usage citation: `feedback_subagent_token_economy.md` line 9-13 (91 % subagent-heavy, 81 % >150k)
