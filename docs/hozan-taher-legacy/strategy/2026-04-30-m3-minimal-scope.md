# M+3 Minimal Scope — strict-cut execution plan

**Status:** Active (supersedes scope-relevant parts of [3-month execution plan](./2026-04-30-3-month-execution-plan.md))
**Datum:** 2026-04-30
**Trigger:** User direction: "potřebujeme vlastní self-learning systém s OOLAMA, jinak budeme platit raketu" + "žádná třetí strana, máme railway" + "neřeš whatsapp, to bude druhá fáze" + "neřeš hovna mimo náš systém"

> Cíl: **maximálně self-contained MVP do 31. července 2026**. Žádné cloud LLM, žádný 3rd party storage, žádný external tracking, žádné multi-channel. Email + Ollama + Railway, basta.

---

## 1. Strict scope (M+3)

### V scope

- **Email outreach** — 24 mailboxů Seznam, kampaň výkupu techniky
- **Reply triage** — IMAP poll → klasifikace (Ollama local) → operator queue
- **AI návrh generator** — Ollama lokální → operator approval flow
- **Photo parsing** — Ollama vision (llama3.2-vision nebo LLaVA) → structured machinery atributy
- **Operator approval UI** — per-firma timeline + AI návrh + [Approve/Edit/Reject]
- **Self-learning loop** — accumulated dataset → prompt-tuning Ollama (lokálně)
- **GDPR minimal** — ROPA + LIA + privacy notice + audit log evidence (existing docs rozšíříme jen o vnitřní processing, žádný DPIA, žádný cookie banner)

### Mimo scope (post-M+3)

- ❌ **WhatsApp** (Evolution API) — Phase 2, až bude email pipeline 100% solid
- ❌ **Cloud LLM** (Anthropic, OpenAI) — Ollama-only
- ❌ **3rd party storage** (Backblaze, S3, MinIO external) — Railway volume nebo Postgres bytea
- ❌ **Cross-system tracking** (Meta Pixel, GA4) — žádné external integrations
- ❌ **DPIA** (čl. 35 GDPR) — operator-internal, ne externí counsel
- ❌ **Cookie banner / consent management** — žádné externí trackery k řešení
- ❌ **Garaaage portal API integration** — manual export do M+3, integration later
- ❌ **Vlastní MX self-host** — IMAP přes Seznam zůstává
- ❌ **Telefon kanál, OCR pipeline, multi-step sequences, multi-tenant**

---

## 2. Architektura — 100% self-contained

### LLM stack (Ollama local)

| Use case | Model | Cíl |
|---|---|---|
| Reply text classifier | `llama3.2:3b` (text) | 6 kategorií (interested/meeting/later/objection/negative/ooo) |
| AI návrh generator | `llama3.2:3b` (text) s few-shot examples | Generuje reply draft pro operator review |
| Photo parsing (vision) | `llama3.2-vision:11b` | year/make/model/condition/odometer extrakce |

**Hosting:** Railway compute (CPU) v separátní službě `features/platform/llm-runner` (Go HTTP wrapper) + `features/platform/ollama` (raw Ollama daemon). Architektura ratifikována v [**ADR-006 — Ollama Railway deployment**](../decisions/ADR-006-ollama-railway-deployment.md). Latence nekritická (batch processing, ne realtime), CPU stačí pro Phase 0-3.

**Self-learning:** quarterly nebo per-N-overrides Ollama prompt-tuning přes `features/platform/llm-runner`. Žádný retrain, jen prompt update + few-shot example accumulation.

### Storage

| Data | Kde | Jak |
|---|---|---|
| Threads + messages | Postgres (existing `outreach_threads`, `outreach_messages`) | beze změny |
| Email attachments (small) | Postgres `bytea` column nebo `attachments_blob` table | < 5 MB inline; >5 MB → Railway volume |
| Photo attachments (replies) | Railway volume `/data/photos/{thread_id}/{message_id}/{name}` | persistent disk |
| AI návrhy + operator overrides | nové tabulky `ai_suggestion_audit`, `photo_parse_audit` | Postgres jen |
| Audit logs | nové tabulky `channel_audit_log`, `tracking_subject_event` (only internal portal events later) | Postgres jen |

**Žádný S3, žádný Backblaze, žádné MinIO external.** Pokud Railway volume kapacita nestačí post-M+3, decision later.

### GDPR layer (minimal)

V scope (proactive týden 1-2):
- ROPA Činnost #2 — interní photo parsing (Ollama lokální = žádný subprocessor change)
- LIA refresh — email LI základ stačí + dodáme krátký refresh per Recital 47
- Audit log evidence schemas — `ai_suggestion_audit`, `photo_parse_audit`, `channel_audit_log`
- DSR cascade rozšíření přes nové tabulky

