---
status: superseded by docs/initiatives/2026-05-29-master-plan-v3-verified.md
date: 2026-05-29
trigger: session synthesis — operator wants comprehensive plan from full conversation history
owner: Hozan Taher (solo CZ B2B asset acquisition operator)
supersedes: docs/initiatives/2026-05-29-galton-funnel-product-plan.md (v1)
---

# MASTER PLAN v2 — Hozan Taher Outreach Dashboard

## 1. Vize (1 odstavec)

Hozan = **asset acquisition specialist** (NE retail seller). Garaaage s.r.o. vykupuje heavy techniku (bagry, nakladače, jeřáby) od firem ke další prodej. Cíl: 4-6 dealů/měsíc × 100-200k Kč margin. Dashboard musí být **DJ konzola u Galton mixéru** — 30s scan, 1 funnel widget, keyboard triage, tap-to-call, body+asset content vidět hned. Dnes mu chybí 68% data z přijatého mailu (`reply_inbox` nemá body) + 3 z 11 acquisition pegs nesleduje (open/read/deal close). Plan toto napravuje za 5 fází.

## 2. 7 pilířů (operator's framework)

| # | Pillar | Galton interpretation |
|---|---|---|
| 1 | **Plné napojení** | Every peg instrumented, every kulička traceable through all 11 pegs |
| 2 | **Plná automatizace** | Mechanical pegs hands-off (operator confirms threshold violations only) |
| 3 | **Plná editovatelnost** | Every coefficient editable via UI bez redeploye |
| 4 | **Plná komplexnost** | All pegs × dimensions (per-mailbox/campaign/step/cohort/day-of-week) |
| 5 | **Plná jednoduchost** | ONE funnel widget on Home; 30s identify weak peg |
| 6 | **Plná těžba** | Every action audit-logged, replayable, learning loop (override→threshold adapt) |
| 7 | **Plná traceability** | Per-reply: body, headers, attachments, asset_extracted všechno dostupné |

## 3. 11 acquisition pegs (Hozanův business funnel)

```
PEG 1   Targeting          ICP filter z 405k contacts (after dedup) → ~100 today
PEG 2   Send               ~95 SMTP-sent (dedup, presend probe, mailbox cap)
PEG 3   Deliver            ~94 inbox-landed (warmup, DKIM/SPF/DMARC)
PEG 4   Open               ~28 opened           ⚠ UNTRACKED
PEG 5   Read               ~25 read             ⚠ UNTRACKED
PEG 6   Reply              ~0.7 replied (current 0.66%)
PEG 7   Classify           Ollama positive/negative/question
PEG 7.5 Asset Eval         Hozan judgment: stroj typ × stav × cena × geo  ★ unikátní hodnota
PEG 8   Phone call         Telefon < 1h od positive reply
PEG 9   Offer              Cenová nabídka (knowledge-based)
PEG 10  Pickup             Vyzvednutí + převod title
PEG 11  Resell             Prodej dál v síti / margin realization → ⚠ UNTRACKED
```

**3 z 11 pegs UNTRACKED** (4, 5, 11). PEG 7.5 je Hozanova unikátní hodnota — UI mu musí dát všechny data pro 30s decision.

## 4. Realita (kde dnes jsme)

### Numeric baseline (16 dní 13.5.-29.5.2026)
- 5437 sent, 54 bounced (1.0%), 303 presend_skip (5.5%), 2 failed
- 36 replies (0.66%), 8 hot (4 positive + 4 question), 1 unsubscribe
- 405 591 contacts (after iter59 G3.4 dedup, -20 707 from 426k)
- 4 active mailboxy (1180 paused od 26.5., 1181-1183 aktivní)
- 10 dní 0 replies (cliff od 19.5.)
- Reply rate per mailbox: 75 paused/0.18%, 76 0.31%, 77 0.37%, 78 0.07%
- ~340 sendů/den (target 430/den for 4-6 dealů/měsíc)
- Per Galton math: 1 hot lead per 680 sendů = 1 hot/2 dny
- Pipeline rate at current: ~7-8 calls/měsíc, ~2-3 dealů (under target)

