# Kampaň výkupu techniky — master plán (2 agenti paralelně)

**Status:** active (draft → schválení v této session)
**Created:** 2026-04-30
**Trigger:** User direction 2026-04-30: "Potřebuju abychom dnes byli schopni poslat jednu komplexní kampaň ohledně výkupu techniky. Bude nám chodit odpovědi, potřebujeme zpracovávat. Lab + skutečná kampaň. Real-time data scraping. UI. Brutal testing."
**Owner:** Tomáš (operátor + landing pass) + Chat A (Build) + Chat B (Quality)

## Východisko

Existuje rozsáhlá předchozí práce (do 2026-04-30):

| Co existuje | Kde | Stav |
|---|---|---|
| Outbound infrastruktura (campaigns + sender + anti-trace-relay) | `features/outreach/campaigns`, `features/outreach/anti-trace-relay` | code-complete |
| Suppression UNION (outreach_suppressions ∪ suppression_list) | `features/platform/outreach-dashboard/campaignPreflight.js` | implemented |
| GDPR primitives (LIA, ROPA, privacy, DSR) | `docs/legal/`, `features/inbound/orchestrator/web/dsr.go` | implemented |
| Soft launch playbook | `docs/playbooks/LAUNCH-CAMPAIGN-001.md` | ready |
| Generic launch runbook | `docs/playbooks/first-campaign-launch.md` | ready |
| Template `initial.tmpl` (Garaaage výkup-aukce angle) | `features/outreach/campaigns/configs/templates/initial.tmpl` | exists, IČO/sídlo placeholders |
| Mail Lab (3 provideři + lab API + chaos overlay) | shipped jako 17 PRs | **0 merged** |
| Operator Practice (anonymized replay tooling) | shipped jako 7 PRs | **0 merged** |
| LLM Reply Classifier | `docs/initiatives/2026-04-27-llm-reply-classifier.md` | active |
| Operator Flow UX | `docs/initiatives/2026-04-28-operator-flow-architecture.md` | návrh |
| Test infra (vitest workspace, brutal asserts, Tests as Heart) | shipped | active |
| 10 CRITICAL/HIGH unmerged sec/correctness fixes | PRs #161, #162, #166, #169-#175, #183 | queue |

