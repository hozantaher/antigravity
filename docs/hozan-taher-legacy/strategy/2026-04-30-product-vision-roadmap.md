# Hozan Taher — Produktová vize a roadmapa

**Status:** Draft (odsouhlaseno user direction 2026-04-30)
**Datum:** 2026-04-30
**Trigger:** User direction po deep audit consolidation: "Cílem je systém, který bude naprosto autonomní a self-learning s pomocí operátora... časem to nepůjde poznat od skutečného člověka."
**Vlastník:** Tomáš (vision + gates) + Chat A (Build) + Chat B (Quality)
**Související:**
- [Master plán 30-denní](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md) — D+0 až D+30 detail
- [First send MVP](../initiatives/2026-04-27-first-send-mvp.md) — D+0 ops
- [Launch readiness](../initiatives/2026-04-27-launch-readiness.md) — 3-denní conservative variant
- Memory: `feedback_search_before_implement`, `feedback_spawn_first_solo_second`

> **Tento dokument je strategický nadřazený plán** sjednocující vizi (Year+1 horizont) s taktickými iniciativami v `docs/initiatives/`. Initiative dokumenty popisují **co se dělá tento sprint**; tento dokument odpovídá na **proč to celé děláme a kam jdeme**.

---

## 1. Finální vize (Year+1 final state)

**Hozan Taher je plně autonomní AI-driven sales-engagement platforma pro Garaaage s.r.o. — ČR-native B2B výkup-aukce kanál pro heavy-machinery + utility vehicles.**

### Měřitelné cíle

| Year+1 koncový stav | Měřitelné kritérium |
|---|---|
| Plná autonomie (1 operátor monitoruje, neopravuje) | <5 % AI-návrhů přepisujáno operátorem |
| AI nepoznatelné od člověka | Reply rate ≥ ručně-psané baseline; žádný recipient flag „bot" |
| Multi-channel inbox sjednocený | Email + WhatsApp + portal events na 1 timeline view per firma |
| Vlastní storage (ne IMAP-dependent) | Schránka zablokována ≠ outage; messages persistují vlastní database |
| Multi-modal parsing (foto + text → structured) | ≥90 % accuracy na machinery year/make/condition extrakce z obrázku |
| Cross-system tracking GDPR-compliant | Subject identifiable napříč Garaaage portal + Analytics + Ads bez PII leak |
| Self-learning loop běží | Operator override rate trend ↓ minimálně 5 pp/quarter |
| Garaaage výkup pipeline plně integrovaný | Reply → parse → technik foto → portal listing v <48h median |

### Co Hozan Taher NENÍ (explicit non-goals)

- **Není multi-tenant SaaS** — single-tenant Garaaage instance po Year+1; multi-tenant až po proven product-market fit
- **Není CRM** — ne lead pipeline / opportunity management / forecasting; integruje s Garaaage portal jako sink
- **Není autoresponder** — žádné slepé "marketingové automation"; každá akce má operator-loop track
- **Není outbound spam** — striktní GDPR čl. 6/1/f legitimate interest scope (B2B veřejný registr ARES/firmy.cz, easy opt-out, full ROPA)
- **Není emailmarketingová suite** — žádné drag-drop builder, A/B testing UI, segment editor; vše API-first + operator UI

---

## 2. Vrstvy systému (4 hlavní osy)

Vize se dělí na **4 nezávislé osy**, každá má vlastní gap-analysis a sprint katalog.

### Osa A — Komunikační kanály

Inbox-out + parser per channel.

| Kanál | Status | Cíl Year+1 |
|---|---|---|
| **Email outbound** | ✅ done (sender + anti-trace-relay + Mullvad CZ exit) | Beze změny — production stable |
| **Email inbound (IMAP)** | ✅ done (poller + thread storage) | Pouze BACKUP — primárním kanálem se stane vlastní SMTP receiver |
| **Email inbound (own SMTP receiver)** | ❌ chybí | Vlastní MX server, IMAP-independent, blokovaná schránka ≠ outage |
| **WhatsApp** | ❌ chybí | WhatsApp Business API integration, per-firma 1:1 chat |
| **Telefon (volitelné, late)** | ❌ chybí | Twilio click-to-call + transcript log; možná skip |
| **Portal events (Garaaage)** | partial | Listing creation, photo upload, sale → trackováno na firma timeline |