### Data layer gaps (forensic)
- `reply_inbox` má 12 sloupců ALE NE `body_text`/`body_html`/`attachments`/`headers_json` — **68% data loss**
- Go IMAP fetches FULL RFC822, parsuje, ALE schema drops body — schemou diktovaný gap
- 14/36 (39%) replies má `mailbox_id` + `campaign_id` + `send_event_id` — **thread match regrese od ~16.5.**
- 16/36 (44%) replies má `classification` — Ollama backlog 20
- Všech 36 stuck na `pre_classification.confidence = 0.3` (default seed)
- `subject` MIME-encoded undecoded
- `mailbox_imap_circuit.fail_count = 0` u všech — failure recording broken
- `send_events.created_at` NULL, `smtp_response` NULL, `company_id` NULL, `template_variant_id` NULL

### Iter 45-58 accomplishments (session run)
- 10+ widgets deleted (~250 LOC UI cleanup)
- 601 LOC orphan removed (VerifikaceAdresCard)
- 30+ real UX bugs found (5 brutal Playwright waves + 5 monkey variations)
- 2 T0 violations fixed (audit_log_on_mutations 5 endpoints, no_magic_thresholds 6 ALLOWED_KEYS)
- 3 monkey crash patterns fixed (404 -100%, 500 -90%, 429 -13% insufficient)
- Layout shell-body + accent-soft remap (foundational fixes)
- BFF zombie-pool shutdown robust
- LiveActivityTicker freshness signal
- Sidebar Odpovědi truncation
- DegradedBffBanner wired
- Campaigns empty state CTA
- Drawer Esc + filter persistence + theme FOUC
- 5 napojení wins (dead links, ALLOWED_KEYS, audit_log bigint bug)
- 20,707 duplicate contacts merged + unique constraint enforced
- 5 stale imap_state cleaned

### Audit docs landed
- Home widget audit (8 widgets, 1 DELETE / 2 MERGE / 1 MOVE)
- Cross-page audit (59 widgets across 11 routes, top 10 recommendations)
- Plné napojení + editovatelnost (5 + 9 gaps identified)
- Plná automatizace (6 mechanical + 4 reactive + 4 stuck-recovery)
- Iter58 monkey rerun verification

## 5. Roadmap — 5 phases / 15 sprints

### PHASE 0 — Data Foundation (Sprint G3 + G3.7 + G_consolidate)

**Sprint G_consolidate — Branch reconciliation (NEW, kritický, iter 61)**

Iter 45-60 produced 10+ feature branches with critical work, NONE merged to main. Operator sees broken Home on current branch because iter47 LiveActivity mount isn't here. Branch chaos blocks all visibility.