**Co dnešní stav umožňuje:**
- Existující outbound code path je prokazatelně funkční (PR #25 + 26 commits, 2474 Go testů + 2363 JS testů, 3 reálné maily doručené)
- Kampaň 455 v DB (status=draft, 20 contacts enrolled, machinery-tagged)
- Template `initial.tmpl` má textaci pro výkup techniky (Garaaage aukce)
- LAUNCH-CAMPAIGN-001.md je end-to-end runbook pro 20-contact soft launch

**Co chybí pro dnešní first-send:**
1. Operator data (IČO Garaaage s.r.o. = `23219700` per CLAUDE.md, sídlo placeholder)
2. Privacy policy URL live (garaaage.cz/privacy NEBO GH Pages fallback)
3. BFF deploy na Railway s `UNSUBSCRIBE_BASE_URL`
4. Mailbox passwords v DB (24 mailboxů Seznam fleet — operator založí + uloží passwords)
5. Manual unsub-link test + send-test verification

**Co chybí pro long-term provoz:**
- Reply triage workflow + classifier accuracy validation
- Lab ↔ prod feedback loop (anonymizovaná reply replay)
- Real-time scraping resilience (proxy rotation + block detection)
- UI evolution (campaign lifecycle, replies, operator dashboard)
- Brutal testing pass (adversarial, mutation, load, GDPR audit)

## Cíl

**3-měsíční roadmap rozdělená do 30 sprintů, paralelně mezi 2 agenty.** Konečný stav:

1. **TODAY — D+0:** První kampaň výkupu techniky odeslaná (20 contacts soft launch) per existing playbook
2. **D+3:** Reply triage workflow validovaný proti reálným odpovědím
3. **D+7:** Lab feedback loop běží — anonymized real replies → lab inbox → operator practice mode
4. **D+14:** Real-time scraping resilience proti block (proxy rotation + auto-failover)
5. **D+21:** UI evolution dokončené (campaign lifecycle + replies + operator dashboard)
6. **D+30:** Brutal testing pass — adversarial + mutation + load + compliance — všechny CRITICAL/HIGH closed

## Non-goals

- Multi-step sequences (followup1.tmpl + final.tmpl) — mimo scope této iniciativy (existující S6 sprint v Garaaage v4 plánu)
- Multi-region deploy (Railway region rozhodnutí mimo scope)
- New product features beyond reply→lead→Garaaage handoff

## Constraints

| # | Pravidlo | Aplikace |
|---|---|---|
| 1 | `feedback_campaign_send` HARD RULE | Operator gate na každý send krok |
| 2 | `feedback_no_direct_smtp` HARD RULE | Vše přes anti-trace-relay |
| 3 | `feedback_no_direct_transport` HARD RULE | TRANSPORT_MODE=direct BANNED |
| 4 | `feedback_mailbox_passwords_via_db` HARD RULE | Nikdy env vars |
| 5 | `feedback_no_fabricated_test_data` HARD RULE | Real anonymized data only |
| 6 | `feedback_extreme_testing` HARD RULE | ≥10 brutal asserts per change |
| 7 | `feedback_long_stacks_ok` | 12+ deep PR stack akceptovaný |
| 8 | GDPR Art. 6/1/f legitimate interest | Footer + LIA + ROPA + privacy mandatory |
| 9 | Czech zákon 480/2004 Sb. | Easy opt-out (unsubscribe link + STOP keyword) |
| 10 | `project_b2b_transport_mode` | production runs `proxy`, prázdný pool errors out |
| 11 | `project_seznam_proxy_geo_mismatch` | CZ exit přes Mullvad wireproxy |

## Architektura — split mezi 2 agenty

### Chat A — Build / Dev

**Branch:** `wm/development`
**Worktree:** `/Users/messingtomas/Documents/Projekty/hozan-taher-dev/`
**Bootstrap:** [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-A-build.md`](2026-04-30-kampan-vykupu-techniky-A-build.md)

**Scope:**
- Production path: real campaign send + monitoring
- Real-time scraping resilience (proxy + block detection)
- UI evolution (campaign lifecycle, companies, leads, segments)
- Hot-path code (engine, sender, scrapers)
- ML5.2 engine wiring + airtight boot gate

**15 sprintů:** KT-A1 → KT-A15 (viz A-build doc)

### Chat B — Quality / Tests

**Branch:** `wm/tests`
**Worktree:** `/Users/messingtomas/Documents/Projekty/hozan-taher-tests/`
**Bootstrap:** [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md`](2026-04-30-kampan-vykupu-techniky-B-quality.md)

**Scope:**
- E2E + integration + contract testy
- Reply triage workflow validation
- Lab ↔ prod feedback loop (Mail Lab + Operator Practice)
- LLM classifier accuracy measurement
- Brutal/adversarial/mutation/load testing
- GDPR + compliance audit
- Reply UI deep verification

**15 sprintů:** KT-B1 → KT-B15 (viz B-quality doc)

## Handoff protocol

Per existující `docs/handoff/`:

- **`docs/handoff/BOARD.md`** — sdílený stav. Každý chat updatuje "Cross-branch signals" na konci turn.
- **`docs/handoff/bootstrap-dev.md`** — Chat A start/end ritual
- **`docs/handoff/bootstrap-tests.md`** — Chat B start/end ritual

**Commit trailery:**

```
Needs-Tests: <modul> <popis>           # A→B signál
Breaks-Contract: <api|event|schema>     # A→B contract change
Covers: #<PR>                           # B→A test coverage
Resolves-Trailer: Needs-Tests: <modul>  # B→A resolved
Cross-Initiative: KT-A<N> | KT-B<N>     # link sprint reference
```

## Sprint mapování (overview, 30 sprintů)

### Phase 1 — Den 0 (TODAY): First send

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-A1 | A | Land 10 CRITICAL/HIGH fixes (#161, #162, #166, #169-#175, #183) | 1 |
| KT-A2 | A | Operator data — IČO/sídlo placeholders fill, privacy.html publish | 0.5 (operator) |
| KT-A3 | A | BFF deploy + UNSUBSCRIBE_BASE_URL env | 0.5 |
| KT-A4 | A | Mailbox passwords v DB (24-mailbox Seznam fleet) | operator |
| KT-A5 | A | Pre-flight + dry-run + send-test + 0→1→48 staircase (1 mailbox → 1 send → 24 × 2/day) | 1 |

### Phase 2 — Dni 1-3: First batch + reply infra

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-A6 | A | 2→20/mailbox staircase per `vykup_24mb` warmup curve (480/den max) + 24h monitoring | 2 |
| KT-B1 | B | Reply IMAP poll verification + first replies arrive | 1 |
| KT-B2 | B | LLM classifier accuracy on first 20 replies (manual ground-truth) | 2 |
| KT-B3 | B | Reply triage workflow E2E (operator → triage → respond) | 2 |

### Phase 3 — Týden 1: Reply quality + lab loop start

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-B4 | B | Edge case discovery — classifier override capture | 2 |
| KT-B5 | B | Mail Lab feedback loop — anonymized replay (post AT1.x landing) | 3 |
| KT-A14 | A | ML5.2 engine wiring + LAB_ONLY=1 airtight boot gate | 2 |
| KT-B6 | B | Operator Practice OP3-OP5 (timer + override + confusion matrix) | 3 |

### Phase 4 — Týden 2: Real-time scraping anti-block

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-A7 | A | Scraper resilience — proxy rotation infrastructure | 2 |
| KT-A8 | A | Block detection + auto-failover (HTTP 4xx/5xx pattern, captcha detection) | 2 |
| KT-A9 | A | Multi-source enrichment (ARES + firmy.cz + alternatives) | 2 |
| KT-A10 | A | Refresh cron frequency tuning (real-time pull cadence) | 1 |
| KT-B15 | B | Real-time scraping chaos validation — block scenarios + recovery | 2 |

### Phase 5 — Týden 3: UI evolution

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-A11 | A | UI — campaign lifecycle (preflight gate, monitoring, archive) | 3 |
| KT-A12 | A | UI — companies + leads + segments redesign land (UX F1-F14) | 3 |
| KT-A13 | A | UI — operator daily flow (replies + dashboard widgets) | 2 |
| KT-B14 | B | Replies UI deep test (forward, search, label, threading) | 2 |

### Phase 6 — Týden 4: Brutal testing pass

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-B7 | B | Adversarial test sweep (per `2026-04-27-adversarial-fixes.md`) | 2 |
| KT-B8 | B | Property + chaos extensions (sender + replies hot paths) | 3 |
| KT-B9 | B | Mutation testing (Stryker) on critical lib | 2 |
| KT-B10 | B | Load + reliability testing | 2 |
| KT-B11 | B | GDPR + compliance audit (DSR access + erase manual run) | 2 |
| KT-B12 | B | Self-healing validation (per Tests as Heart) | 2 |
| KT-B13 | B | **Bug bash** — surface every CRITICAL/HIGH before scale-out | 2 |

### Phase 7 — Týden 5: Multi-step + scale prep

| Sprint | Owner | Goal | Days |
|---|---|---|---|
| KT-A15 | A | Followup1.tmpl + final.tmpl + multi-step sequences | 2 |

## Acceptance celé iniciativy (rolling)

- [ ] D+0: Kampaň 455 (nebo nová "Výkup techniky 001") status=running, 20 contacts started
- [ ] D+1: First reply zachycen v `reply_inbox`, klasifikováno LLM
- [ ] D+3: 20 contacts dokončeno (95%+ delivered, ≤5% bounce)
- [ ] D+7: Mail Lab feedback loop běží — anonymized replay zachycen v lab inboxu, klasifikátor akcuracy měřena
- [ ] D+14: Real-time scraping přežívá simulovaný block (failover → alternative source)
- [ ] D+21: UI evolution dokončené — operator daily flow ≤15 min na 25 replies
- [ ] D+30: Brutal testing — všechny CRITICAL/HIGH closed, mutation score ≥75%, GDPR DSR validated

## Open questions for user (gates)

| # | Question | Blokuje | Default |
|---|---|---|---|
| 1 | IČO Garaaage s.r.o. | KT-A2 | `23219700` (per root CLAUDE.md) |
| 2 | Sídlo Garaaage s.r.o. | KT-A2 | musí dodat operator |
| 3 | Privacy policy URL | KT-A2 | garaaage.cz/privacy preferred; GH Pages fallback `messingdev.github.io/garaaage-privacy/` |
| 4 | BFF deploy target Railway | KT-A3 | musí dodat operator |
| 5 | Mailbox creds (24 Seznam mailboxů) | KT-A4 | operator-only step |
| 6 | Source segment "výkup techniky" — same jako machinery, nebo distinct NACE? | KT-A5 | pravděpodobně reuse machinery (campaign 455) |

## Risk register

| Riziko | Severity | Mitigace |
|---|---|---|
| First send bounces > 10% | HIGH | Staircase 0→1→5→20; auto-pause cron BF-A4; rollback trigger v playbooku |
| Klasifikátor false-positive na "negative" → false suppression | HIGH | KT-B2 manual ground-truth na first 20 replies; KT-B4 override capture |
| Scraper blocked → segment refresh stops | HIGH | KT-A7 + KT-A8 proxy rotation + block detection |
| Lab feedback loop drift od prod reality | MEDIUM | KT-B5 anonymized real replay; quarterly recalibration |
| UI redesign konflikty | MEDIUM | KT-A11-13 cesta vede skrz UX-F1 → F14 sekvenčně, rebase-stack.sh řeší stack |
| GDPR DSR endpoint untested at scale | HIGH | KT-B11 manual DSR run + audit |
| Mail Lab + Operator Practice unmerged → lab loop nefunguje | HIGH | AT1.1-AT1.3 landing musí proběhnout před KT-B5 |

## Reference initiative docs

Tento master synchronizuje s:

- [`2026-04-25-garaaage-launch-plan-v4.md`](2026-04-25-garaaage-launch-plan-v4.md) — předchozí launch plán (S2-S6)
- [`2026-04-29-mail-lab.md`](2026-04-29-mail-lab.md) — Mail Lab provider sim
- [`2026-04-30-operator-practice.md`](2026-04-30-operator-practice.md) — anonymized reply replay
- [`2026-04-30-airtight-dev-env.md`](2026-04-30-airtight-dev-env.md) — kill switch
- [`2026-04-27-llm-reply-classifier.md`](2026-04-27-llm-reply-classifier.md) — semantic classifier
- [`2026-04-28-operator-flow-architecture.md`](2026-04-28-operator-flow-architecture.md) — operator UX
- [`2026-04-26-comprehensive-testing-self-healing.md`](2026-04-26-comprehensive-testing-self-healing.md) — Tests as Heart
- [`2026-04-27-adversarial-fixes.md`](2026-04-27-adversarial-fixes.md) — adversarial test pass

## Status tracking

Per CLAUDE.md backlog protocol — 30 GH issues `[KT-A1]` ... `[KT-B15]` s priority/p1 + label `from/initiative`. Bot worker pickup omezen na `automation/ok` (Chat A code work, Chat B test code).

Kompletní rozpis sprintů viz dílčí docs:
- [Chat A — Build](2026-04-30-kampan-vykupu-techniky-A-build.md)
- [Chat B — Quality](2026-04-30-kampan-vykupu-techniky-B-quality.md)
