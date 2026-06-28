# Kampaň výkupu techniky — Chat A (Build/Dev) sprint plan

**Status:** active (draft → schválení)
**Created:** 2026-04-30
**Owner:** Chat A — `wm/development` worktree (`/Users/messingtomas/Documents/Projekty/hozan-taher-dev/`)
**Cross-link:** [Master](2026-04-30-kampan-vykupu-techniky-master.md) · [Chat B Quality](2026-04-30-kampan-vykupu-techniky-B-quality.md)

15 sprintů přiřazených Chatu A z 30-sprint master plánu.

## Cíl Chatu A (rolling)

| D+ | Acceptance | Sprint |
|---|---|---|
| D+0 | Kampaň "Výkup techniky 001" status=running, 24 mailboxů × 2 = 48 enrolled (day-1 batch), ≥1 send_event status='sent', anti-trace-relay v cestě | KT-A5 |
| D+3 | 24-mailbox fleet day-3 milestone: ≥95% delivered, ≤5% bounce, žádný kritický mailbox_alert open, warmup curve postoupila na den 4 (5/mailbox = 120/den) | KT-A6 |
| D+14 | Scraper přežije simulovaný block — auto-failover ARES → firmy.cz bez manual zásahu, evidence v healing_log | KT-A8 |
| D+21 | UI evolution dokončena, operator daily flow ≤15min na 25 replies, CampaignDetail rozdělen do 4 tabů | KT-A11–A13 |
| D+30 | ML5.2 engine wired za LAB_ONLY=1 boot gate, followup1+final v sequence_config, 10 CRITICAL/HIGH PRs merged | KT-A14, KT-A15, KT-A1 |

## Scope vs non-scope

**In scope:** production hot-path code (sender, runner, scheduler), real-time scraping resilience, UI evolution, ML5.2 wiring + LAB_ONLY boot gate, multi-step sequence wiring.

**Non-scope:** E2E + integration + property/mutation/load testy (Chat B), reply triage validation (Chat B KT-B2-B6), Mail Lab + Operator Practice merge work (Chat B), GDPR DSR audit (Chat B KT-B11), multi-region deploy.

## Architektura — co se mění per area

### Campaigns hot-path (`features/outreach/campaigns/`)
- KT-A1 lands deferred sec/correctness fixes (10 PRs).
- KT-A15 přidává sequence_config orchestration v `features/outreach/campaigns/campaign/runner.go` (after-step delay → enqueue followup1 → final).

### Scrapers + relay (`features/outreach/relay/`, `features/acquisition/scrapers/`, `features/acquisition/contacts/`)
- KT-A7: rozšíření `features/outreach/relay/internal/transport/proxy_pool.go` — per-source health gating + persistence.
- KT-A8: nový `features/acquisition/scrapers/src/util/block-detector.ts` + integration do `scrape-worker.ts`.
- KT-A9: `features/acquisition/contacts/enrichment/` — interface `EnrichmentSource`, ARES + FirmyCZ + JusticeCZ + weighted merge.
- KT-A10: cron tuning — per-source backoff cap.