### Osa B — Parsing & Learning

Reply → structured data → operator approval → learning.

| Komponenta | Status | Cíl Year+1 |
|---|---|---|
| **Reply text classifier (LLM Ollama)** | ✅ done (6 kategorií: interested/meeting/later/objection/negative/ooo) | Accuracy ≥ 90 % na real corpus, ≥ 75 % mutation score |
| **Multi-modal photo parser** | ❌ chybí | Vision LLM (GPT-4V or local) + machinery-specific extractor: year/make/model/condition/odometer |
| **Inline attachment OCR** | ❌ chybí | PDF/scan → text extraction (servisní knihy, faktury) |
| **Operator override capture** | partial | Operator přepíše AI návrh → uloží se dvojice (AI návrh, finální výstup) → fine-tune dataset |
| **Self-learning loop** | ❌ chybí | Quarterly model fine-tune nebo prompt-tuning na accumulated overrides |
| **Confidence scoring** | partial | Per-classification confidence → low-confidence flagged operatorovi přednostně |

### Osa C — UI / Operator workflow

Operator daily flow + per-firma deep view.

| Komponenta | Status | Cíl Year+1 |
|---|---|---|
| **Per-firma timeline UI** | ❌ chybí | 1 view: email + whatsapp + portal events + tracking signals chronologicky |
| **Operator approval flow** | ❌ chybí | AI navrhne odpověď → operator [Approve / Edit / Reject] → audit + dataset |
| **Attachment viewer (photo gallery)** | partial (MIME parsed) | UI gallery per firma, full-size + thumbnails, photo metadata extraction |
| **Reply suggestion UI** | partial (klasifikace) | Generuje návrh odpovědi na základě firma context + thread history |
| **WhatsApp chat UI** | ❌ chybí | Ekvivalent Email thread UI, ale s WhatsApp message types (text/image/voice/doc) |
| **Cross-channel switch** | ❌ chybí | Per-firma přepínač Email ↔ WhatsApp; per-contact channel preference |
| **Operator daily dashboard** | partial | "Dnes 25 replies čeká, 3 flagged low-confidence, 2 escalations" — single landing |

### Osa D — Infrastruktura & Compliance

Persistence, tracking, GDPR, observability.

| Komponenta | Status | Cíl Year+1 |
|---|---|---|
| **Thread storage (Postgres)** | ✅ done | Beze změny |
| **Attachment binary storage** | ❌ chybí | S3-compatible (MinIO/Backblaze) nebo Railway volume; per-firma retention policy |
| **Cross-system tracking subject** | partial (open-pixel + click-redirect) | Pseudonymized identifier napříč Garaaage portal + GA4 + Meta Ads bez PII leak |
| **GDPR primitives** | ✅ done (LIA, ROPA, privacy notice, DSR Art. 15/17, suppression UNION) | Audit refresh každý quarter |
| **Observability** | ✅ done (Sentry, slog op-field) | Alert thresholds tuning po prvních 1000 replies |
| **Mailbox warmup pipeline** | ✅ done (per-mailbox daily limit + warmup curve) | Scale na 24 mailboxů (`vykup_24mb` curve: 2→5→10→20/den/mailbox = 480/den fleet plateau) |
| **Anti-block proxy infrastructure** | ✅ done (Mullvad wireproxy CZ exit) | Diversifikace exit IP přes 24 mailboxů + případné dálky |

---

## 3. Současný stav — co je hotové (audit 2026-04-30 evening)

Po dnešním audit consolidation work:

### Production-ready komponenty

