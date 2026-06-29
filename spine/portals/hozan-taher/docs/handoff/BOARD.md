# Handoff Board

**Protokol:** 3 branches (`main`, `wm/development`, `wm/tests`), 2 sibling worktrees, 2 Claude chaty.
Každý chat: start turn → `git fetch origin && cat docs/handoff/BOARD.md`. End turn → update svou sekci.

**Exception z "no direct push to main":** `docs/handoff/*.md` + `CLAUDE.md` doc-pointer edits (drobné chore, text-only, low-risk) lze pushnout přímo na main. Vše ostatní vždy PR.

**Worktree paths:**
- `/Users/messingtomas/Documents/Projekty/hozan-taher/` — main (read + BOARD edits)
- `/Users/messingtomas/Documents/Projekty/hozan-taher-dev/` — `wm/development` (Chat A)
- `/Users/messingtomas/Documents/Projekty/hozan-taher-tests/` — `wm/tests` (Chat B)

---

## Aktivní iniciativa: Kampaň výkupu techniky

**Spuštěno:** 2026-04-30
**Master plán:** [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-master.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md)
**30 sprintů celkem** rozdělených mezi 2 paralelní agenty:
- 15 sprintů Chat A (Build) — viz [A-build doc](../initiatives/2026-04-30-kampan-vykupu-techniky-A-build.md), GH issues #295-#309
- 15 sprintů Chat B (Quality) — viz [B-quality doc](../initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md), GH issues #310-#324

**Cíl:** Den 0 = první email odeslán. Den 30 = 1000+ kontaktů, 0 unaddressed CRITICAL/HIGH.