| Story | Effort | Description |
|---|---|---|
| GC.1 | 1h | Fresh `feat/iter45-60-master-consolidation` from main; cherry-pick all sprint branches in dependency order |
| GC.2 | 30 min | Verify `node --check server.js` + `pnpm test:fast` + curl smoke on every endpoint mentioned in iter45-60 |
| GC.3 | 30 min | Visual verification: Playwright screenshot Home + Pipeline + LeadDetail + Replies — all renders correctly |
| GC.4 | 15 min | Update master plan v2 with final branch SHA + PR-ready note |
| GC.5 | 5 min | Push to remote, open PR to main (optional — operator's call) |

**Acceptance:** ONE branch carrying all iter45-60 work, BFF healthy, Home renders complete (LiveActivityTicker freshness + Galton widget if landed + audit feed if landed).

**Sprint G3 ✅ DONE (iter 59):**
- G3.1 ✅ mailbox_id backfill (14→22/36) — eb6f5220
- G3.2 ✅ Explained — NE regrese, data gap z migration boundary 13.5.
- G3.3 ✅ RFC 2047 subject decoder — 10 historical rows decoded, 0 MIME-encoded — 54fc635d
- G3.4 ✅ Contact dedup — 9,451 dup groups → 0 (-20,707 rows) — 082f076d
- G3.5 ✅ Ollama classifier fix — wrong JOIN bug (outreach_messages → channel_messages), 12/14 backfilled — a6eabeb8
- G3.6 ✅ Stale mailbox_imap_state cleanup — 5→0 rows — 082f076d

**Sprint G3.7 (iter 60) — Body content data:**
- G3.7.1 ✅ Schema migration 128 — reply_inbox 12→16 cols (body_text, body_html, attachments_meta JSONB, headers_json JSONB) — 73ef1ba6
- G3.7.2 ✅ Go INSERT update 11-param, sanitized (no IPs, no Received chain) — c60e3622
- G3.7.3 ✅ Trigger fn_reply_inbox_to_channel_messages propagates body → channel_messages
- G3.7.4 ✅ Historical backfill cmd ready (941 LOC Go cmd, IMAP via SOCKS5, --dry-run flag) — 28569584
- G3.7.5 🟡 BFF + UI hover preview (agent a6af2a3b běží)

**Sprint G3.7 — Body content backfill (NEW, kritický)**
- G3.7.1 ALTER TABLE reply_inbox ADD body_text, body_html, attachments_meta, headers_json
- G3.7.2 Go inbound.go INSERT path — populate body fields from already-parsed Parsed{}
- G3.7.3 Update `trg_reply_inbox_to_channel_messages` trigger to copy body
- G3.7.4 Historical backfill 36 existing replies (re-fetch via IMAP UID)
- G3.7.5 Playwright smoke: /replies row hover shows body preview

**Acceptance Phase 0:** all 36 replies have mailbox_id + body + decoded subject + real classification. Foundation solid pro všechny downstream sprints.

### PHASE 1 — Galton Visibility (Sprint G0 + G2 + G1)

**Sprint G0 — Galton funnel widget na Home (~iter 60-61)**
- G0.1 Funnel widget (11-peg vertical visualization)
- G0.2 Audit log feed (reverse-chrono "co systém dělá")
- G0.3 "Co teď?" Next Best Action widget (1 věta + 3 buttons)
- G0.4 Forecasting card (current rates × N days → expected deals)
- G0.5 Delete 5 widgets replaced by funnel
- G0.6 Inbox-tichý honest signal ("0 replies 10 dní, normální pro CZ B2B")
- G0.7 Reply hover-preview (uses G3.7 body data)

**Sprint G2 — Send instrumentation (~iter 62)**
- G2.1 Backfill `send_events.created_at`
- G2.2 Backfill `send_events.smtp_response` (250 OK / DSN code)
- G2.3 Backfill `send_events.company_id` FK
- G2.4 Wire `send_events.template_variant_id` (A/B unlock)
- G2.5 Presend probe coverage report widget

**Sprint G1 — Targeting peg (~iter 63)**
- G1.1 ICP segment builder UI (kraj × business type × score × svěžest)
- G1.2 Top Targets widget — score × svěžest × geo ordered
- G1.3 Per-segment funnel performance widget
- G1.4 ARES delta integration (changes posledních 90 dní)
- G1.5 Insolvenční rejstřík alert flag

**Acceptance Phase 1:** Hozan otevře dashboard → 30s vidí: 1 funnel + audit feed + Co teď + forecast. Top Targets vrátí action-oriented list ne vanity counts.

### PHASE 2 — Workflow Optimization (Sprint G4 + G5 + G6)

**Sprint G4 — Open + Read estimation (~iter 64-65)**
- G4.1 Reply latency proxy (time-to-reply per send_event)
- G4.2 Click tracking via signed redirect URL (anti-trace safe, no open-pixel)
- G4.3 Per-mailbox open/read estimation widget
- G4.4 Cliff-edge detection (auto-flag sudden drop in any peg metric)

**Sprint G5 — Reply dimensions (~iter 66)**
- G5.1 Per-step (Dotaz vs Poptávka) funnel
- G5.2 Per-mailbox reply rate (75 vs 76 vs 77 vs 78 comparison)
- G5.3 Per-day-of-week heatmap (19.5. cliff edge visibility)
- G5.4 Per-cohort funnel (segment × ICP × kraj)

**Sprint G6 — Classify intelligence (~iter 67-68)**
- G6.1 Ollama real confidence tracking (not just default 0.3)
- G6.2 Auto-commit threshold ≥0.85 (operator confirms edge cases only)
- G6.3 Classifier learning loop (operator override → threshold adapt per class)
- G6.4 Asset extraction LLM/regex layer (extract stroj typ + rok + mh + cena z body_text)
- G6.5 Per-reply "Co prodávají?" badge (asset summary v /replies seznamu)

**Acceptance Phase 2:** PEG 4-7 plně instrumented. Hozan vidí per-mailbox/per-step/per-cohort funnel. Asset extracted automatically pro 60-80% replies.

### PHASE 3 — Deal Close + Strategic Intelligence (Sprint G7 + G7.5 + G9)

**Sprint G7 — PEG 8 Phone + PEG 10 Pickup (~iter 69-70)**
- G7.1 Tap-to-call integration (browser tel: + auto-log)
- G7.2 Call notes UI (post-call quick form: outcome, next step, price discussed)
- G7.3 Deal stage tracker (lead → call → meeting → vyzvednutí → resell)
- G7.4 Hozan's calendar integration (scheduled meetings, follow-ups)
- G7.5 Time-to-call SLO widget (target < 1h from positive reply)

**Sprint G7.5 — PEG 9 Offer + cenová znalost (~iter 71-72)**
- G7.5.1 `deals` tabulka (buy_price, sell_price, asset_meta, margin, status)
- G7.5.2 Cenový benchmark widget (typ + rok + mh → suggested offer price)
- G7.5.3 sbazar/bazos scraper (volitelné — Sprint G9 spíš)
- G7.5.4 Historical deal-based price recommendation
- G7.5.5 Manual deal entry form (Hozan zadává close + margin)

**Sprint G9 — Network match + Strategic intel (~iter 73)**
- G9.1 Hozan's network/partners table (komu posílat re-sale offers)
- G9.2 Semi-auto matching (firma má bagr CAT 320 → notify partneři v síti)
- G9.3 Insolvency feed integration (insolvenční rejstřík RSS)
- G9.4 Per-segment ROI dashboard (kraj × business type × season)
- G9.5 Sezónní cykly suggestion (auto-rotate ICP segments podle ročního období)

**Acceptance Phase 3:** PEG 8-11 plně tracked. Hozan má cenový benchmark + network match + deal close UI. ROI per segment viditelný.

### PHASE 4 — Automatizace + Edit-everything (Sprint G8 + G10 + G11)

**Sprint G8 — Automatizace top wins (~iter 74)**
Per `audit/iter58-plna-automatizace`:
- G8.1 Campaign stalled watchdog (running >24h no sends → auto-pause + alert)
- G8.2 AutoClassify → event-driven (LISTEN/NOTIFY on reply_inbox INSERT vs 5-min poll)
- G8.3 Failed-send auto-retry (mechanical → cron)
- G8.4 Watchdog thresholds → operator_settings (T0 violation fix: bounce 5%, low_reply 0.5%)
- G8.5 Mailbox stuck `warming` past graduation auto-progress
- G8.6 Reply unclassified >2h alert (Ollama down detection)

**Sprint G10 — Editovatelnost remaining gaps (~iter 75)**
Per `audit/iter56-plne-napojeni-editovatelnost`:
- G10.1 SEND_BATCH_RATE_LIMIT_MS editable from UI
- G10.2 BFF_AUTO_RECOVER toggle in UI
- G10.3 EMAIL_VERIFY_SMTP + EMAIL_VERIFY_FROM editable (with secret flag)
- G10.4 WYSIWYG template editor v `/templates` (no SQL needed)
- G10.5 Threshold UI completeness audit (everything in operator_settings)
- G10.6 Audit ratchet for hardcoded threshold detection (`grep` test)

**Sprint G11 — Remaining brutal Playwright fixes (~iter 76)**
Stories from waves 1-5 still un-fixed:
- G11.1 Story 11 aria-invalid on empty blur (form validation a11y)
- G11.2 Story 12 /contacts virtualization + scroll-to-top button
- G11.3 Story 13 cross-tab sync via BroadcastChannel
- G11.4 Story 21 ErrorBoundary coverage routes
- G11.5 Story 22 char counter on textarea inputs
- G11.6 Story 23 CSV bulk per-row error display
- G11.7 Story 24 aria-current pro nested routes
- G11.8 Story 25 SSE on-focus retrigger

**Acceptance Phase 4:** No env-only configuration knobs remain. Top 6 automation wins live. 8 remaining brutal Playwright stories pass.

### PHASE 5 — Polish + Handover (Sprint G12 + G13)

**Sprint G12 — UI consolidation + ratchet (~iter 77)**
- G12.1 Delete remaining widgets replaced by Galton funnel
- G12.2 6-pillar audit ratchet T0 tests (one ratchet test per pillar)
- G12.3 Brutal Playwright Galton end-to-end story (full 11-peg flow assertion)
- G12.4 Monkey baseline re-run (target: 0 crashes after rate-limiter whitelist)
- G12.5 Accessibility full audit (WCAG 2 AA across 12 routes)
- G12.6 Performance audit (Lighthouse + bundle size budgets)

**Sprint G13 — Operator handover (~iter 78)**
- G13.1 Operator playbook (`docs/playbooks/operator-daily-routine.md`)
- G13.2 Daily wrap-up email cron debug (currently exists but operator hasn't seen output)
- G13.3 Per-pillar dashboard view (operator can audit each pillar score)
- G13.4 Onboarding video / interactive tour (volitelné)
- G13.5 Rollback playbook (jak revert konkrétní sprint pokud regresses)

**Acceptance Phase 5:** Hozan má operator handover doc, vše ratchet-protected, monkey 0 crashes, daily wrap-up funguje, North Star 30s rule pass end-to-end.

## 6. Execution sequence + dependency graph

```
ITER 59 ── Sprint G3 (běží, 1/3 hotov, 2/3 in progress)
                                │
ITER 60 ── Sprint G3.7 (body content backfill — KRITICKÝ blocker)
                                │
ITER 61-62 ─ Sprint G0 (Galton funnel widget) ┐
                                                ├─ ITER 62-63 ─ Sprint G2 (send_events backfill) [paralelně]
                                                │
ITER 63 ──── Sprint G1 (targeting)
                                │
ITER 64-65 ─ Sprint G4 (open/read estimation)
ITER 66 ──── Sprint G5 (reply dimensions)
ITER 67-68 ─ Sprint G6 (classify + asset extraction) [G6 nepřímo závisí na G3.7 body data]
                                │
ITER 69-70 ─ Sprint G7 (phone + deal stage)
ITER 71-72 ─ Sprint G7.5 (cenová znalost)
ITER 73 ──── Sprint G9 (network match + strategic)
                                │
ITER 74 ──── Sprint G8 (automatizace top wins)
ITER 75 ──── Sprint G10 (editovatelnost cleanup)
ITER 76 ──── Sprint G11 (brutal Playwright remaining)
                                │
ITER 77 ──── Sprint G12 (polish + ratchet)
ITER 78 ──── Sprint G13 (operator handover)
```

**Total estimate:** ~20 iters × 3 agents paralelně × 1-2h work = ~60-80h real time over 4-6 týdnů kalendářně.

## 7. Měřitelné goals per phase

| Phase | KPI before | KPI target |
|---|---|---|
| 0 (Foundation) | 32% IMAP data retained | 95%+ retained, all 36 replies fully populated |
| 1 (Visibility) | 17 widgets na Home | 5 widgets (1 funnel + audit + co teď + forecast + free space) |
| 2 (Workflow) | 3/11 pegs untracked | 0/11 pegs untracked |
| 3 (Deal close) | Deals untracked | 4-6 dealů/měsíc visible + margin tracked |
| 4 (Automatizace) | ~6 manual mechanical steps | 0 manual mechanical (all event/cron) |
| 5 (Polish) | Monkey 1486 crashes | Monkey 0 crashes |

## 8. Iter 59 immediate actions (RIGHT NOW)

Right now (Sprint G3):
- ✅ G3.4 contact dedup done (-20,707 rows)
- ✅ G3.6 stale imap state done
- 🟡 G3.1 + G3.2 mailbox_id + thread matching (agent ab3c0b46 still running)
- 🟡 G3.3 + G3.5 subject decoder + Ollama (agent a5cbe89f still running)

**Pending decision:** Sprint G3.7 (body content schema migration + backfill) — spawn now as 4th paralelní agent, nebo počkat na current 2 agents finish?

**Recommendation:** spawn G3.7 paralelně NOW. Schema migration je nezávislá na G3.1-G3.5 (jen ALTER TABLE + INSERT column update + backfill). Žádný conflict.

## 9. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Body backfill needs IMAP refetch — old UIDs may be expired | UIDs persist on Seznam side; mailbox_id required for refetch (depends on G3.1 ordering) |
| Thread matching diagnosis may reveal fundamental design issue | Plan supports skip-and-document path; partial fix still unlocks 14/36 of metrics |
| Ollama classifier offline → 20 unclassified backlog | Plan documents `docs/playbooks/ollama-setup.md` for operator bootstrap |
| `feedback_no_fabricated_test_data` T0 — seed data violates rule | Operator standing directive explicitly requests seeds; documented as override per session |
| Monkey 429 fix incomplete (-6% vs target -80%) | Sprint G12 covers rate-limiter whitelist deepening |
| 5 conflicting branches still on disk | Sprint G12 includes branch reconciliation audit |
| Plan v1 → v2 supersedes — old initiative doc | This doc marks v1 as superseded; keep v1 archived |
| Operator manual edits during session (Layout.jsx) | Plan respects operator's manual edits as authoritative |

## 10. Out-of-scope (explicit NO)

Things NOT in this plan despite tempting adjacency:
- Mobile app (operator local-only HARD rule)
- Multi-user / team collaboration (solo operator)
- Salesforce-like generic CRM features (outreach specialist, ne CRM)
- White-label / multi-tenant (single operator, Garaaage)
- Web pixel tracking (anti-trace policy, Sprint G4 uses signed redirect alternative)
- SMS / WhatsApp channel (email-only outreach today)
- Multi-language UI (CZ only)
- A/B testing framework as feature (template_variant_id wire-up is sufficient)

## 11. Memory persistence post-plan

Save these to user memory after Sprint G3 completes:
- `project_galton_funnel_north_star` T1 — 11 pegs + 7 pillars framework
- `feedback_uvazuj_galton_lens` T1 — always frame metric questions in Galton terms
- `project_hozan_business_model` T1 — asset acquisition not retail sales
- `project_imap_body_data_loss_fixed` T1 — schema migration + Go INSERT updated post-G3.7

## 12. Open operator questions

1. **G3.7 spawn timing:** spawn NOW (paralelně s 2 běžícími agenty), nebo až po dokončení G3.1-G3.5?
2. **Mailbox 1180 (hozan.taher.75)** — reactivate? Paused od 26.5., 3 dny — sniprostavebnictví/seznam reason?
3. **Send volume:** raise 340/day → 430/day pro target 4-6 dealů/měsíc? Means daily_cap_override increase.
4. **Open-pixel alternative:** souhlasíš s click-tracking via signed redirect URL (Sprint G4)?
5. **sbazar/bazos scraper:** souhlasíš jako Sprint G9 součást? Externí scrape může mít legal/ToS důsledky.
6. **Phone integration:** browser `tel:` link basic, nebo SIP/SMS gateway pro auto-log calls?
7. **Forecast horizon default:** week / month / quarter?
8. **Branch consolidation:** mergnout všechny iter45-58 work do main jako jeden velký PR, nebo phase-by-phase?

## 13. Status

**Living document.** Updates expected per sprint completion.

Current iter: 59 (Sprint G3 running)
Next checkpoint: Sprint G3 complete → Sprint G3.7 spawn → Sprint G0 start
