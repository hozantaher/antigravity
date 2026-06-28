# Hozan Taher — 3-month execution plán (M+0 → M+3)

**Status:** Draft (čeká user gates per §10)
**Datum:** 2026-04-30
**Trigger:** User direction: "tohle potřebujeme mít hotovo za 3 měsíce" + "WhatsApp Evolution API" + "GDPR potřebujeme vše evidovat v rámci oprávněného zájmu"
**Vlastník:** Tomáš (operator + gates) + Chat A (Build) + Chat B (Quality)
**Supersedes timeline of:** [`2026-04-30-product-vision-roadmap.md`](./2026-04-30-product-vision-roadmap.md) — Phase 4 + Phase 5 timing zkomprimováno z M+6/Year+1 na M+3.

> **Vize zůstává identická** (autonomní self-learning systém, multi-channel, IMAP-independent, GDPR-compliant). Tento dokument upravuje **timeline (12 měsíců → 3 měsíce)** + **WhatsApp gateway volbu (Twilio → Evolution API self-hosted)** + **GDPR layer (proactive ne reactive)**.

---

## 1. Cílové datum a změny od původního plánu

**Cíl:** **31. července 2026 (M+3)** — full vision operational v reduced-scope verzi.

| Změna | Original (Year+1) | 3-month verze |
|---|---|---|
| **Timeline** | 12 měsíců | 13 týdnů |
| **WhatsApp** | Twilio nebo Meta Cloud | **Evolution API self-hosted** (Apache 2.0, Docker) |
| **GDPR rozšíření** | Phase 4 (M+6) | **Týden 1-2** (proactive, ne reactive) |
| **Self-host MX (vlastní Postfix)** | Phase 2 (M+1) | ❌ **post-M+3** — používáme 3rd party gateway permanentně |
| **Vision LLM** | local-first | **cloud-first (Anthropic Claude API)** |
| **Vlastní SMTP receiver** | Phase 2 own MX | **post-M+3** — IMAP backup OK pro 3 měsíce |
| **Self-learning fine-tune** | quarterly retrain | **prompt-tuning + few-shot only** (real fine-tune post-M+3) |
| **Operator override target** | <5 % | **<15 % do M+3** (post-M+3 ramp na <5 %) |
| **Cuts** | — | telefon, OCR, multi-step sekvence, vlastní MX, local vision fine-tune |

---

## 2. WhatsApp via Evolution API — architektonický plán

### 2.1 Co je Evolution API