### BFF + UI (`features/platform/outreach-dashboard/`)
- KT-A3: deploy artefakt + `UNSUBSCRIBE_BASE_URL` env.
- KT-A11: CampaignDetail.jsx (741 LOC) → 4 sub-komponenty (Overview/Sends/Replies/Issues).
- KT-A12: lands UX-F1..F14 (#117-#132).
- KT-A13: Replies + Dashboard widgets per `2026-04-28-operator-flow-architecture.md`.
- KT-A14: nový boot gate v `server.js` + `features/inbound/orchestrator/cmd/outreach/main.go` (`LAB_ONLY=1` → exit 78 na non-lab DSN).

## 15 sprintů — detail

### KT-A1 — Land 10 CRITICAL/HIGH fixes

**Goal:** Smířit deferred sec/correctness queue. PRs #161, #162, #166, #169-#175, #183.

**Acceptance:**
- [ ] Všech 10 PR merged do main (squash, hooks zelené)
- [ ] `gh pr checks` zelené per PR
- [ ] Žádný regression v `pnpm report`
- [ ] BOARD update s commit hashes
- [ ] Žádný open `Needs-Tests:` trailer bez B-side `Resolves-Trailer`

**Dependencies:** žádné (gating prerequisite).
**Days:** 1.
**Risk:** Konflikty mezi PRs → mitigation: PR #161 first, ostatní rebase nad ním.

### KT-A2 — Operator data fill (IČO/sídlo) + privacy.html publish

**Goal:** Doplnit `{{IČO_PLACEHOLDER}}` + `{{SÍDLO_PLACEHOLDER}}` v 3 šablonách + zveřejnit privacy URL.

**Acceptance:**
- [ ] `features/outreach/campaigns/configs/templates/{initial,followup1,final}.tmpl` IČO=23219700, Sídlo=Purkyňova 74/2 110 00 Praha 1
- [ ] `docs/legal/{lia-direct-marketing,art30-register,privacy-notice,privacy-policy}.md` zkontrolovány
- [ ] privacy URL live (`curl -sI` 200)
- [ ] Render-test reprodukuje footer bez `_PLACEHOLDER`

**Dependencies:** Operator-supplied gate.
**Days:** 0.5 (operator-bounded).
**Risk:** Czech diakritika v sed → použít Edit tool s exact-match.

### KT-A3 — BFF deploy + `UNSUBSCRIBE_BASE_URL`

**Goal:** Express BFF + Go orchestrator + relay deployed na Railway, `UNSUBSCRIBE_BASE_URL` set.

**Acceptance:**
- [ ] `curl -sI ${BFF_URL}/health` → 200
- [ ] `curl -sf ${BFF_URL}/unsubscribe?token=<test>` → HTML s "byli jste odhlášeni"
- [ ] `features/outreach/campaigns/campaign/runner.go:817` ENV resolution prochází
- [ ] `${ANTI_TRACE_URL}/health` 200
- [ ] `railway.toml` všech 8 services aligned

**Dependencies:** KT-A1 merged, KT-A2 placeholders filled.
**Days:** 0.5.

### KT-A4 — Mailbox passwords v DB (24-mailbox Seznam fleet)

**Goal:** Operator-only step. Seznam app passwords pro **všech 24 mailboxů** (placeholder names — operator založí, ID range vyplyne z `INSERT` order) do `outreach_mailboxes.password` (nebo `password_encrypted` pokud je `MAILBOX_SECRET_KEY` set).

**Acceptance:**
- [ ] `SELECT count(*) FROM outreach_mailboxes WHERE status='active' AND length(password) > 0` ≥ 24 (assumes operator inserted 24 rows)
- [ ] Per-mailbox AUTH probe `{"ok": true}` přes anti-trace-relay (24 zelených)
- [ ] Žádný password v env/git/Slack/log
- [ ] BFF `POST /api/mailboxes/<id>/send-test` → 200 pro každý ze 24

**Dependencies:** Pure operator gate. Chat A blocked. Per `feedback_mailbox_passwords_via_db` HARD RULE — Claude REFUSE direct SQL touch. Use playbook `docs/playbooks/kt-a4-mailbox-password-update.md` batch loop pattern.
**Days:** operator (~30 min batch) + 0.5 verification.

### KT-A5 — Pre-flight + dry-run + send-test + 0→1→48 staircase

**Goal:** Provede staircase per `docs/playbooks/first-campaign-launch.md` až do day-1 batch (24 mailboxů × 2 = 48 mailů).

**Acceptance:**
- [ ] Step 0 dry-run: `[dry_run]` per recipient, žádný `send_events` row
- [ ] Step 1: 1 email doručen z 1 mailboxu, DKIM/SPF pass, unsub funguje
- [ ] Step 2: 24 contacts (1/mailbox), 100% delivery, 0 bounce, sanity send-test cross-fleet
- [ ] Step 3 (day-1 batch): 48 contacts (2/mailbox per `vykup_24mb` warmup day 1), ≥95% delivery, ≤5% bounce
- [ ] `features/platform/outreach-dashboard/campaignPreflight.js` 5-check ok=true
- [ ] Operator sign-off v BOARD

**Dependencies:** KT-A1, A2, A3, A4 ALL green.
**Days:** 1.
**Risk:** Step 1 spam → stop, fix DKIM/SPF. Step 2 cross-fleet variance (1 mailbox bounces) → pause that mailbox, continue ramp on rest.

### KT-A6 — 2→20/mailbox staircase + 24h monitoring

**Goal:** Sleduje warmup ramp per `vykup_24mb` plán: day 1=2/mb, day 4=5/mb, day 8=10/mb, day 15=20/mb. 24h watch per LAUNCH-CAMPAIGN-001.md.

**Acceptance:**
- [ ] Day 1: 48 send_events (24 × 2), ≥95% sent, ≤5% bounced
- [ ] Day 4 ramp: 120/den (24 × 5), ≥95% sent
- [ ] Day 8 ramp: 240/den (24 × 10), ≥95% sent
- [ ] Day 15+ plateau: 480/den (24 × 20) max
- [ ] Reply rate ≥0.5% kumulativně
- [ ] Žádný `mailbox_alerts.severity='critical'` 24h pro libovolný z 24 mailboxů
- [ ] Bounce-throttle cron BF-A4 nezahájil auto-pause
- [ ] A→B signal: `kampaň výkupu active — start KT-B1`

**Dependencies:** KT-A5 step 3 GREEN.
**Days:** 2 (1 ramp validation + 24h passive). Plný ramp na 480/den dosažen ~day 15.

### KT-A7 — Scraper resilience: proxy rotation infrastructure

**Goal:** Proxy pool přežije skon jednoho zdroje (proxyscrape, geonode, secondary).

**Acceptance:**
- [ ] `features/outreach/relay/internal/transport/proxy_pool.go` má `SourceHealth` rolling success rate
- [ ] `RotatingProxyTransport` skipuje source kde success_rate < 0.3 po 10 attempts (cooldown 5min)
- [ ] `proxy_source_health.go` rozšířen o MarkSuccess/MarkFailure + persisted snapshot
- [ ] Empty-pool watchdog (BOARD S3.4) reaguje na `consecutive_zero_refreshes >= 3`
- [ ] Test coverage ≥90% per source health logic, race-clean

**Atomic units:**
- A7.1 Edit proxy_pool.go health-aware ordering
- A7.2 Property test 100 fetch cycles s 1 broken source
- A7.3 Update `proxy_pool_multi_test.go` failure injection
- A7.4 Trailer `Needs-Tests: relay/proxy_source_health chaos` → KT-B15

**Brutal asserts target:** ≥10 (3 sources, 1 broken, fan-out yields ≥1 proxy, broken source skipped after threshold, cooldown reset, success_rate persisted, snapshot JSON stable, no nil deref, atomic counters, op tag).

**Dependencies:** KT-A1.
**Days:** 2.

### KT-A8 — Block detection + auto-failover

**Goal:** Scraper detekuje block (HTTP 4xx/5xx pattern, captcha) a failnover na alternativní source/proxy.

**Acceptance:**
- [ ] `features/acquisition/scrapers/src/util/block-detector.ts` exporting `detectBlock(response)` s typy `'rate_limit' | 'captcha' | 'cloudflare' | 'forbidden' | null`
- [ ] `scrape-worker.ts` na block detection emituje `healing_log` + retry s alt source
- [ ] Test 20 fixtures per typ (real HTTP captures stripped)
- [ ] Auto-failover ARES → firmy.cz orchestrated v `features/acquisition/contacts/enrichment/pipeline_e2e_test.go`
- [ ] Vždy `audit_log` row, žádný silent retry

**Brutal asserts target:** ≥10 (4 block types, captcha by body containsAny `g-recaptcha|h-captcha`, Cloudflare by `cf-ray`, 429 → backoff Retry-After, 403 → switch source, 503 → exponential, healing_log per block, retry counter capped).

**Dependencies:** KT-A7.
**Days:** 2.
**Risk:** Body detection brittle → header-first, body-second, log on uncertain.

### KT-A9 — Multi-source enrichment (ARES + firmy.cz + alternatives)

**Goal:** `features/acquisition/contacts/enrichment/` má `EnrichmentSource` interface a 3 implementace s weighted merge.

**Acceptance:**
- [ ] Interface `EnrichmentSource { Lookup(ico) (*Company, error); Health() float64; Name() string }`
- [ ] Impl: `ARESSource`, `FirmyCZSource`, `JusticeCZSource`
- [ ] Pipeline merger: per-field priority (ARES authoritative pro IČO/sídlo, firmy.cz pro NACE/employees, fallback chain)
- [ ] On primary block (KT-A8), retry secondary, audit `enrichment_source_used`
- [ ] Test coverage ≥85% s real fixtures (anonymized per `feedback_no_fabricated_test_data`)

**Dependencies:** KT-A7, KT-A8.
**Days:** 2.

### KT-A10 — Refresh cron frequency tuning (real-time pull cadence)

**Goal:** Refresh job intervaly tuned na real-time potřeby; per-source backoff respektován.

**Acceptance:**
- [ ] Per-source cadence configurable: `ARES_REFRESH_INTERVAL`, `FIRMYCZ_REFRESH_INTERVAL`
- [ ] Backoff multiplier 1.5x per consecutive failure, cap 4h
- [ ] `MonitoredJob` integration — každý cron emituje breadcrumb
- [ ] No overlap (advisory lock per cron)
- [ ] Prague TZ respected, last_run timestamp persisted

**Dependencies:** KT-A9.
**Days:** 1.

### KT-A11 — UI campaign lifecycle (preflight gate, monitoring, archive)

**Goal:** CampaignDetail rozdělen do 4 tabů per `2026-04-28-operator-flow-architecture.md` S3.

**Acceptance:**
- [ ] CampaignDetail.jsx split do `CampaignOverview/Sends/Replies/Issues.jsx` (každý ≤200 LOC)
- [ ] Default tab=Overview, badges na Replies (unhandled count) + Issues (alerts count)
- [ ] Issues tab existuje jen když count > 0
- [ ] Preflight 5-check rendered, červený řádek pokud ok=false, blokuje Run
- [ ] Archive button + `POST /api/campaigns/:id/archive`

**Dependencies:** KT-A1, KT-A6 (campaign actually running).
**Days:** 3.

### KT-A12 — UI companies + leads + segments redesign land (UX-F1..F14)

**Goal:** Stack PRs #117-#132 merged. Companies má "Spustit kampaň pro tento filter →", Segments má "Použít v kampani →".

**Acceptance:**
- [ ] Companies.jsx toolbar button → `/campaigns?new=1&filter=...`
- [ ] CampaignNew.jsx step 1 detect `?filter=` → prefill segment
- [ ] Segments.jsx row button → `/campaigns?new=1&segment=<id>`
- [ ] Leads skrytý ze sidebaru (Cmd+K access)
- [ ] LOC budget: Mailboxes <800, CampaignDetail <500, Companies <1000

**Atomic units:**
- A12.1 `gh pr list --label ux-f` → 14 PRs ranked by dependency
- A12.2 Stack rebase přes `scripts/ops/rebase-stack.sh`
- A12.3 Per-PR merge sequentially, BOARD update
- A12.4 Trailer `Needs-Tests: Companies/Segments cross-link Playwright` → KT-B14

**Dependencies:** KT-A11.
**Days:** 3.
**Risk:** 14-PR stack conflicts → rebase-stack.sh + sequential single-merge.

### KT-A13 — UI operator daily flow (replies + dashboard widgets)

**Goal:** ThreadDetail má campaign context box + akce. Dashboard widgets mají drill-in.

**Acceptance:**
- [ ] ThreadDetail.jsx header zobrazí "Z kampaně: <name>" + odkaz na CampaignDetail
- [ ] `GET /api/replies/:id/context` → `{campaign, original_message, contact}`
- [ ] Akce buttons: `[Zájem] [Není zájem] [Otázka] [Unsubscribe] [Vyřízeno]`
- [ ] Unsubscribe button INSERT do `suppression_list` (UNION respect)
- [ ] Dashboard widgets drill-in: "X nových" → `/replies?filter=unhandled`, "Y schránek problém" → `/mailboxes?filter=health=warn,err`

**Dependencies:** KT-A11, KT-A12.
**Days:** 2.

### KT-A14 — ML5.2 engine wiring + LAB_ONLY=1 airtight boot gate

**Goal:** Wire ML5.2 engine za boot gate. Pokud `LAB_ONLY=1` AND prod-side credentials → exit 78.

**Acceptance:**
- [ ] `features/inbound/orchestrator/cmd/outreach/main.go` boot-gate: `LAB_ONLY=1` AND DSN matches non-lab pattern → exit 78
- [ ] `features/platform/outreach-dashboard/server.js` symetrický gate
- [ ] ML5.2 module wired (file path TBD per AT2.x)
- [ ] Gate dokumentován v `docs/handoff/bootstrap-dev.md`
- [ ] Test: spawn process s `LAB_ONLY=1 OUTREACH_DATABASE_URL=postgres://prod-host` → exit 78 do 1s

**Brutal asserts target:** ≥10 (exit 78 on prod DSN, exit 0 on lab DSN, lab allowlist respected, no env leak, gate before DB connection, before sender start, before classifier load, panic-handler suppresses stack, audit_log row before exit, telemetry breadcrumb).

**Dependencies:** KT-A1 (#161). Soft dep on `2026-04-30-airtight-dev-env.md`.
**Days:** 2.

### KT-A15 — Followup1.tmpl + final.tmpl + multi-step sequences

**Goal:** Wire `followup1.tmpl` + `final.tmpl` do sequence_config. Initial → +7d followup1 → +14d final.

**Acceptance:**
- [ ] `runner.go` respektuje `sequence_config.steps`
- [ ] Migration: `ALTER TABLE campaigns ADD COLUMN sequence_config JSONB DEFAULT '{"steps":[{"template":"initial","delay_days":0},{"template":"followup1","delay_days":7},{"template":"final","delay_days":14}]}'`
- [ ] `current_step` advances correctly, per-contact dedup
- [ ] Suppression on `negative` reply během followup pause stops next step
- [ ] Test coverage: 3-step happy path, mid-step suppression, mid-step pause, schedule overlap

**Dependencies:** KT-A6, KT-A11.
**Days:** 2.
**Risk:** Reply during pause → step still fires → re-check suppression UNION před each step enqueue.

## Bootstrap protocol pro Chat A

`docs/handoff/bootstrap-dev.md` musí (po Start turn):

1. Read order: master → A-build → BOARD "Active — wm/development" → "Cross-branch signals"
2. Diagnostic: `cd features/platform/outreach-dashboard && pnpm report` zelený před open new PR
3. Sprint cursor: aktuální KT-A<N> v BOARD "Active". Po dokončení → trailer `Cross-Initiative: KT-A<N> done`
4. Operator gates (KT-A2, A4): Chat A REFUSE direct credentials/SQL touch, message operator s exact SQL
5. End turn: BOARD update + Cross-branch signals pokud A→B signál

## Cross-branch signály (A→B)

| Sprint | Signal | B-side reaction |
|---|---|---|
| KT-A6 | `[A→B] kampaň 455 active, 20 sends — start KT-B1` | KT-B1 (reply IMAP poll verification) |
| KT-A7-A9 | `Needs-Tests: scraper chaos scenarios` | KT-B15 |
| KT-A11-A13 | `Needs-Tests: UI navigation E2E` | KT-B14 |
| KT-A14 | `Needs-Tests: LAB_ONLY adversarial` | KT-B7 |
| KT-A15 | `Needs-Tests: multi-step sequence + suppression-mid-flow` | KT-B7/B8 |

## Open questions / gates pro operátora

| # | Question | Blokuje | Default |
|---|---|---|---|
| 1 | Privacy URL host (garaaage.cz vs GH Pages) | KT-A2 | garaaage.cz/privacy preferred |
| 2 | Railway region (EU/non-EU) | KT-A3, scc-railway | EU preferred |
| 3 | Mailbox app passwords mb=631+632 | KT-A4 | operator-only |
| 4 | Source segment "výkup techniky" — same jako machinery? | KT-A5 | reuse machinery (campaign 455) |
| 5 | `2026-04-30-airtight-dev-env.md` doc author | KT-A14 | Chat A může napsat stub; ML5.2 deferable |
| 6 | UX-F1..F14 PRs ready (#117-#132)? | KT-A12 | per master 130+ PRs |
| 7 | sequence_config schema location | KT-A15 | jsonb default |

## Reference

- [Master](2026-04-30-kampan-vykupu-techniky-master.md)
- [Sourozenec](2026-04-30-kampan-vykupu-techniky-B-quality.md)
- [Garaaage launch v4](2026-04-25-garaaage-launch-plan-v4.md) — predecessor S2-S6
- [Operator flow architecture](2026-04-28-operator-flow-architecture.md) — UX
- [LAUNCH-CAMPAIGN-001](../playbooks/LAUNCH-CAMPAIGN-001.md) — soft launch runbook
- [first-campaign-launch](../playbooks/first-campaign-launch.md) — generic 0→1→5→20→full
- [bootstrap-dev](../handoff/bootstrap-dev.md), [BOARD](../handoff/BOARD.md)

### Cited memory rules
`feedback_campaign_send`, `feedback_no_direct_smtp`, `feedback_no_direct_transport`, `feedback_mailbox_passwords_via_db`, `feedback_extreme_testing`, `feedback_no_external_services`, `feedback_no_speculation`, `project_b2b_transport_mode`, `project_seznam_proxy_geo_mismatch`, `project_two_suppression_tables`.

### Cited code paths
- `features/outreach/campaigns/configs/templates/initial.tmpl:24-25` — IČO/sídlo placeholders
- `features/outreach/campaigns/campaign/runner.go:817` — `UNSUBSCRIBE_BASE_URL` env
- `features/platform/outreach-dashboard/campaignPreflight.js` — 5-check UNION
- `features/platform/outreach-dashboard/server.js:390` — `_dsrAllow` rate-limit
- `features/outreach/relay/internal/transport/proxy_pool.go` — pool core
- `features/outreach/relay/internal/transport/proxy_source_health.go` — health (KT-A7 extend)
- `features/acquisition/scrapers/src/queue/scrape-worker.ts` — wire point (KT-A8)
- `features/acquisition/contacts/ares/sync.go` — ARES (KT-A9 refactor target)
- `features/acquisition/contacts/enrichment/pipeline.go` — merger (KT-A9)
- `features/platform/outreach-dashboard/src/pages/CampaignDetail.jsx` — 741-LOC (KT-A11 split target)