- **Outbound infrastruktura:** sender + anti-trace-relay + Mullvad CZ exit, 1500+ Go testů zelené
- **Reply infrastruktura:** IMAP poller + MIME parser + thread storage + LLM classifier (Ollama)
- **Suppression UNION:** mechanically enforced (canonical Go + JS + discipline test, PR #409)
- **Airtight dev env:** lab kill switch (LAB_ONLY=1, single source `cfg.Validate()`, exit 47/48, PR #407)
- **Audit ratchets:** slog op-field + sentinel-compare + airtight + transport-mode (PR #400, #405)
- **GDPR primitives:** LIA, ROPA, privacy notice, DSR Art. 15/17 (cascade fixed PR #381)
- **Brutal testing:** mutation 79.43 % (PR #399), chaos sims (PR #388), property/audit/contract suites
- **Mail Lab + Operator Practice:** provider sim + anonymized replay framework
- **Common library:** `envconfig.GetOr/BoolOr` canonical (PR #406), `sqlsuppression` canonical (PR #409), `slogop` scanner canonical (PR #405), `token` canonical s const-time verify (PR #408)

### Memory rules (procedural gates)

- `feedback_campaign_send` — HARD RULE: campaign send výhradně s explicit user consent
- `feedback_no_direct_smtp` — HARD RULE: vše přes anti-trace-relay
- `feedback_no_direct_transport` — HARD RULE: TRANSPORT_MODE=direct BANNED
- `feedback_mailbox_passwords_via_db` — HARD RULE: hesla výhradně přes DB (UI nebo SQL UPDATE)
- `feedback_no_fabricated_test_data` — HARD RULE: real anonymized data only
- `feedback_extreme_testing` — ≥10 brutal asserts per change
- `feedback_search_before_implement` — HARD RULE: search před každou novou function/struct
- `feedback_spawn_first_solo_second` — procedural gate před každým solo PR

### Audit consolidation (dnes 2026-04-30 evening)

13 duplicate findings → 0 CRITICAL/HIGH duplicates (6 consolidation PRs #404-#409). Bonus: const-time security fix v BFF /unsubscribe handler (PR #408).

---

## 4. Gap analysis — co chybí pro full vision

### CRITICAL gaps (architektonický shift, M+1 priority)

1. **IMAP-independent inbound** — vlastní SMTP receiver (Postfix nebo Go MTA), persistent storage, IMAP jen jako BACKUP source. Aktuální risk: schránku zablokují → outage.
2. **Attachment binary storage backend** — S3-kompatibilní (MinIO/Backblaze) nebo Railway volume. Per-firma photo galerie potřebuje persistent blobs.
3. **Operator approval UI + learning loop** — AI návrh → [Approve/Edit/Reject] → audit + dataset accumulation pro fine-tune.
4. **WhatsApp Business API integration** — celá vrstva chybí, separate channel handler + unified per-firma inbox.

### HIGH gaps (M+2-3)

5. **Multi-modal vision parser** — fotky → structured machinery data (year, make, model, odometer, condition, damage assessment).
6. **Cross-system tracking subject** — pseudonymized identifier napříč Garaaage portal + GA4 + Meta Ads bez PII leak.
7. **Per-firma timeline UI** — combine email + whatsapp + portal events + tracking signals do 1 chronologický view.
8. **AI návrh generator** — generate reply draft based on firma context + thread history (currently máme classifier, ne generator).

### MEDIUM gaps (M+3-6)

9. **Confidence-based routing** — low-confidence classifications flagged operatorovi přednostně; high-confidence auto-proceed s monitoring.
10. **Self-learning evaluation metrics** — track operator override rate trend, surface model drift.
11. **Multi-step sequence support** — followup1.tmpl + final.tmpl (master plán mentions S6 sprint).
12. **Cross-channel preference** — per-contact "WhatsApp preferred" flag; routing decisions.

### LOW gaps (Year+1 nice-to-haves)

13. **Telefon kanál** — Twilio click-to-call + transcript log.
14. **OCR pipeline** — PDF/scan → text extraction (servisní knihy, faktury).
15. **Multi-tenant scaffolding** — pokud post-Year+1 SaaS evolution.

---

## 5. 5-fázová roadmapa (D+0 až Year+1)

### Phase 0 — Den 0 (TODAY): First Send Foundation

**Cíl:** 24 schránek operativní, kampaň výkupu techniky odeslána (day-1 batch 24 × 2 = 48 mailů per `vykup_24mb` warmup curve).

**Operator gates (musí Tomáš):**
1. **17 security PRs** (#161-184) admin-merge — 90 min batch session
2. **24 Seznam mailboxů** — vytvořit účty (operator-only step u Seznamu)
3. **24 sad app-passwordů** — uložit do DB přes UI nebo SQL UPDATE
4. **Sídlo Garaaage s.r.o.** — doplnit do template
5. **Privacy URL live** — `garaaage.cz/privacy` nebo GH Pages fallback
6. **Railway BFF deploy** + `UNSUBSCRIBE_BASE_URL` env
7. **Schválit kampaň send** (po pre-flight + dry-run + test mail per mailbox)

**Chat A (Build) prep:**
- Update template `initial.tmpl` na finální text (per user draft: "získal jsem kontakt v katalogu firem...")
- Update master plán: 2 mailboxy → 24 mailboxů (sprint KT-A4 + KT-A5 + KT-A6)
- Update playbook `kt-a4-mailbox-password-update.md` na 24 schránek
- Update `features/outreach/campaigns/configs/warmup.yaml` na 24-mailbox `vykup_24mb` warmup curve
- Pre-flight + dry-run + send-test verification

**Acceptance:**
- [ ] 24 mailboxů v `mailboxes` table s `password_encrypted IS NOT NULL`
- [ ] Kampaň 455 (nebo nová) `status=running` po user `--go` consent
- [ ] First-day batch 48 mailů odeslaných (24 × 2/mailbox per `vykup_24mb` day 1), `send_events` count = 48
- [ ] 0 hard bounces v prvních 48 (verify via reply IMAP poll)

### Phase 1 — Den 1 až D+7: Reply Triage & Mail Lab Loop

**Cíl:** Reply triage workflow validovaný, anonymized replay loop běží.

**Sprinty (existující master plán KT-B1, KT-B2, KT-B3, KT-B4, KT-B5):**
- **KT-B1** Reply IMAP poll verification (BFF↔Go contract testy ✅ done PR #351)
- **KT-B2** LLM classifier accuracy na first 20 reálných replies (BLOCKED na real corpus)
- **KT-B3** Reply triage E2E Playwright (✅ done PR #384)
- **KT-B4** Edge case discovery — operator override capture (✅ done PR #385)
- **KT-B5** Mail Lab feedback loop — anonymized replay (depends Mail Lab landing)

**Acceptance:**
- [ ] First reply zachycen v `reply_inbox`, klasifikováno LLM
- [ ] Operator triage flow ≤30s/reply
- [ ] 20 contacts dokončeno (≥95 % delivered, ≤5 % bounce)
- [ ] First override capture event v audit log

### Phase 2 — D+7 až M+1: IMAP-Independence + Attachment Storage

**Cíl:** Vlastní SMTP receiver + S3-compatible blob storage. **Architektonický shift.**

**Nové sprinty (mimo current master plán):**

1. **OWN-SMTP-1** — Architecture decision: vlastní Postfix v Railway vs Go MTA + relay vs forwarding strategy. ADR + spike implementation.
2. **OWN-SMTP-2** — DNS MX setup pro `*@garaaage.cz` na vlastní receiver. SPF/DKIM/DMARC certifikace.
3. **OWN-SMTP-3** — Persistent message storage (own DB) + MIME parser napojení na thread storage. IMAP poller jako backup source.
4. **STORE-1** — S3-compatible setup (MinIO self-hosted v Railway nebo Backblaze B2). Per-firma retention policy ADR.
5. **STORE-2** — Attachment ingestion při reply parse → blob upload + DB metadata ref.
6. **STORE-3** — UI gallery komponenta (per-firma photo viewer s thumbnails).

**Acceptance:**
- [ ] `*@garaaage.cz` doručeno přes vlastní MX, persistent storage
- [ ] Schránka u Seznamu zablokována (simulovaný test) → žádný outage
- [ ] First reply s photo přílohou → uloženo do blob storage, viditelné v UI
- [ ] Per-firma photo galerie funkční (≥3 photos test)

### Phase 3 — M+1 až M+3: Operator Approval + Multi-Modal Parser

**Cíl:** Operator-in-the-loop UI s feedback loop + vision LLM photo parser.

**Nové sprinty:**

1. **APPROVE-1** — UI komponenta: AI návrh odpovědi → [Approve / Edit / Reject] flow. Backend audit log.
2. **APPROVE-2** — Dataset accumulation: každý override (původní AI výstup, finální editovaná odpověď) uložen do `learning_dataset` table.
3. **APPROVE-3** — Confidence scoring: low-confidence flagged operatorovi přednostně. Threshold tuning.
4. **VISION-1** — Architecture decision: GPT-4V vs Claude vision vs Ollama vision (LLaVA / llama3.2-vision). Cost/latency/quality trade-off ADR.
5. **VISION-2** — Per-foto extraktor: machinery year/make/model/odometer/condition/damage assessment. Schema design.
6. **VISION-3** — UI integration: extrahovaná data viditelná v per-firma timeline + manual override flow.

**Acceptance:**
- [ ] Operator override rate baseline measurement (≥100 events accumulated)
- [ ] First foto ingestion → ≥80 % accuracy na year/make extrakce (manual ground-truth)
- [ ] AI navrh generator beat baseline klasifikátor v reply quality (operator-rated)

### Phase 4 — M+3 až M+6: WhatsApp + Cross-System Tracking

**Cíl:** WhatsApp Business API integration + cross-system pseudonymized tracking subject.

**Nové sprinty:**

1. **WA-1** — WhatsApp Business API setup (Meta Cloud API nebo on-prem alternativa). Authentication + webhook + message store.
2. **WA-2** — Per-firma WhatsApp linking: contact ID ↔ phone number. Manual matching + auto-discovery při shared identifier.
3. **WA-3** — Unified per-firma inbox: email + whatsapp na 1 timeline view, channel-aware reply UI.
4. **WA-4** — Multi-channel preference: per-contact "WhatsApp preferred" flag, channel routing.
5. **TRACK-1** — Pseudonymized subject identifier: deterministic hash z email/phone bez PII leak. Cross-domain (Garaaage portal + GA4 + Meta Ads) propagation.
6. **TRACK-2** — GDPR audit cross-system subject: explicit opt-in/out per channel, DSR access cascade rozšíření.
7. **TRACK-3** — UI: per-firma "Tracking timeline" — když navštívil Garaaage portal, klikl na ad, etc.

**Acceptance:**
- [ ] First whatsapp message → unified inbox bez channel switch v UI
- [ ] Cross-system: subject view email open → portal visit → ad click chain bez PII v logs
- [ ] DSR test: erase request → cascade across email + whatsapp + tracking → 100 % cleanup

### Phase 5 — M+6 až Year+1: Self-Learning Autonomy Ramp

**Cíl:** Operator override rate < 5 %. AI nepoznatelné od člověka. Plná autonomie.

**Nové sprinty:**

1. **LEARN-1** — Self-learning evaluation: quarterly metric `operator_override_rate` trend reporting.
2. **LEARN-2** — Fine-tune nebo prompt-tuning loop: accumulated dataset z APPROVE-2 → quarterly model retraining (lokální fine-tune nebo Anthropic prompt cache + few-shot improvement).
3. **LEARN-3** — A/B testing AI návrhů: 50/50 split AI vs operator-handed-off, measure reply rate + sentiment.
4. **LEARN-4** — Autonomy ramp gate: gradual increase v auto-send threshold (high-confidence replies bypass operator review s monitoring + rollback trigger).
5. **GARAAAGE-1** — Reply parse → technik dispatch automation: structured data → Garaaage portal listing API direct integration.
6. **GARAAAGE-2** — End-to-end pipeline trackable: reply → parse → technik fotí → portal listing → buyer match → sale → revenue attribution.
7. **AUDIT-FINAL** — Year+1 brutal-pass: full mutation testing, compliance audit, scaled load test (10 000+ contacts/měsíc).

**Acceptance:**
- [ ] Operator override rate quartely trend ≤ 5 pp (z baseline → ≤ 5 %)
- [ ] Reply rate AI vs human-baseline test: AI ≥ baseline (no detectable bot flag)
- [ ] Garaaage pipeline: ≥80 % replies → photo → listing → reálná revenue v < 48h median
- [ ] 1 operator full-time stačí na 200+ replies/den

---

## 6. Sprint catalog per phase

| Phase | Owner | Sprint count | Dependency |
|---|---|---|---|
| Phase 0 (D+0) | Operator + Chat A | KT-A1, KT-A2, KT-A3, KT-A4, KT-A5 (existující master plán) | — |
| Phase 1 (D+1-D+7) | Chat B | KT-B1 ✅, KT-B2 (blocked), KT-B3 ✅, KT-B4 ✅, KT-B5 (blocked Mail Lab) | Phase 0 |
| Phase 2 (D+7-M+1) | Chat A | OWN-SMTP-1/2/3, STORE-1/2/3 | Phase 1 |
| Phase 3 (M+1-M+3) | Mixed | APPROVE-1/2/3, VISION-1/2/3 | Phase 2 |
| Phase 4 (M+3-M+6) | Chat A | WA-1/2/3/4, TRACK-1/2/3 | Phase 3 |
| Phase 5 (M+6-Year+1) | Mixed | LEARN-1/2/3/4, GARAAAGE-1/2, AUDIT-FINAL | Phase 4 |

**Sprint detail dokumenty** — každá fáze získá vlastní initiative MD v `docs/initiatives/<datum>-<phase>-<slug>.md` při jeho aktivaci.

---

## 7. Risk register

| Riziko | Severity | Phase | Mitigace |
|---|---|---|---|
| Seznam zablokuje 24 mailboxů (anti-spam reputation) | HIGH | 0 | Warmup `vykup_24mb` 2→5→10→20/den/mailbox; reverse-DNS + SPF/DKIM strict; Mullvad CZ exit; per-mailbox throttling. Phase 2 OWN-SMTP-1/2/3 redukuje risk. |
| LLM classifier false-positive → wrong suppress | HIGH | 1 | Operator override v Phase 3 APPROVE-1; KT-B2 manual ground-truth. |
| Vlastní SMTP MX reputation zero → reject by recipients | HIGH | 2 | Slow ramp; SPF/DKIM/DMARC; warmup track per IP; option B: relay přes vetřená 3rd party (Postmark, Mailgun) v boot phase. |
| Vision LLM cost runaway (per-foto API call) | MEDIUM | 3 | Local Ollama vision model (llama3.2-vision) jako default; cloud LLM jen pro low-confidence cases. |
| WhatsApp Business API approval delay (Meta review) | MEDIUM | 4 | Submit for review v M+2 (před Phase 4 start); fallback na 3rd-party gateway (Twilio + WA Business). |
| Cross-system tracking GDPR sledabilita | HIGH | 4 | DSR cascade rozšíření; explicit consent UI; DPIA refresh per channel addition. |
| Self-learning model drift (recent corpus → over-fit) | MEDIUM | 5 | Quarterly retrain s rolling window; A/B test before deploy; rollback trigger. |
| Operator burnout při ramp 200+/den | MEDIUM | 5 | UI ergonomics: keyboard shortcuts, batch actions, confidence-based queue; auto-dispatch nejvyšší confidence. |

---

## 8. Open decisions (čeká user input)

| # | Otázka | Default if no answer | Blokuje |
|---|---|---|---|
| 1 | Sídlo Garaaage s.r.o. | musí dodat operator | Phase 0 KT-A2 |
| 2 | Privacy URL volba | preferred `garaaage.cz/privacy`; fallback `messingdev.github.io/garaaage-privacy/` | Phase 0 KT-A2 |
| 3 | 24 mailbox addresses (např. info@, vykup@, kontakt@, ...) | musí dodat operator | Phase 0 KT-A4 |
| 4 | Daily limit per mailbox při launch | 5/den (warmup-conservative), ramp na 20/den po D+7 | Phase 0 warmup config |
| 5 | Finální template text "katalog firem" | user draft existuje, čeká finalizace | Phase 0 KT-A2 |
| 6 | Phase 2 OWN-SMTP architecture: vlastní Postfix vs Go MTA vs hybrid | ADR rozhodnutí v Phase 1 závěr | Phase 2 start |
| 7 | Phase 2 STORE-1 backend: MinIO self-hosted vs Backblaze B2 vs Railway volume | ADR rozhodnutí v Phase 1 závěr | Phase 2 start |
| 8 | Phase 3 VISION model: cloud (GPT-4V/Claude) vs local (Ollama vision) | local-first per `feedback_no_external_services` rule | Phase 3 start |
| 9 | Phase 4 WhatsApp gateway: Meta Cloud direct vs Twilio vs alternativa | TBD per cost + reliability comparison | Phase 4 start |
| 10 | Self-learning approach: prompt-tuning vs LoRA fine-tune vs full fine-tune | prompt-tuning first, fine-tune jako future option | Phase 5 start |

---

## 9. Success metrics (per fáze)

### Phase 0 (D+0)
- 24 mailboxů live, password v DB
- 48 mailů odesláno (24 × 2/mailbox per `vykup_24mb` warmup day 1)
- 0 hard bounces v prvních 48
- Pre-flight + dry-run + send-test green

### Phase 1 (D+7)
- 95 %+ delivery rate na 20 contacts soft-launch
- ≤5 % bounce rate
- First reply zpracován operator triage flow
- LLM classifier accuracy baseline (manual ground-truth)

### Phase 2 (M+1)
- Vlastní MX live, ≥99 % uptime
- Schránka block test → žádný outage
- Photo attachment storage funkční (≥10 photos test)

### Phase 3 (M+3)
- Operator override rate baseline ≤30 % (po accumulated dataset)
- Vision LLM accuracy ≥80 % na year/make extrakce
- AI navrh generator beat klasifikátor (operator-rated)

### Phase 4 (M+6)
- WhatsApp inbox unified s email
- Cross-system tracking funkční bez PII leak
- DSR cascade test: 100 % cleanup

### Phase 5 (Year+1)
- Operator override rate ≤5 %
- Reply rate AI = human baseline
- Garaaage pipeline: ≥80 % replies → portal listing < 48h
- 1 operator full-time = 200+ replies/den

---

## 10. Příští 24-48h taktika (urgent → Phase 0)

### Co potřebuju od operátora (Tomáš) — ODPOVĚDĚT TEĎ

1. **Sídlo Garaaage s.r.o.** (adresa pro template footer)
2. **Privacy URL** (garaaage.cz/privacy nebo GH Pages?)
3. **24 mailbox adres** (např. info@, vykup@, kontakt@, prodej@, ...)
4. **Finální template text** (user draft pošle, nebo má aktuální `initial.tmpl` text bohatá enough?)

### Co provádím já (Chat A) hned po answers

Sprint **Phase 0 prep** — 4 paralelní agenty:

1. **Update template** `initial.tmpl` — finální text "katalog firem + výkup"
2. **Update master plán** — 2 mailboxy → 24 mailboxů (sprints KT-A4/A5/A6)
3. **Update warmup config** — 24-mailbox `vykup_24mb` curve (2 → 5 → 10 → 20/den postupně, 480/den fleet plateau)
4. **Update playbook** `kt-a4-mailbox-password-update.md` — 24 schránek SQL UPDATE script
5. **Pre-flight + dry-run + send-test** — sanity ověření 24-mailbox setup před real send

### Co provádí operator (Tomáš) v 90-min session

1. Schválí 17 security PRs přes `bash scripts/operator/security-batch-merge.sh`
2. Vytvoří 24 Seznam mailboxů + uloží passwords přes UI nebo SQL UPDATE
3. Doplní sídlo + privacy URL do template (review PR od Chat A)
4. Schválí Railway BFF deploy + nastaví UNSUBSCRIBE_BASE_URL env
5. Schválí kampaň send go-signal (po pre-flight + dry-run + send-test green)

### Po Phase 0 launch

- D+1: First replies začínají, operator manuální triage
- D+3: day-1 batch 48 mailů dokončen + warmup ramp postoupil na den 4 (5/mailbox = 120/den), 1. parse-evaluation cycle
- D+7: Phase 1 reply quality validation
- M+1: Phase 2 IMAP-independence sprint planning

---

## Reference

- Master 30-day plán: [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-master.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md)
- Phase 0 ops detail: [`docs/initiatives/2026-04-27-first-send-mvp.md`](../initiatives/2026-04-27-first-send-mvp.md)
- Audit consolidation 2026-04-30: [`docs/audits/2026-04-30-duplicate-hunt-deep.md`](../audits/2026-04-30-duplicate-hunt-deep.md)
- ADR-005 airtight: [`docs/decisions/ADR-005-airtight-dev-env.md`](../decisions/ADR-005-airtight-dev-env.md)
- Memory rules: `feedback_search_before_implement`, `feedback_spawn_first_solo_second`, `feedback_check_backlog_when_idle`
- GDPR: `docs/legal/privacy-notice.md`, `docs/legal/lia-direct-marketing.md`, `docs/legal/art30-register.md`

---

**Tento dokument je living** — každá fáze získá update při start/end. Phase 0 acceptance triggers Phase 1 sprint planning revize.
