# Post-D2 Recovery + Stabilization Plan — 2026-05-03 (round 3)

**Status:** active
**Vlastník:** Chat A (engineering)
**Datum založení:** 2026-05-03
**Datum uzavření:** —
**Trigger:** Třetí cyklus reindex + deep inventory + Plan v jednom session-dni. Po dnešní D1+D2+D3+D4+D5 práci (15+ PRs mergnutých, 8000 LoC purged, server.js shrunk 9285→6619, 6 D2 mounters wired, 3 ratchety na 0) se objevily dva production incidents (PR #661 mass-revert, PR #666 broken-import) a šest nových paralelních inventory agentů odhalilo soustavné CI degradation, P0 regression a chronic branch sprawl. Tento plán adresuje recovery z incidentů + stabilizaci CI signal + dokončení D2 sequentially + řešení P0 #596.

## Kontext

Stávající stav po dnešním session je rozporuplný. Pozitivně: server.js prošel kontrolovanou dekompozicí — 116 → 73 inline routes a 9285 → 6619 LoC (-30 %), šest mounter modulů (companies, scoring, templates, meta, protections, contacts) je wired přes `src/server-routes/` adresář. Tři audit ratchety (contacts/enrichment, mailboxes/watchdog, relay/transport slog-op) klesly z baseline 11+14+11 na 0. Pět dependabot PRs mergnuto (#517-521). Devět GH issues uzavřeno (#284-287, #279-280, #291-293, #336). Test count rostl z ~5700 na 11 782 napříč Go + React.

Negativně: dva production incidents během dne odhalily systémový problém s parallel agent worktrees na sdílených souborech. PR #661 cherry-picked CLAUDE.md correction ze stale base force-pushed a nechtěně reverted 369 souborů včetně D2.2 companies extract. Recovery via PR #662 revert. Pak PR #666 (D2.7 meta) merged se sibling-worktree imports refencujícími protections.js + contacts.js které nebyly na main — main se stal unstartable. Recovery via PR #669 emergency restore. Memory entry `feedback_cherry_pick_stale_base_danger` (T1) zachycuje pattern.

Šest paralelních inventory agentů potvrdilo další problémy: **P0 #596** flaguje bare `sql.ErrNoRows` compare v orchestrator (audit failure regression). Dashboard memory_tier_audit test má 8 failures protože MEMORY-INDEX.md neobsahuje `content-render` subsystem entry (po reindexu). Čtyři CI workflows na main jsou chronicky red (CodeQL Security Analysis, Go Services CI, Dashboard Real-Backend Smoke, Build & Push to GHCR — 4-5 consecutive failures each). Remote branch sprawl je 253 (jen menšina má open PR), 24 worktrees s 16 locked. server.js zbývajících 73 inline routes je dominantně mailboxes (35 routes, 3269 LoC) — sequential extraction necessity per dnešní lekce.

Audit ratchety jsou jediná čistá zóna: 22 z 23 GREEN at baseline 0 (no drift), jeden non-ratchet failing test v `humanize/diacritics_audit_test.go` který je production logic bug, ne ratchet drift.

## Cíle

První a nejnaléhavější cíl je opravit P0 #596 (bare sql.ErrNoRows compare). Tento ratchet failure blokuje CI signal pro všechny orchestrator PRs a může maskovat další latentní bugs v error handling. Memory `project_bf_g_ops_tooling` (T1) říká že error patterns musí být `errors.Is(err, sql.ErrNoRows)` ne raw equality compare per F1-3 sweep PR #168.

Druhý cíl je obnovit CI workflow signal opravou nebo izolací 4 chronických failures. Bez funkčního CI baseline jsou všechny budoucí PRs slepé — admin-merge bypassuje signal a riskuje další produkční incidents jako dnešní dva.

Třetí cíl je dokončit D2 server.js dekompozici sequentially (jeden agent při jednom čase, nikdy paralelně na server.js). Mailboxes je největší zbývající blok (35 routes, 3269 LoC). Pokud splittnut na 2 batches (campaign-related + admin/heal/score), každý batch je single-PR sequential s discipline tests.

Čtvrtý cíl je fix dashboard memory_tier_audit failure (8 failing tests blokují dashboard CI). Příčina je missing `content-render` subsystem entry v MEMORY-INDEX.md (po reindex sweep nepřesnost). 5-min fix přidat řádek.

Pátý cíl je hygienic cleanup branches (253 remote → goal <50). Dependabot už hotový. Zbývající jsou orphan agent worktrees + stale feature branches. Memory pattern `feedback_cherry_pick_stale_base_danger` ukazuje že stale branches jsou risk faktor — čím méně, tím lépe.

Šestý a poslední cíl (operator-gated) je apply migration 048 na outreach-db. Suppression UNION trigger sync je production safety improvement, čeká od D1 sprintu na operator psql consent.

## Plán (sprinty)

### Sprint E1 — P0 #596 sql.ErrNoRows fix (1 sezení) {#sprint-e1}

Cíl je opravit bare `sql.ErrNoRows` compare v orchestrator a obnovit ratchet baseline 0. Single agent, single PR, žádný parallelism.

E1.1 — agent identifikuje failing audit ratchet test soubor (`grep -rn "TestNoDirectSqlErrNoRowsCompare" features/inbound/orchestrator/`). Read failing assertion + capture which file/line obsahuje bare compare.

E1.2 — fix: nahradit `if err == sql.ErrNoRows` za `if errors.Is(err, sql.ErrNoRows)`. Identifikovat všechny call sites (může jich být víc než jeden) a fix all in single PR.

E1.3 — verify ratchet pass: `cd features/inbound/orchestrator && go test -run TestNoDirectSqlErrNoRows ./...` + plus race full suite aby žádný regression.

DoD sprintu E1: P0 ratchet GREEN, audit baseline restored, no regression. PR mergnut.

### Sprint E2 — CI workflow chronic failures triage (1-2 sezení) {#sprint-e2}

Cíl je obnovit CI signal pro 4 workflows které chronicky padají na main (CodeQL Security Analysis, Go Services CI, Dashboard Real-Backend Smoke, Build & Push to GHCR). Bez signal baselinu je každá další admin-merge blind risk.

E2.1 — per-workflow root cause identification. Agent přečte poslední 5 fail logů per workflow (`gh run view <run-id> --log-failed`). Output `reports/ci-rca-2026-05-03.md` s per-workflow:
- Root cause: missing dependency / config drift / external dep change / actual bug
- Fix complexity: trivial (config) / moderate (env vars) / significant (test rewrite)
- Risk if we don't fix: high (security blocker) / medium (gradual decay) / low (cosmetic)

E2.2 — opravit triviální per workflow. CodeQL může být CodeQL action v3→v4 migration regression (action just upgraded by dependabot #521). Go Services může být missing GO_VERSION pin. Dashboard Real-Backend potřebuje BFF running (operator-gated). GHCR push může být registry credential drift.

E2.3 — pro nontrivial: explicit defer s ticket created. Cíl není všechny opravit dnes, cíl je get baseline signal where possible + flag what needs operator/external help.

DoD sprintu E2: aspoň 2 z 4 workflows GREEN. Per-workflow triage report committed. Ostatní s ticket + defer rationale.

### Sprint E3 — D2.10 mailboxes sequential extract (2 sezení) {#sprint-e3}

Cíl je dokončit server.js mailboxes routes (35 inline) sequentially. Tento je největší zbývající D2 blok. Per dnešní lekce parallel agent work na server.js je ban.

E3.1 — split rozhodnutí. Agent inventarizuje 35 mailboxes routes a navrhne split na 2 batches:
- **Batch A — operational/admin** (mailbox CRUD, password set, score, status update) ~15 routes
- **Batch B — heal/diagnostic** (heal triggers, queue depth, circuit state) ~20 routes

Každý batch má vlastní contract tests + extraction PR.

E3.2 — Batch A extract. Agent moves 15 routes do nový file (extend `src/server-routes/mailboxes.js` nebo split na `mailboxes-admin.js`). Single commit, single PR. Contract tests preserve response shapes. **MUST NOT** add imports/mounts pro Batch B (dnešní D2.7 lekce).

E3.3 — verify Batch A merge před Batch B start. Wait for green CI + actual smoke test (`node --check features/platform/outreach-dashboard/server.js`).

E3.4 — Batch B extract. Same pattern but for heal/diagnostic routes. Final state: server.js mailboxes inline = 0.

DoD sprintu E3: 35 mailboxes routes wired through mounters, server.js -3000+ LoC, contract tests preserve shapes, 0 broken imports.

### Sprint E4 — Memory index + branch hygiene (1 sezení) {#sprint-e4}

Cíl je zavřít hygienic gaps detected by inventory.

E4.1 — fix MEMORY-INDEX.md `content-render` entry (5min). Edit `~/.claude/projects/.../memory/MEMORY-INDEX.md` a doplnit subsection pro `subsystem:content-render`. Test `pnpm test tests/audit/memory_tier_audit.test.mjs` musí pass. Memory file is outside repo — žádný PR, jen direct edit.

E4.2 — branch hygiene. 253 remote branches → goal <50. Operator-gated destructive op:
- Identify branches without open PR + last update >14d
- For each, classification: dependabot (auto-prune via `gh repo prune`), agent worktree (delete via `git push origin --delete`), feature/release (skip — operator review)
- Output report `reports/branch-cleanup-2026-05-03.md` s kandidáty
- Operator approves batches before delete

E4.3 — worktree prune. 24 worktrees, 16 locked. `git worktree list` + `git worktree remove <path>` for stale. Skip locked agent worktrees (může být active).

DoD sprintu E4: dashboard test green (memory_tier_audit pass), branches <50 remote, worktrees <15.

### Sprint E5 — Migration 048 apply (operator-gated) {#sprint-e5}

Cíl: aplikovat migration 048 (suppression UNION trigger) na outreach-db. Tento sprint je operator-driven, agent slouží jako pre/post verify.

E5.1 — pre-apply verify: `psql -c "SELECT count(*) FROM contacts WHERE status='suppressed'"` + `SELECT version FROM schema_migrations WHERE version='048_suppression_list_status_sync'`. Capture baseline.

E5.2 — operator runs `psql "$DATABASE_URL" -f scripts/migrations/048_suppression_list_status_sync.sql` (target: outreach-db only per memory `project_railway_db_scope`).

E5.3 — post-apply verify: trigger fungování (INSERT do `suppression_list` přes UI → SELECT na `contacts.status` = `suppressed`), `operator_audit_log` entry exists, schema_migrations row added.

E5.4 — closeout `reports/migration-048-applied-YYYY-MM-DD.md`.

DoD sprintu E5: trigger live na produkci, audit entry, no orphan inserts.

## Pořadí a paralelismus

Sprint E1 (P0 fix) je today/tomorrow first — jediný agent, single PR. Klíčové.

Sprint E2 (CI workflow triage) může běžet paralelně s E1 — different files, no conflict.

Sprint E3 (mailboxes) je sequential — ne dříve než E1+E2 jsou settled aby CI signal byl trustworthy. Batch A + Batch B sériově, ne paralelně.

Sprint E4 (memory + branches) je nezávislý na ostatních — kdykoli.

Sprint E5 (migration) je operator-gated — kdykoli operator schválí.

**KEY DISCIPLINE per dnešní incidenty:**
- Žádný parallel agent work na server.js ever again. Multi-domain server.js refaktorings sériově.
- Pre-push: `git diff origin/main --stat` MUST match intended scope, abort if not.
- Pre-merge: `node --check features/platform/outreach-dashboard/server.js` na fresh checkout aby caught broken imports.
- Cherry-pick from agent commit > 5 commits stale on main → use `git diff <sha>~..<sha> -- <pathspec> | git apply -` instead of full cherry-pick.

## Open questions

První otázka je rozsah E2 CI triage. CodeQL v3→v4 dependabot bump (#521) pravděpodobně rozbil CodeQL workflow — pokud yes, revert může být safest. Ale dependabot bumps také opravují security issues; revert znamená vrácení té díry. Need to verify CodeQL failure type (parsing error vs security finding vs config drift) před decision.

Druhá je segments routes — inventory v2 ukázal 5 inline segments routes. Mohou být wired nyní jako součást E3 prep nebo jako samostatný E3.0 micro-sprint. Operator decision.

Třetí je timing E5 migration. Pokud E1+E2 odhalí další latent bugs, je lepší aplikovat 048 trigger after stabilization. Pokud E1+E2 jsou rychlé, E5 může proběhnout ještě dnes.

## Cross-references

- [`docs/initiatives/2026-05-02-post-cleanup-hardening.md`](2026-05-02-post-cleanup-hardening.md) — paralelní hardening plan
- [`docs/initiatives/2026-05-03-launch-readiness-and-scaling.md`](2026-05-03-launch-readiness-and-scaling.md) — launch staircase L1-L4
- [`docs/initiatives/2026-05-03-deep-inventory-action-plan.md`](2026-05-03-deep-inventory-action-plan.md) — D-sprint plán (D1-D5 partially executed today)
- [`docs/audits/2026-05-03-server-js-d2-remainder.md`](../audits/2026-05-03-server-js-d2-remainder.md) — server.js inventory v2 (PR #670)
- [`docs/audits/2026-05-03-ratchet-inventory-v2.md`](../audits/2026-05-03-ratchet-inventory-v2.md) — ratchet state (PR #674)
- [`docs/audits/prod-health-2026-05-03-v2.md`](../audits/prod-health-2026-05-03-v2.md) — prod health (PR #672 renamed)
- [`docs/audits/backlog-inventory-2026-05-03.md`](../audits/backlog-inventory-2026-05-03.md) — backlog state (PR #673)
- [`docs/inventory-tests-2026-05-03-v2.md`](../inventory-tests-2026-05-03-v2.md) — test counts (PR #675)
- [`docs/inventory-prs-ci-2026-05-03-v2.md`](../inventory-prs-ci-2026-05-03-v2.md) — CI health (PR #672 renamed)
- Memory: `feedback_cherry_pick_stale_base_danger` (T1, key incident lesson today), `project_railway_db_scope` (T0), `project_bf_g_ops_tooling` (T1, slog conventions + sql.ErrNoRows pattern), `feedback_verify_filesystem_before_doc_claim` (T1)