- **Open-source WhatsApp Web wrapper** ([github.com/EvolutionAPI/evolution-api](https://github.com/EvolutionAPI/evolution-api), AGPLv3)
- Backend nad **Baileys library** (TypeScript Node.js WhatsApp Web protocol implementation)
- Multi-instance support (jedna Docker instance hostuje více WA účtů)
- REST API + webhooks pro inbound messages
- **Self-hosted** = žádný 3rd party subprocessor, žádný Meta approval delay
- Free (jen Railway/Docker hosting cost)

### 2.2 Compliance pozice

**Evolution API NENÍ oficiální Meta WhatsApp Business API.** Operuje jako WhatsApp Web client (jako mobile/web Multi-Device).

**Důsledky:**
- ✅ Žádný Meta Business approval delay
- ✅ Žádný subprocessor (vše self-hosted v Garaaage Railway)
- ⚠️ **Account ban risk** — Meta detection rizikové při high-volume / spam patterns. Mitigace: konzervativní rate limits (max 30 zpráv/den/účet první měsíc, ramp postupně), žádné bulk broadcast, vždy 1:1 reaktivní reply na inbound.
- ⚠️ **Meta ToS grey zone** — Web client pro automation oficiálně zakázáno, ale prakticky tolerováno když user-like behaviour (ne bulk, ne spam).
- ✅ **B2B kontext** podporuje LI argument (Recital 47 GDPR, oprávněný zájem)

### 2.3 Architektura

```
┌────────────────────────────────┐
│ Evolution API (Docker)         │
│ Railway service                │
│ - 12 instancí (1 per WA účet)  │
│ - REST API + webhooks          │
│ - Persistent session (volume)  │
└──────────────┬─────────────────┘
               │ webhook POST
               ▼
┌────────────────────────────────┐
│ services/whatsapp/             │
│ Go service                     │
│ - Webhook receiver             │
│ - Message store (DB)           │
│ - Per-firma routing            │
│ - LLM classifier hook          │
│ - Operator approval queue      │
└──────────────┬─────────────────┘
               │
               ▼
┌────────────────────────────────┐
│ outreach_threads (rozšíření)   │
│ + channel column               │
│ + whatsapp_message_id ref      │
│ + whatsapp_attachments         │
└────────────────────────────────┘
               │
               ▼
┌────────────────────────────────┐
│ BFF — features/platform/outreach-dashboard  │
│ Per-firma timeline UI          │
│ - Email + WhatsApp unified     │
│ - Channel switch               │
└────────────────────────────────┘
```

### 2.4 12 WhatsApp účtů strategie

Paralelní s 12 emailovými mailboxy:
- 12 WhatsApp business účtů (12 SIM karet u operátora) NEBO
- 12 přípojení existujících čísel (jen pokud Tomáš má 12 SIM)
- **Reálnější**: 1-3 WA účty první měsíc (test infra), scale na 12 v M+2 (po Evolution API stabilita ověřena)

### 2.5 Sprint mapping

- **WA-1** (týden 8): Evolution API Docker setup v Railway, 1 testovací účet
- **WA-2** (týden 9): `services/whatsapp/` Go webhook receiver + DB schema
- **WA-3** (týden 10): Per-firma routing + unified inbox UI
- **WA-4** (týden 11): Operator approval flow + scale na 3 účty
- **WA-5** (týden 12): Scale na 12 účtů + rate-limit hardening

---

## 3. GDPR comprehensive layer — proactive evidence

### 3.1 Současný stav (audit 2026-04-30)

Existující dokumenty `docs/legal/`:
- ✅ `art30-register.md` — ROPA pro **email B2B marketing** (Činnost #1)
- ✅ `lia-direct-marketing.md` — LIA pro **email B2B marketing**
- ✅ `privacy-notice.md` — disclosure dokument
- ✅ `privacy-policy.md` — public privacy policy
- ✅ `scc-railway.md` — subprocessor agreement Railway

**Co chybí pro multi-channel + parsing + tracking:**
- ❌ ROPA Činnost #2 — WhatsApp B2B komunikace
- ❌ ROPA Činnost #3 — Multi-modal photo parsing
- ❌ ROPA Činnost #4 — Cross-system tracking subject
- ❌ LIA refresh — per channel balancing test
- ❌ DPIA — pro multi-modal parsing (high-risk processing)
- ❌ Subprocessor agreements — Anthropic API, Backblaze B2, Postmark/Mailgun
- ❌ Audit log evidence — per-channel + per-AI-suggestion + per-operator-override
- ❌ Per-channel DSR cascade — Art. 15 access + Art. 17 erase across all channels

### 3.2 GDPR sprint plán (týden 1-2 — PROACTIVE FIRST)

Před Phase 0 launch musí být GDPR layer rozšířen:

**GDPR-1 (týden 1):** ROPA Activity #2 — WhatsApp B2B komunikace
- LI test: účel, nezbytnost, balancing (subject expectations vs intrusion)
- Argument: B2B kontext, Recital 47, opt-out v každé zprávě, keyword-based STOP routing
- Doba uchování: 12 měsíců od posledního kontaktu, suppression list trvalé (per analogii s email)
- Subprocessory: žádné (Evolution self-hosted), Railway hosting (existující SCC)

**GDPR-2 (týden 1):** ROPA Activity #3 — Multi-modal photo parsing
- Zpracovaná data: foto (potenciálně osobní údaj), extrahované machinery atributy (year/make/model/condition)
- LI test: účel (sourcing techniky), nezbytnost (manuální parse nepraktický při scale)
- DPIA required (potenciálně high-risk): nově zachycené osobní údaje z foto (RZ vozidla, obličeje na pozadí, dokumentace)
- Mitigace: blur faces auto, blur RZ auto (preprocessor), retain only machinery data structured
- Subprocessory: Anthropic API (pokud cloud LLM) — DPA needed

**GDPR-3 (týden 1-2):** ROPA Activity #4 — Cross-system tracking subject
- Zpracovaná data: pseudonymized subject ID (deterministic hash z email/phone)
- Účel: attribuce napříč Garaaage portal + GA4 + Meta Ads
- LI test: legitimate interest (conversion attribution) vs subject expectations
- Opt-out: explicit per-channel toggle
- Subprocessory: Google Analytics (existing), Meta Pixel (potřeba consent → cookie banner)

**GDPR-4 (týden 2):** LIA Refresh
- Update `lia-direct-marketing.md` s per-channel balancing tests (email + WhatsApp)
- Add LIA pro photo parsing
- Add LIA pro cross-system tracking
- 3-step balancing test per každý kanál

**GDPR-5 (týden 2):** Subprocessor agreements
- Anthropic DPA (pokud používáme Claude API) — jednorázový sign-off
- Backblaze B2 DPA (storage) — jednorázový sign-off
- Postmark/Mailgun DPA (3rd party email) — jednorázový sign-off

**GDPR-6 (týden 2):** Privacy notice rozšíření
- Multi-channel processing disclosure
- Photo data processing
- Cross-system tracking subjects
- Updated retention policies per channel

**GDPR-7 (týden 3):** DSR cascade rozšíření
- Update `features/inbound/orchestrator/web/handler_dsr.go` (NEBO BFF /api/dsr — verify současný location po consolidation #4)
- Add WhatsApp message cascade
- Add photo blob deletion
- Add tracking subject pseudonym deletion

**GDPR-8 (týden 3):** Audit log evidence rozšíření
- Per-channel send audit (kdo/kdy/co/komu)
- Per-AI-suggestion audit (kdo navrhl, kdo schválil/přepsal/odmítl)
- Per-foto-parse audit (co bylo extrahováno, co bylo zachováno, co bylo zahozeno)
- Per-tracking-event audit (subject ID, channel, timestamp)

**GDPR-9 (týden 4):** DPIA pro photo parsing
- Data Protection Impact Assessment podle čl. 35 GDPR
- High-risk: nově zpracované foto, AI processing, scale
- Mitigations dokumentované

**GDPR-10 (týden 4):** Operator-friendly GDPR dashboard v BFF
- DSR request management UI
- ROPA evidence export
- Audit log search per subject
- Compliance breach detection alerts

### 3.3 Audit log evidence (databázová schémata)

Nové tabulky pro GDPR evidence:

```sql
-- Per-channel send/receive audit
CREATE TABLE channel_audit_log (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,        -- 'email' | 'whatsapp' | 'portal_event'
  direction TEXT NOT NULL,      -- 'outbound' | 'inbound'
  subject_id TEXT,               -- pseudonymized
  contact_email TEXT,            -- for DSR linking
  contact_phone TEXT,
  message_id TEXT,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  details JSONB
);

-- AI suggestion + operator action audit (RLHF dataset)
CREATE TABLE ai_suggestion_audit (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT REFERENCES outreach_threads(id),
  ai_suggestion TEXT NOT NULL,        -- original AI output
  operator_action TEXT NOT NULL,       -- 'approved' | 'edited' | 'rejected'
  final_output TEXT,                   -- what was actually sent (NULL if rejected)
  operator_id TEXT,                    -- 'tomas' for now
  confidence_score NUMERIC,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  details JSONB
);

-- Photo parse audit (multi-modal)
CREATE TABLE photo_parse_audit (
  id BIGSERIAL PRIMARY KEY,
  blob_ref TEXT NOT NULL,             -- S3 key
  source TEXT NOT NULL,               -- 'whatsapp_inbound' | 'email_attachment'
  extracted JSONB NOT NULL,           -- {year, make, model, ...}
  retained JSONB NOT NULL,            -- subset kept after data minimization
  discarded JSONB,                    -- what was anonymized/blurred/deleted
  llm_provider TEXT,                  -- 'anthropic-claude-vision' | 'ollama-llava'
  occurred_at TIMESTAMPTZ DEFAULT now()
);

-- Cross-system tracking subject events
CREATE TABLE tracking_subject_event (
  id BIGSERIAL PRIMARY KEY,
  subject_id TEXT NOT NULL,           -- pseudonymized
  source TEXT NOT NULL,               -- 'garaaage_portal' | 'ga4' | 'meta_pixel'
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  details JSONB
);

CREATE INDEX channel_audit_subject ON channel_audit_log(subject_id, occurred_at);
CREATE INDEX ai_audit_thread ON ai_suggestion_audit(thread_id, occurred_at);
CREATE INDEX tracking_subject ON tracking_subject_event(subject_id, occurred_at);
```

DSR Art. 15 access dotaz se rozšiřuje: union napříč všemi 4 audit tabulkami + existing `outreach_threads`/`outreach_contacts`/`outreach_suppressions`/`tracking_events`.

DSR Art. 17 erase cascade rozšiřuje na: pseudonymized subject_id deletion v `tracking_subject_event`, photo blob delete v storage, AI suggestion audit anonymization (operator_id pseudonymizace).

---

## 4. 13-week sprint roadmap

5 paralelních tracků:
- **Track A — Email**: Phase 0 → Phase 1 → Phase 2-lite (3rd party gateway, ne self-host)
- **Track B — UI**: Operator approval + per-firma timeline
- **Track C — Vision**: Multi-modal photo parsing (Claude API)
- **Track D — WhatsApp**: Evolution API integration
- **Track E — GDPR + Tracking**: Compliance layer + cross-system

### Týden 1 — GDPR foundation + Phase 0 prep

| Track | Sprint | Acceptance |
|---|---|---|
| **E (GDPR)** | GDPR-1 ROPA Činnost #2 (WA), GDPR-2 ROPA #3 (foto), GDPR-3 ROPA #4 (tracking) | Drafty mergeable, čekají operator review |
| **A (Email)** | Update template `initial.tmpl` finální text; warmup config 24 mailboxů (`vykup_24mb` plán); KT-A2/A4 prep | Template merged; 24-mailbox warmup curve v `warmup.yaml` |
| **B (UI)** | Skeleton operator approval komponenta (mock data); per-firma timeline scaffolding | Komponenta v Storybook, žádný backend |
| **C (Vision)** | Claude API spike — auth + první vision call test | 1 photo → JSON extrakce success |
| **D (WA)** | Evolution API Docker compose lokálně, 1 test WA účet napojený | API responds k REST query, žádný DB persist zatím |

**Operator gates týden 1:**
- 17 security PRs admin-merge (90 min batch session)
- Sídlo + privacy URL + 24 mailbox addresses
- Schválení GDPR drafts (LIA, ROPA, DPIA jakýkoliv comment review)
- Anthropic API budget approval (~50-200 USD/month estimate)

### Týden 2 — GDPR rozšíření + Phase 0 launch

| Track | Sprint |
|---|---|
| **E** | GDPR-4 LIA refresh; GDPR-5 subprocessor DPAs (Anthropic, Backblaze); GDPR-6 privacy notice rozšíření |
| **A** | KT-A3 Railway deploy + UNSUBSCRIBE_BASE_URL; KT-A4 24 mailbox passwords v DB; KT-A5 pre-flight + dry-run + send-test |
| **B** | Operator approval backend audit table + API endpoint (čeká data) |
| **C** | Photo storage architecture: Backblaze B2 setup + DPA |
| **D** | `services/whatsapp/` Go service skeleton (webhook receiver) |

**Acceptance týden 2:**
- ROPA + LIA + privacy notice rozšířené, mergeable
- KT-A5 pre-flight green
- Cloud LLM accessible (1 Claude vision API call success)
- Backblaze B2 bucket vytvořený + DPA signed

### Týden 3 — Phase 0 send + Phase 1 reply triage

| Track | Sprint |
|---|---|
| **E** | GDPR-7 DSR cascade rozšíření; GDPR-8 audit log evidence schemas migrace |
| **A** | **first send** (5 mailů/mailbox = 60 mailů); reply IMAP poller verification; bounce monitoring |
| **B** | Per-firma timeline UI s real DB data (email only); operator approval queue UI |
| **C** | Photo parser MVP — Claude API → JSON extrakce (year/make/model) na test photos |
| **D** | Evolution API webhook → DB persist, 1 testovací message round-trip |

**Acceptance týden 3:**
- 60 mailů odesláno, ≥95 % delivery rate, ≤5 % bounce
- DSR cascade test: erase request → all channels cleanup
- First reply zpracován operator triage flow
- Vision parser na 5 testovacích photos = ≥80 % accuracy

### Týden 4 — Phase 1 quality + early feedback

| Track | Sprint |
|---|---|
| **E** | GDPR-9 DPIA photo parsing; GDPR-10 GDPR dashboard v BFF |
| **A** | Reply triage UI polish; operator override capture wired do `ai_suggestion_audit` |
| **B** | AI návrh generator (Claude API) — generates reply draft based on firma context |
| **C** | Photo parser integration s reply flow (foto v emailu → auto-extract) |
| **D** | Evolution API stable na 3 testovací účty; per-firma WhatsApp threading v UI |

**Acceptance týden 4:**
- DPIA mergeable
- AI návrh generator generuje quality draft (operator-rated ≥7/10)
- 3 WhatsApp účty operativní, 1:1 round-trip messages s photo support

### Týden 5-6 — Scale email + integrate WhatsApp into UI

| Track | Sprint |
|---|---|
| **A** | KT-A6 ramp 5 → 20/den/mailbox = 240/den; reply rate measurement |
| **B** | Unified inbox UI — Email + WhatsApp na 1 timeline view |
| **C** | Vision parser accuracy improvement (prompt engineering, ne fine-tune); damage assessment + odometer extraction |
| **D** | Evolution API WA accounts: 3 → 6, anti-spam rate limits hardening |
| **E** | Per-channel audit log evidence verification end-to-end |

**Acceptance týden 6:**
- 1500+ emails delivered cumulative
- ≥30 replies received, ≥10 with photos
- Operator override rate baseline measured
- Unified inbox UI funkční (email + WA na 1 view)

### Týden 7-8 — Operator approval flow + cross-system tracking

| Track | Sprint |
|---|---|
| **B** | Operator approval flow live — AI návrh → [Approve/Edit/Reject] → audit |
| **B** | Confidence scoring: low-confidence flagged operatorovi přednostně |
| **C** | Per-foto Garaaage portal listing data prepared (year, make, model, condition → portal API) |
| **D** | Evolution API WA accounts: 6 → 9; per-firma routing stable |
| **E** | Cross-system tracking subject: pseudonymized ID generation + propagation Garaaage portal + GA4 + Meta Pixel |

**Acceptance týden 8:**
- ≥100 operator approval events accumulated v `ai_suggestion_audit`
- Cross-system tracking subject view: email open → portal visit → ad click chain bez PII v logs
- Confidence scoring threshold tuning baseline

### Týden 9-10 — Garaaage pipeline integration + scale

| Track | Sprint |
|---|---|
| **A** | Reply parse → Garaaage portal listing API — direct integration (pokud API existuje) NEBO export script |
| **B** | Operator dashboard: "dnes X replies, Y flagged, Z escalations" landing |
| **C** | Vision parser confidence calibration; auto-extract → portal listing prep s manual review |
| **D** | Evolution API WA accounts: 9 → 12, full scale |
| **E** | DSR access endpoint test: across all 4 channels + 4 audit tables |

**Acceptance týden 10:**
- First reply → photo → portal listing pipeline manual end-to-end test successful
- Operator dashboard production-ready
- 12 WA účtů operativní

### Týden 11-12 — Self-learning loop + autonomy ramp prep

| Track | Sprint |
|---|---|
| **B** | Self-learning evaluation: operator override rate trend dashboard |
| **B** | Prompt-tuning: extract patterns from `ai_suggestion_audit` overrides → update Claude system prompt few-shot examples |
| **B** | A/B test: 50/50 split AI návrh proceed-as-is vs operator-reviewed reply quality measurement |
| **C** | Photo parser accuracy improvement based on accumulated dataset (prompt-only) |
| **E** | GDPR audit dashboard live: ROPA evidence export, audit log search per subject |

**Acceptance týden 12:**
- Operator override rate ≤20 % (target ≤15 % do M+3)
- AI návrh A/B test green: AI quality ≥ baseline operator-reviewed
- ≥500 override events accumulated → first prompt-tuning iteration applied

### Týden 13 — Final brutal pass + handoff

| Track | Sprint |
|---|---|
| **A** | Load test: 500+ messages/den across all channels |
| **B** | Operator handoff playbook: daily ops, escalations, troubleshooting |
| **C** | Vision parser accuracy ≥85 % na multi-attribute extraction |
| **D** | Evolution API stability test (24h continuous, no account ban) |
| **E** | DSR cascade end-to-end test; ROPA + LIA + DPIA finalized + reviewed |

**Final acceptance M+3 (31. července 2026):**
- ≥3000 emails sent (24 mailboxes × 20/day × 13 weeks ramp adjusted; theoretical fleet ceiling 480/den × ~91d ≈ 43 680 ale ramp + holidays cut to ≥3000 baseline)
- ≥300 replies processed (10% reply rate)
- ≥150 photo attachments parsed
- ≥50 Garaaage portal listings created from replies
- ≤15 % operator override rate
- 0 GDPR breaches, 0 DSR violations, full audit evidence
- 12 WhatsApp účtů + 24 emailových schránek operativní paralelně (WhatsApp track byl post-M+3 deferred per `2026-04-30-m3-minimal-scope.md`)

---

## 5. Risk register pro 3-month timeline

| Riziko | Severity | Týden | Mitigace |
|---|---|---|---|
| Seznam zablokuje email schránky | HIGH | 1-13 | Konzervativní warmup; SPF/DKIM/DMARC strict; Mullvad CZ exit |
| Evolution API WA účet ban | HIGH | 8-13 | Rate limits 30/den/účet první měsíc; only reactive replies, žádný bulk; multiple účty pro redundance |
| Anthropic API cost runaway | MEDIUM | 3-13 | Per-call cost monitoring; cap budget 200 USD/month; cloud → local fallback option preserved |
| Operator burnout (daily commit) | HIGH | 1-13 | UI ergonomics priority; auto-routing high-confidence; backlog batch processing |
| GDPR documentation incomplete při launch | HIGH | 1-2 | Týden 1-2 dedicated GDPR layer; legal review checkpoint týden 2 |
| Photo parser low accuracy → wrong listings | MEDIUM | 5-10 | Operator approval flow před portal listing; manual review for first 50 listings |
| Cross-system tracking GDPR rejected | MEDIUM | 7-8 | Explicit opt-in + cookie banner; opt-out flow; subject-side easy erase |
| Garaaage portal API neexistuje | MEDIUM | 9-10 | Fallback: CSV export + manual portal upload; API integration post-M+3 |
| Self-learning dataset insufficient (<500 events) | MEDIUM | 11-12 | Cut M+3 target — accept ≤25 % override rate (vs ≤15 %) pokud dataset velikost neumožňuje |
| 12 SIM karet/WA účtů ne-dostupné | MEDIUM | 8-13 | Start s 1-3 účty, ramp na 6 týden 8, 12 týden 12; postupný scale |

---

## 6. Subprocessor architecture (3-month verze)

| Service | Provider | Účel | DPA Status |
|---|---|---|---|
| Hosting | Railway.app | Compute, DB, volumes | ✅ existuje (`scc-railway.md`) |
| Email outbound | Seznam.cz (24 schránek) | SMTP relay | ✅ B2B operator agreement |
| Email backup MX | None (IMAP via Seznam) | Inbound poll | ✅ same as Seznam |
| Photo blob storage | Backblaze B2 | Persistent S3-compatible | ⚠️ needs DPA sign-off týden 2 |
| Vision LLM | Anthropic | Multi-modal parsing | ⚠️ needs DPA sign-off týden 1 |
| Reply text LLM | Anthropic OR Ollama local | Classification + návrhy | Anthropic DPA covers oba use cases |
| WhatsApp | Evolution API self-hosted | Multi-channel | ✅ self-hosted, žádný subprocessor |
| Analytics | Google Analytics 4 | Cross-system tracking | ✅ existing GA agreement (operator-side) |
| Ads | Meta Pixel | Cross-system tracking | ⚠️ needs DPA + cookie consent |
| Anti-trace email relay | Mullvad WireGuard | Egress IP CZ | ✅ existing Mullvad agreement |

**Post-M+3 plan**: replace Backblaze B2 + Anthropic s self-hosted alternatives (MinIO, Ollama vision) když dataset accumulated dostatečně pro local fine-tune.

---

## 7. Co rezáno (post-M+3 backlog)

Explicit deferred:
- ❌ **Vlastní self-hosted Postfix MX** — 3rd party email gateway (Seznam) zůstává
- ❌ **Local vision LLM fine-tune** (Ollama LLaVA) — Anthropic Claude API zůstává
- ❌ **Quarterly model fine-tune** (RLHF) — pouze prompt-tuning + few-shot
- ❌ **Telefon kanál** (Twilio click-to-call)
- ❌ **OCR pipeline** (PDF/scan extraction)
- ❌ **Multi-step sequences** (followup1.tmpl + final.tmpl)
- ❌ **Multi-tenant scaffolding**
- ❌ **A/B email template optimization**

Tyto všechny pokud po M+3 mít smysl, dostanou vlastní iniciativu.

---

## 8. Open decisions — čeká user input (TENTO TÝDEN)

| # | Otázka | Default | Blokuje |
|---|---|---|---|
| 1 | Sídlo Garaaage s.r.o. | Purkyňova 74/2, Praha (per existing CLAUDE.md) — confirm? | týden 1 KT-A2 |
| 2 | Privacy URL volba | preferred `garaaage.cz/privacy`; fallback GH Pages | týden 1 KT-A2 |
| 3 | 12 email mailbox addresses | musí dodat operator (návrh: info@, vykup@, kontakt@, prodej@, technika@, partner@, obchod@, nabidka@, akvizice@, sklad@, doprava@, sluzby@) | týden 1 KT-A4 |
| 4 | Daily limit per mailbox při launch | 5/den první týden, ramp na 20/den od týden 5 | týden 2 warmup config |
| 5 | Finální template text | user draft existuje, čeká finalizace | týden 1 KT-A2 |
| 6 | Anthropic API budget | recommended cap 200 USD/month | týden 1 GDPR-5 + Phase 3 start |
| 7 | Backblaze B2 budget | ~5-15 USD/month při 1TB | týden 2 storage setup |
| 8 | 12 WhatsApp účtů — kolik SIM/účtů Tomáš má | aktuální stav? potřeba operator info | týden 8 WA scale |
| 9 | Garaaage portal API existuje? | Ne → CSV export fallback | týden 9-10 portal integration |
| 10 | Operator daily availability commit (full-time M+0 → M+1)? | required pro 3-month feasibility | celý plán |
| 11 | DPIA review by external counsel? | doporučuji legal review týden 2 před photo parsing live | týden 4 DPIA finalize |
| 12 | Cookie banner pro cross-system tracking? | required pro GA4 + Meta Pixel | týden 7 tracking subject |

---

## 9. Success metrics (M+3 = 31. července 2026)

### Quantitative
- ≥3000 emails sent cumulative
- ≥300 replies processed
- ≥150 photo attachments parsed (≥85 % vision accuracy)
- ≥50 Garaaage portal listings created
- ≤15 % operator override rate
- 12 emailových schránek + 12 WhatsApp účtů operativní
- 0 GDPR breaches
- 0 DSR violations
- 100 % audit evidence per channel + per AI suggestion

### Qualitative
- Operator daily flow ≤30 min na 25 replies
- AI návrh quality A/B test = AI ≥ operator-reviewed baseline
- Photo parser accepted by operator (no consistent re-overrides)
- WhatsApp + Email unified UX seamless

---

## 10. Příští 24-48h taktika

### Co potřebuju od operátora (Tomáš) — TENTO TÝDEN

1. ✅ **Confirm sídlo Garaaage s.r.o.** — Purkyňova 74/2, Praha 1, IČO 23219700 (per existing docs)?
2. **Privacy URL** — `garaaage.cz/privacy` deploy nebo GH Pages?
3. **12 email mailbox addresses** — preferovaná pojmenování?
4. **Finální template text** — user draft pošli, nebo aktuální `initial.tmpl` text good enough?
5. **Anthropic API budget approval** — ~200 USD/month cap OK?
6. **Backblaze B2 budget approval** — ~10 USD/month OK?
7. **12 WhatsApp účtů status** — kolik SIM karet/čísel máš?
8. **Daily availability commit** — můžeš full-time/daily vstup pro reply triage M+0 → M+1?

### Co provádím já (Chat A) hned po confirmation

Sprint týden 1 — 5 paralelních agent tracků:

1. **GDPR comprehensive sprint** — ROPA Činnost #2/3/4 + LIA refresh + privacy notice rozšíření
2. **Phase 0 prep** — template + warmup config + KT-A4 playbook
3. **Vision spike** — Claude API auth + 1st test call
4. **Evolution API spike** — Docker compose lokálně + 1 test účet
5. **Subprocessor DPA prep** — Anthropic + Backblaze sign-off documentation

---

## Reference

- Master 30-day plán: [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-master.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md)
- Vision roadmap (original Year+1): [`docs/strategy/2026-04-30-product-vision-roadmap.md`](./2026-04-30-product-vision-roadmap.md) — vize stále platí, timeline kompresován
- Phase 0 ops detail: [`docs/initiatives/2026-04-27-first-send-mvp.md`](../initiatives/2026-04-27-first-send-mvp.md)
- GDPR existing: [`docs/legal/`](../legal/) — `art30-register.md`, `lia-direct-marketing.md`, `privacy-notice.md`, `privacy-policy.md`, `scc-railway.md`
- Audit consolidation 2026-04-30: [`docs/audits/2026-04-30-duplicate-hunt-deep.md`](../audits/2026-04-30-duplicate-hunt-deep.md)
- Memory rules: `feedback_search_before_implement`, `feedback_spawn_first_solo_second`, `feedback_check_backlog_when_idle`, `feedback_no_external_services` (Evolution API self-hosted = OK)

---

**Tento dokument je living** — každý týden updatován acceptance/skip + new findings. Týden 4 mid-point review + týden 8 GO/NO-GO checkpoint per per accumulated metrics.