**Operátorské gates (musí Tomáš v Den 0):**
1. Založit 24 Seznam mailboxů + uložit app passwords v DB (sprint A4, issue #298) — fleet capacity 480/den (24 × 20/mailbox plateau), first-day batch 48 (24 × 2/mailbox per `vykup_24mb` warmup curve)
2. IČO 23219700 + sídlo do 3 šablon (sprint A2, issue #296)
3. Privacy URL live (garaaage.cz/privacy nebo GH Pages, issue #296)
4. Railway deploy + UNSUBSCRIBE_BASE_URL (sprint A3, issue #297)
5. Schválit landing pass start (10 PRs, sprint A1, issue #295)

---

## Active — wm/development (Chat A)

_Sekci edituje jen Chat A. Chat B je read-only pozorovatel._

**Aktuální stav:** Operátorská gate session pending — security PRs + KT-A3/A4

**Hotovo dnes 2026-04-30 (massive throughput — evening update):**

- **71+ commitů na main** (z 6 baseline = 12x)
- **KT-A2** templates IČO+sídlo (#335) + privacy URL public route (#339)
- **KT-A5** staircase send (in progress, agent)
- **KT-A8** block detection + healing log (#345 — 1642 řádků, 188+35 testů)
- **KT-A8.1** healing-log writer + recovery (in progress)
- **KT-A9** multi-source enrichment (#348 — 2168 řádků, 103 testů)
- **KT-A9.1** Pipeline.Enrich cutover (in progress)
- **KT-A10** refresh cron tuning (#344 — 1630 řádků, 48 testů)
- **KT-A13** ThreadDetail kontext (#347 — 763 řádků, 38 testů)
- **KT-A14** ML5.2 wire labhook + airtight gate (#326 — 57 testů)
- **KT-A15** multi-step sequences (#354 — 1189 řádků, 31+ testů)
- **KT-B1** BFF↔Go contract tests (#351 — 27 testů)
- **KT-B11** self-healing validation (in progress)
- **3 stack rescues** Mail Lab (#330) + Sprint+UX (#333) + KT-A14 (#326)
- **Operator scripts:** security-batch-merge.sh + pre-deploy-validate.sh
- **CI scope reduction** PR #337 (~43% méně cascading failures)
- **Merge tier policy** formalized v `docs/playbooks/merge-tier-policy.md`
- **Visual smoke 2x** verified — ZERO regression after merges
- **80+ orphan branches** deleted, 40+ superseded PRs closed
- **Mailboxes UI declutter** + **a11y gate ratchet** (in progress)

**Stále operátor-gated (tvoje session — nově ~15min místo 90min):**

1. **17 security PRs** — interaktivní batch-merge tool:
   ```bash
   bash scripts/operator/security-batch-merge.sh
   ```
   Per PR ukáže risk summary, ty stiskneš `y`/`n`/`d`/`q`. Audit zápis automatický. Review pack reference: `docs/audits/2026-04-30-security-pr-review-pack.md`.

2. **KT-A3** — Railway deploy + UNSUBSCRIBE_BASE_URL env (per `docs/playbooks/kt-a3-bff-deploy-checklist.md`)

3. **KT-A4** — 24-mailbox Seznam fleet passwords SQL UPDATE (per `docs/playbooks/kt-a4-mailbox-password-update.md`, real `pgp_sym_encrypt`, batch loop, `warmup_plan='vykup_24mb'`)

**Po dokončení gates:** KT-A5/A6 staircase 0→1→5→20 — autonomně.

- [ ] (Chat A vyplní co právě dělá)

**Hotovo 2026-04-30 evening (post audit consolidation):**

User direction "tohle řešíme pořád dokola, audit kódu zda neprogramuješ něco co už máme" spustil deep audit + 6 consolidation PRs:

- **Deep duplicate audit** (PR #403) napříč monorepo — 13 findings (4 CRITICAL, 3 HIGH, 3 MEDIUM, 3 LOW). Identifikoval že PR #393 (mé AT2.2) duplikoval `enforceAirtightGate` co už existoval v `cmd/outreach/main.go`.
- **Consolidation PR #404** — smazán dead `features/platform/common/token` package (-477 LoC, zero callers verified).
- **Consolidation PR #405** — slogop scanner extract (8 byte-identical scanners → 1 canonical helper, -488 LoC v test files).
- **Consolidation PR #406** — `envconfig.GetOr` + `envconfig.BoolOr` canonical (smazáno 7× envOr + 4× envBoolOr; sjednocen dialect `1|true|yes|on`).
- **Consolidation PR #407** — airtight boot gate unify (smazán `enforceAirtightGate`, single source `cfg.Validate()`, exit codes 47/48 jednotně, fixne `LAB_ONLY=yes` dialect mismatch).
- **Consolidation PR #408** — unsub-token canonical promote (5 callers refactored, byte-equivalence verified, **bonus: const-time security fix v BFF /unsubscribe** — naivní `===` → `crypto.timingSafeEqual`).
- **Consolidation PR #409** — suppression UNION canonical (Go `features/platform/common/sqlsuppression` + JS `suppressionUnionSql.js`, mechanical contract enforce přes `EnsureContainsBothTables` discipline).

**Memory rules added** (procedural gates proti opakovaní problému):
- `feedback_search_before_implement` — HARD RULE: před každou novou function/struct/test PROVÉST `mcp__claude-context__search_code` + `git grep`. Initiative dokumenty trust=0; vždy verify aktuální main.
- `feedback_spawn_first_solo_second` — procedural gate: před každým solo PR check "lze spawnnout 3 agenty teď?". Comfort bias prosazoval solo serial bez explicit gate.

**Outcome:** 0 CRITICAL/HIGH duplicates remaining. 26 PRs merged ~130 commits dnes (21× baseline). claude-context indexer reindexed pro fresh search-before-implement queries.

**Hotovo 2026-04-22 (Property-test expansion + HIGH fixes, autonomous):**

Property/fuzz testy:
- 132: privacy-gateway auth/sanitizer/mail — 30 property (security + format invariants). Commit: `1c7556c`
- 133: inbox/reply.Normalize — 6 new (nil-safe LLMClassifier, ErrEmptyReply). Commit: `6094ff9`
- 134: relay/pool.MixPool — 11 new (anonymity-set invariants). Commit: `6094ff9`
- 135: outreach/category path helpers — 16 new (firmy.cz tree). Commit: `733927a`
- 136: outreach/metrics escape/format — 15 new (Prometheus format-injection defense). Commit: `c4ffbd3`
- 137: outreach/config pure-fn — 15 new (DomainFromEmail, isSandboxHost, validateTrackingBaseURL). Commit: `f8f72cf`
- 140: outreach/sender backoff — 16 new (ClassifySMTPError + greylistingBackoff). Commit: `4e0fd53`

HIGH-severity fixes (z autonomního agent auditu):
- 138: sender.Engine.Run panic → ErrAntiTraceRequired (SMTP-EGRESS-LOCKDOWN R4 graceful). Commit: `5e7f947`
- 139: sender crypto/rand panics → log+fallback (generateMessageID + randomDelay). Commit: `06994ac`
- 146: imap/poller O(n²) response buffer → bytes.Buffer tail-scan 128B (200× rychleji pro 200KB bodies). Commit: `4cd2b2f`

Total: +109 property tests across 9 pkgs + 3 HIGH fixes. Agent-driven analýza (performance + tech-debt + coverage-gap) identifikovala další bottlenecks — viz #141-148 tasks.

**Hotovo tento týden (S2/S3 proxy resilience iniciativa):**
- 2026-04-21 — S2.1: proxy pool country filter 8 → 25 EU zemí. Commit: `d2660ea`
- 2026-04-21 — S2.2: periodic refresh ticker (5min) v RotatingProxyTransport — pool fresh nezávisle na DialContext traffic. Commit: `918f6e7`
- 2026-04-21 — S2.3: secondary proxy source (proxyscrape.com) + fetchProxyListMulti parallel fan-out s dedupe, partial-fail tolerant. Commit: `51df4d1`
- 2026-04-21 — S2.4: per-mailbox AUTH cache v assignBestProxy (TTL 30min, LRU 500). 1 AUTH probe místo N. Commit: `5b982fe`
- 2026-04-21 — S3.1: PoolHealthWidget na /mailboxes (CZ/Sousedi/EU/TLS yield/refresh age), color-coded (red=0, amber<5, yellow<15, green≥15). Commit: `b756afa`
- 2026-04-21 — S3.2: computeCampaignPreflight — 5 parallel DB checks pred unpause (proxy, full-check, suppression, capacity, templates). Commit: `d78a5cd`
- 2026-04-21 — S3.3: proxy_reassign_exhausted alert. `/api/health/proxy-exhaust` + pure aggregator (10min window, threshold≥2) + červený banner na /mailboxes. Commit: `ccbcc7b`
- 2026-04-21 — S3.4: empty-pool streak watchdog v relay. consecutiveZeroRefreshes (atomic.Int32), threshold≥3 = critical. /v1/proxy-pool response extended. Commit: `c111ef0`
- 2026-04-21 — S3.5: 24h pool trend sparkline. In-memory ring buffer (288 × 5min) + 5min ticker + `/api/proxy-pool-trend` + PoolTrendSparkline.jsx (SVG 240×36). Commit: `d56572d`
- 2026-04-21 — hygiena: onion.WaitReady raw time.Sleep → ctx-aware select. Poslední production raw-Sleep v relay uzavřený. Commit: `ae8b0e6`
- 2026-04-21 — T-U01: CampaignDetail run gate wiring `/api/campaigns/:id/preflight` — server 5-check list + Czech labels + reason, disable Spustit když ok=false, local 3-check fallback když BFF fail. Commit: `c821d26`

_Starší entries (anti-trace-relay foundations, proxy diagnostics, scoreLearner flake, 3-worktree bootstrap) — viz `git log --since=2026-04-20 --oneline origin/main` kde je kompletní historie._

### Backlog (bez sprintového slotu)

| # | Ticket | Popis | Zdroj |
|---|--------|-------|-------|
| — | Campaign EPIC B | Segment UI CRUD + `/segmenty` page | `FIRST-CAMPAIGN-SPRINTS.md` |
| — | Campaign EPIC C | Campaign UI (list + formulář + detail) | `FIRST-CAMPAIGN-SPRINTS.md` |
| — | Campaign EPIC D | Content library (3 šablony + spintax + LLM) | `FIRST-CAMPAIGN-SPRINTS.md` |
| — | Campaign EPIC E | Reply loop (leads + inbox + ThreadDetail) | `FIRST-CAMPAIGN-SPRINTS.md` |
| — | Campaign EPIC F | Pre-flight gate + dry-run + go-live runbook | `FIRST-CAMPAIGN-SPRINTS.md` |
| — | /scoring expand E2E | Deeper scoring page E2E coverage | `plan-v2.md carryover` |
| — | /analytics E2E | Analytics page E2E coverage | `plan-v2.md carryover` |
| — | Multi-region proxy rotation | Sprint 6 follow-up | `plan-v2.md` |
| — | GDPR export tooling | Sprint 6 follow-up | `plan-v2.md` |

_Campaign EPICs B–F závisí na EPIC A (#156+#157). Celkem 104 nových testů. Spec: `docs/playbooks/FIRST-CAMPAIGN-SPRINTS.md`._
_tdd-tasks.md (T-0015+) obsahuje MVP-02–08 task registry — CampaignNew wizard, segment picker, sequence builder atd. (generováno 2026-04-21, částečně obsolete — verifikovat před prací)._

---

### BFF contract spec (pro #143, #144, #145)

**Vzor psaní** (`bff-health.contract.test.ts`, 232 řádků):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../../../db.js', () => ({ pool: { query: vi.fn() } }))
// setup mock responses → test shape + boundary + error path
```
Spustit: `cd features/platform/outreach-dashboard && pnpm vitest run test/contract/<soubor>`

**#143 — `/api/analytics/*`** (`server.js:5296–5360`)
- `GET /overview` → `{total_sent, total_replied, total_opened, total_bounced, sent_7d, replied_7d, active_campaigns}` (všechna int)
- `GET /timeline?days=N` → array `{day:'YYYY-MM-DD', sent, replied, opened}`, clamp 1–90 default 30, zero-fill
- `GET /campaigns` → array `{id,name,status,sent,replied,opened,bounced,first_sent,last_sent}` LIMIT 30
- Testovat: types, days boundary (0→1, 100→90), empty DB zeros, 500 path

**#144 — `/api/diagnostics/*` + `/api/dns-audit`** (`server.js:932`, `server.js:2294`)
- `GET /diagnostics/segmentation` + `GET /diagnostics/feature-lift` → číst server.js:932/954 pro shape
- `GET /dns-audit` → `{status:'ok'|'warn'|'err', latency_ms, domains:{<d>:{spf_status,spf_detail,dmarc_status,dmarc_detail}}}`
- Edge: no mailboxes → `{status:'skip', detail:'no sending domains configured', domains:{}}`
- Mock `node:dns/promises` resolveTxt

**#145 — `/api/healing/*` + `/api/health/drift` + `/api/protections/*`** (`server.js:5265`, `2334`, `2522`)
- `GET /healing/log?limit=N` → `{events:[{id,entity_type,entity_id,entity_label,action,reason,resolved_at,created_at}], total}` clamp 1–200
- `GET /healing/stats` → `{by_action:[{action,cnt,last_at}], today:int}` (7-day window)
- `GET /health/drift` → cached (5min TTL) `runConfigDrift` result; mock helper
- `GET /protections/matrix` → 12×2 cells z `protection_probes`
- `GET /protections/alerts` → `[{id,layer,message,severity,acked_at,created_at}]`
- `PATCH /protections/alerts/:id/ack` → 200 nebo 404
- `GET /protections/coverage` → `{coverage_pct, total_sends, covered_sends}`

---

**Hotovo 2026-04-23 (tato session):**
- #142 ✅ `1044242`: relay/fragment property (17) + relay/intake property (9)
- #147 ✅ `bbe8d6d`: N+1 email verify → batch saves 200× méně round-trips
- #148 ✅ `fa8b889`: sender/engine.go 9 unbounded maps — hourly reset + prune loop (+7 tests)
- #143 ✅ `bff-analytics.contract.test.ts` (13 tests)
- #144 ✅ `bff-diagnostics.contract.test.ts` (14 tests)
- #145 ✅ `bff-healing-protections.contract.test.ts` (21 tests)
- Sentry Sprint A–E ✅ `b07d745`→`901fa4b`: capture500 (97 catch blocks), source maps, HTTPRecoveryMiddleware, FatalExitFn, RouteErrorBoundary, fetchWithSentry, monkey tests (26), CI release tracking
- #149 ✅ `13fb140`: CampaignNew wizard E2E (5 specs, page.route mocks)
- #150 ✅ `13fb140`: scoring property tests (42 — sum=100, bounds, determinism)
- #159 ✅ `13fb140`: privacy-gateway property tests (+52: sanitizer + resolver)
- #151 ✅ `97fa997`: MCP auth unit tests (17 new — createMemoryStore, createAuthProvider)
- #152 ✅ `97fa997`: worker shutdown unit tests (12 new — runShutdown, installProcessHandlers, maybeShortCircuit)
- #153 ✅ `97fa997`: scrapers better-sqlite3 rebuild → 546/546 pass
- #84 ✅ `f72c9b5`+`8a4d09c`: M2.2+M2.3+M2.4+M2.5 relay reorg (842 tests preserved)
- #158 ✅ `bbd38ba`: ADR-001 @hozan/dashboard-core design
- #156 ✅ already done (campaign scheduler existing in modules/outreach/campaign/)
- #157 ✅ already done (EmailStatusAllowed gate in campaign/gate.go)
- #155 ✅ `fb74c22`: warmup LimitForDay+IsComplete property tests (13 new)
- M6.2 ✅ `7db2714`: @hozan/dashboard-core scaffold (re-export barrels)
- #161 ✅ `2eddc4f`: M7.1 cmd/outreach → features/inbound/orchestrator/ (build+smoke test pass)
- #160 ✅ `0ba2fb2`: railway.toml pro mcp/worker/scrapers/orchestrator (8 services celkem)
- #155 ✅ `fb74c22`: warmup LimitForDay+IsComplete property tests (13)
- M7.2 ✅ `ba6ee77`→`6bc7026`→`93134e5`→`7d8bc36`→`460e201`→`7732174`→`5053900`→`20cccbd`: 33 pkgs redistribuovány (humanize→common, classify/exclusion→contacts, sender→campaigns, intelligence→orchestrator, config/metrics/health/db/alert/audit/calendar/token→common, content/warmup→campaigns, ares/category/company/validation→contacts, campaign/honeypot/imap/llm/mailsim/protections/thread/web→orchestrator)
- M7.3 ✅ `993f215`: modules/outreach/ smazán, go.work aktualizován, deps opraveny (sentry-go, x/net, anthropic-sdk)
- Sentry Deep Integration ✅ `7e128e2`: breadcrumbs (DB/auth/nav), user context X-API-Key, SentryRouteTracker, SetServiceTag, Go MonitoredJob cron, CI deployment+PR comment, 25+20+9 nových testů
- Dashboard monkey tests ✅ `540dffb`: 34 BFF boundary+malformed input tests
- common/db coverage ✅ `c8efe2b`: 91.8% (+Migrate monkey)
- common/telemetry coverage ✅ `32e44b6`: 87.0% (+SlogHandler/Flush/FatalExitFn/Recovery)
- orchestrator monkey tests ✅ `7e128e2`: imap/intelligence/llm/protections/web monkey testy
- G1–G3 in progress: MonitoredJob cron, fingerprinting, CI path trigger fix

_Starší hotová práce — viz `git log --since=2026-04-20 --oneline origin/main`._

**Blocked:**
- 24-mailbox Seznam fleet (KT-A4 scope): operator založí účty + uloží 24 app passwords v DB. Aktuálně testovací mailboxes (mb=631/632/1/3) drží placeholder `123p123p123p123` → AUTH `535 5.7.8 incorrect credentials` → assign-proxy vrací 503. Strategie 2026-04-30: scope rozšířen z 2 na 24 schránek, capacity target 480/den (24 × 20/mailbox plateau).
- kampaň #1 "Strojírenství — první kontakt" unpause: blokováno na 24-mailbox fleet outage výše.

---

## Active — wm/tests (Chat B)

_Sekci edituje jen Chat B. Chat A je read-only pozorovatel._

- [ ] (zatím nic)

**Hotovo tento týden:**
- (žádné)

**Blocked:**
- (žádné)

---

## Cross-branch signals

_Krátké zprávy mezi chatty. Mažou se po přečtení + reakci. Max 10 aktivních._

- [A→B] 2026-04-21 `features/outreach/relay/cmd/relay/main.go` — WithProxyPool wiring. Integration test: fresh relay boot → `GET /v1/proxy-pool` returns non-nil snapshot when RotatingProxyTransport present. Commit: `9717efd`.
- [A→B] 2026-04-21 `features/platform/outreach-dashboard/server.js` — `summarizeAttempts` + `classifyProbeReason` + 503 response shape `{tried, summary, attempts}`. Unit test na klasifikaci (`535 5.7.8` → `auth_invalid`, `i/o timeout` → `timeout`, `tls handshake failure` → `tls_fail`) + integration 503 body shape. Commit: `3844676`.
- [A→B] 2026-04-21 `features/outreach/relay/internal/transport/proxy_pool.go:fetchProxyListMulti` — multi-source fan-out. Property test na malformed proxyscrape body (premium-gate HTML), fuzz na geonode JSON schema drift, check že "one source yields 0 addrs" nestačí pro empty pool. Commit: `51df4d1`.
- [A→B] 2026-04-21 `features/platform/outreach-dashboard/authCache.js` + `server.js:assignBestProxy` — per-mailbox AUTH cache. Integration: (1) druhé volání = `tried==1` (cache hit), (2) proxy evict = fallback do fan-out, (3) TTL expiry → znovu probe N. Commit: `5b982fe`.
- [A→B] 2026-04-21 `features/platform/outreach-dashboard/src/components/PoolHealthWidget.jsx` — Playwright visual regression v každém ze 4 health states + a11y contrast. Commit: `b756afa`.
- [A→B] 2026-04-21 `features/platform/outreach-dashboard/server.js:/api/health/proxy-exhaust` + aggregateProxyExhaust — integration: seed watchdog_events, testovat 5 scénářů (0/1/3 rows, >10min stale, missing table). Commit: `ccbcc7b`.
- [A→B] 2026-04-21 `features/outreach/relay/internal/httpapi/probe.go:handleProxyPool` — response rozšířen o `consecutive_zero_refreshes` + `empty_pool_critical`. Fake ProxyPool s PoolSnapshot.ConsecutiveZeroRefreshes=3 → response.empty_pool_critical == true. Commit: `c111ef0`.
- [A→B] 2026-04-21 `features/platform/outreach-dashboard/poolTrend.js` + `/api/proxy-pool-trend` + PoolTrendSparkline.jsx — integration: 2-tick append (mock 5-min timer), contract na samples[].ts ISO8601 + stats shape, Playwright screenshot 3 stavů. Commit: `d56572d`.
- [A→B] 2026-04-21 `features/platform/outreach-dashboard/src/pages/CampaignDetail.jsx` — preflight wiring do run gate. Integration test: (1) server ok=true renderuje 5 zelených řádků, (2) ok=false s `proxy_assignments.ok=false` disable-uje Spustit + skrývá quality, (3) BFF 500/error → fallback na lokální 3-check. Commit: `c821d26`.

---

## Konvence commit trailers

```
Needs-Tests: <modul> <popis>           # A→B: signál že nová funkcionalita potřebuje pokrytí
Blocks-On: <PR#> | BOARD:<section>      # závislost — neblokuj merge dokud není vyřešeno
Breaks-Contract: <api|event|schema>     # A→B: změna kontraktu, B musí upravit kontrakt testy
Covers: #<PR>                           # B→A: testy pokrývající konkrétní PR
Resolves-Trailer: Needs-Tests: <modul>  # B→A: resolved A-side signál
```

Chat B grepuje `Needs-Tests:` v `git log origin/main` → backlog.

**Priorita signálů pro Chat B:** PR body (in-flight) > merged trailer (historický) > BOARD (kurátovaný).

---

## Projekt-specifické workflow

**Test stack:**
- Go unit/integration: `cd modules/outreach && go test ./... -race`
- React unit (vitest): `cd features/platform/outreach-dashboard && pnpm test`
- E2E (Playwright): `cd features/platform/outreach-dashboard && pnpm e2e`
- BFF contract: `cd features/platform/outreach-dashboard && pnpm vitest run test/contract/`

**Services při vývoji:**
- Go outreach backend: `:8080` (DB: Railway PostgreSQL, DSN z `OUTREACH_DATABASE_URL`)
- Express BFF: `:3100` (proxies to Go via `GO_SERVER_URL` + `X-API-Key`)
- Vite dev: `:5175` (React 19 app, připojuje se na BFF)

**Merge konvence:**
- PR-only na `main` (pre-push hook blokuje direct push mimo BOARD exception)
- Squash-merge (čistá historie)
- Po squash-merge vlastního PR: `git fetch && git rebase origin/main && git push --force-with-lease`

---

**Last sync:** 2026-04-22 (Property-test expansion +93 testů v 8 pkgs; dashboard 1727 vitest green; Go modules 2676 pass ve 33 pkgs)