Mimo scope (post-M+3):
- DPIA (čl. 35) — internal review, ne external counsel; připravíme template, finalize až s legal counsel post-M+3
- Cookie banner — žádný external tracking v M+3, takže banner nepotřebujeme
- Cross-system tracking ROPA — žádný GA4/Meta integrace v M+3

---

## 3. 13-week roadmap (compressed, 4 paralelní tracky)

| Track | Cíl |
|---|---|
| **A — Email** | 24 mailboxů launch, scale 2 → 20/den/mailbox (480/den max), reply triage |
| **B — UI** | Per-firma timeline + operator approval flow + AI návrh queue |
| **C — Ollama** | Self-hosted runner v Railway, text + vision, prompt-tuning loop |
| **E — GDPR + Audit** | ROPA + LIA refresh, audit log schemas, DSR cascade |

(Track D **WhatsApp explicitly REMOVED** z M+3 scope.)

### Týden 1 — Foundation

- **A**: Update template `initial.tmpl` per user phrasing; warmup config 24 mailboxů (`vykup_24mb` plán); KT-A2/A4 prep
- **B**: Skeleton operator approval komponenta + per-firma timeline (mock data)
- **C**: Ollama Docker setup v Railway, `llama3.2:3b` running, REST API health check; prvý vision call test s `llama3.2-vision:11b`
- **E**: ROPA Činnost #2 (interní photo parse), LIA refresh, audit log schema migration draft

**Operator týden 1:**
- 17 security PRs admin-merge (90 min)
- Confirm sídlo + privacy URL OK (✅ confirmed)
- 24 Seznam mailboxů založit (operator side)
- Schválit GDPR docs draft (~30 min review)

### Týden 2 — Phase 0 launch

- **A**: KT-A3 Railway deploy + UNSUBSCRIBE_BASE_URL; KT-A4 24 mailbox passwords v DB; KT-A5 pre-flight + dry-run + send-test
- **B**: Operator approval backend audit table + API endpoint
- **C**: Ollama prompt-tuning iteration loop scaffolding
- **E**: Privacy notice rozšíření, audit log schemas migrace applied

**Acceptance týden 2:**
- 48 mailů odesláno první den (24 × 2/mailbox per `vykup_24mb` warmup curve)
- Ollama text + vision live na Railway
- Operator approval audit table writable

### Týden 3-4 — Reply triage + Photo parsing wired

- **A**: Reply IMAP poll verification, bounce monitoring, first batch replies (warmup ramp dosáhne 5/mailbox = 120/den od day 4, 10/mailbox = 240/den od day 8)
- **B**: AI návrh generator UI (Ollama-backed) + per-firma timeline real data
- **C**: Photo parser integration s reply flow — first attachment → Ollama vision → JSON struct
- **E**: DSR cascade rozšíření

**Acceptance týden 4:**
- ≥30 replies triaged operator
- ≥10 photo attachments parsed, ≥80% accuracy na year/make
- Operator override capture wired do `ai_suggestion_audit`

### Týden 5-6 — Scale + override capture

- **A**: KT-A6 ramp 10 → 20/den/mailbox = 480/den max (warmup `vykup_24mb` plateau po day 15)
- **B**: Operator approval flow live, confidence scoring
- **C**: Ollama prompt update s accumulated few-shot examples
- **E**: Per-channel audit log evidence verification

**Acceptance týden 6:**
- 1500+ emails delivered cumulative
- ≥100 operator override events
- Override rate baseline measured

### Týden 7-9 — Self-learning loop + accuracy iteration

- **A**: Stable scale, monitor reply rate trend
- **B**: AI návrh A/B test (AI-as-is vs operator-reviewed)
- **C**: Prompt-tuning iterations based on overrides; vision parser accuracy improvement
- **E**: GDPR audit dashboard v BFF

**Acceptance týden 9:**
- Override rate ≤25 %
- AI návrh quality ≥ operator-reviewed baseline (A/B test)

### Týden 10-12 — Garaaage pipeline manual + portal export

- **A**: Reply parse → manual CSV export pro Garaaage portal
- **B**: Operator dashboard polish (today's queue, escalations, daily metrics)
- **C**: Self-learning eval metrics dashboard
- **E**: DSR cascade end-to-end test

**Acceptance týden 12:**
- ≥50 replies → manual portal export
- Override rate ≤20 %
- DSR Art. 15 + 17 across all 4 audit tables green

### Týden 13 — Brutal final pass

- **A**: Load test, 24h stability
- **B**: Operator handoff playbook (daily ops, escalations)
- **C**: Vision parser ≥85% accuracy multi-attribute
- **E**: GDPR documentation review final

**M+3 final acceptance (31. července 2026):**
- ≥3000 emails sent
- ≥300 replies processed
- ≥150 photo attachments parsed
- ≥50 portal-ready exports
- ≤20% operator override rate
- 0 GDPR breaches, full audit evidence
- 24 emailových schránek operativní, Ollama stable

---

## 4. Open decisions (vyřešeno + remaining)

| # | Otázka | Status |
|---|---|---|
| 1 | Sídlo Garaaage s.r.o. | ✅ Confirmed Purkyňova 74/2, Praha 1 |
| 2 | Privacy URL | ✅ `garaaage.cz/privacy` |
| 3 | 24 mailbox addresses | ✅ Operator založí, names neřeším |
| 4 | Finální template text | ✅ Generuji placeholder (viz §5), finalize před send |
| 5 | LLM stack | ✅ **Ollama local-only** (žádný cloud) |
| 6 | Storage backend | ✅ **Railway volume + Postgres bytea** (žádný 3rd party) |
| 7 | WhatsApp | ✅ **Post-M+3** |
| 8 | Daily availability commit | ✅ Confirmed |
| 9 | Garaaage portal API | ⚠️ Post-M+3 (manual CSV export do M+3) |
| 10 | DPIA | ❌ Mimo scope (post-M+3 internal review) |
| 11 | Cookie banner | ❌ Mimo scope (žádný external tracking v M+3) |

---

## 5. Generated template (placeholder, finalize před send)

Aktuální `initial.tmpl` je solidní. Generuji aktualizovanou verzi která kombinuje user draft + existing footer pattern:

```
{{/* humanize: off */}}
{{/* subject: Výkup techniky — kontakt z firmy.cz */}}
{{/* subject: Máte na dvorku techniku k odprodeji? */}}
{{/* subject: Výkup použité techniky — Garaaage */}}

Dobrý den,

získal jsem na Vás kontakt v katalogu firem (firmy.cz) v rámci našeho zájmu o sourcing použité stavební a manipulační techniky.

Chtěl jsem se zeptat, zda-li Vám v současné chvíli na dvorku nestojí nějaká technika (vozidlo, kamion, bagr, nakladač, traktor...), které byste se rád zbavil, nebo zda neplánujete v dohledné době výměnu vozového parku.

Pokud ano — pošlete mi prosím fotku a TP (i kopii postačuje) na tento e-mail. Pošlu k Vám technika, který techniku osobně nafotí a zařadíme ji do aukční platformy Garaaage. Bez poplatků, bez vyjednávání s pěti lidmi — kupci proti sobě nabízí cenu, vy dostanete nejvyšší nabídku.

Případně volejte 776 299 933.

Děkuji za odpověď,
B. Maarek
Garaaage

---
Obchodní sdělení odesílatele Garaaage s.r.o., IČO 23219700,
sídlem Purkyňova 74/2, 110 00 Praha 1. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou aukční služby
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP nebo klikněte: {{.UnsubURL}}
Privacy policy: https://garaaage.cz/privacy
```

**Změny vs current**:
- Subject options přepsané česky s diakritikou (current je bez diakritiky)
- Body: explicit "získal jsem kontakt z firmy.cz" (per user draft)
- Body: explicit "vozidlo, kamion, bagr, nakladač, traktor" (širší enumerace)
- Body: explicit "TP" upload + "pošlu technika" workflow (per user description)
- Footer: privacy URL `garaaage.cz/privacy` (NE outreach.garaaage.cz)
- Footer: jasnější LI argumentace s Recital 47 reference

---

## 6. Co provádím dnes paralelně (po user confirm)

Spawn 4 agentů (jeden per track):

1. **Track A agent** — Update `initial.tmpl` na verzi v §5; update `warmup.yaml` na 24-mailbox `vykup_24mb` curve; update master plan KT-A4/A5 references
2. **Track B agent** — Operator approval UI scaffolding (per-firma timeline + AI suggestion queue mock)
3. **Track C agent** — Ollama Docker setup design ADR (Railway service vs sidecar; model selection llama3.2:3b text + llama3.2-vision:11b)
4. **Track E agent** — ROPA Činnost #2 internal photo parse + LIA refresh + audit log schema migrace draft

Žádný **WhatsApp track**. Žádný **cloud LLM**. Žádný **3rd party storage**.

---

## 7. Reference

- 3-month plán (PR #413): [`2026-04-30-3-month-execution-plan.md`](./2026-04-30-3-month-execution-plan.md) — supersededo timing/scope těmto cuts; vize stále platí
- Vision roadmap (PR #412): [`2026-04-30-product-vision-roadmap.md`](./2026-04-30-product-vision-roadmap.md) — Year+1 vision, dlouhodobé
- Master 30-day: [`docs/initiatives/2026-04-30-kampan-vykupu-techniky-master.md`](../initiatives/2026-04-30-kampan-vykupu-techniky-master.md)
- GDPR existing: `docs/legal/{art30-register, lia-direct-marketing, privacy-notice, privacy-policy, scc-railway}.md`
- Memory: `feedback_no_external_services` (alignment! self-hosted only)

---

**Living dokument** — týden 1, 2, 4, 8, 12 review checkpoints.
