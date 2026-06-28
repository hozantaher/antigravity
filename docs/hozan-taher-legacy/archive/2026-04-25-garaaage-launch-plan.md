# Garaaage Launch Plan — Sprint Sequencing

> **Cíl**: Spustit první ostré odeslání emailové kampaně pro aukční portál Garaaage, postavit pod ní compliance + technické základy, a připravit cestu ke škálování.
> **Datum**: 2026-04-25
> **Stav**: rozpracováno; campaign 455 v DB s 20 enrolled contacts, čeká na S0 compliance + S1 activate.
> **Branch**: `feat/brownfield-hardening-2026-04-25` (PR #25)
> **Living document** — aktualizovat po dokončení každého sprintu.

---

## Kontext

Existing campaign `id=455` v produkční DB:
- 20 unique-email kontaktů z machinery-relevant industry tagů
- Status: `draft` (nezaktivováno)
- Template: Garaaage auction angle, sign "B. Maarek", `humanize: off`
- Mailboxy `mb=631`, `mb=632` ready (active, password set 19 chars)
- Personas table populated z `display_name`

Gap analýza identifikovala dvě úrovně:
1. **Pre-send legal blockery** — bez compliance footru hrozí ÚOOÚ fine 50–600k Kč při single complaint (§7 Zákona 480/2004 + GDPR čl. 13/14/21).
2. **Architectural debt** — UI/BFF nedělá enrollment, kampaň 455 byla vytvořena přes SQL bypass (Cesta A). Cesta B (BFF↔Go bridge) odložena za první send.

Tento plán prioritizuje sprinty tak, aby:
- **S0** odstranilo pre-send legal landmines
- **S1** pustilo prvních 20 sendů live
- **S2–S5** zhardenily systém pro stable provoz
- **S6** připravilo scaling pro 50+/měsíc

---

## Sprint inventář (priority-sorted)

| Sprint | Goal | Blocks | Effort | Owner | Status |
|---|---|---|---|---|---|
| **S0** | Compliance pre-launch | S1 | 2–3h | Claude+Op | not started |
| **S1** | First send (20 contacts live) | S2,S3,S4,S5 retro signal | 1–2h | Op+Claude | blocked by S0 |
| **S2** | GDPR rights endpoints + S1 retro | scaling sustainability | 1 den | Claude | blocked by S1 |
| **S3** | Cesta B: BFF→Go enrollment bridge | future-campaign UI flow | 2–3 dny | Claude | parallel with S2 |
| **S4** | Security hardening | scale ≥50/měsíc | 1–2 dny | Claude | parallel |
| **S5** | Data quality + maintenance debt | nothing critical | 1–2 dny | Claude | parallel |
| **S6** | Scale-readiness | ramp ≥50 sends/měsíc | 2–3 dny | Claude+Op | when needed |
| **S7** | Garaaage product (out of code scope) | reply ingestion | open | Op | ongoing |

---

# S0 — Compliance pre-launch

## Cíl
Legally-safe odeslání kampaně 455. Bez tohoto sprintu single complaint = ÚOOÚ fine.

## Vstupy
- Operátor: IČO Garaaage s.r.o., sídlo, business phone (whether to use 776 299 933 or different)
- Operátor: privacy policy text (1 stránka MVP) nebo souhlas že napíšu draft
- Existing: campaign 455, mailbox creds, persona table, suppression UNION compliance (commit `e000fb9`)

## Scope (deliverables)

### S0.1 — Compliance footer v template
**File**: `features/outreach/campaigns/configs/templates/initial.tmpl`
**Add**:
```
---
Obchodní sdělení odesílatele Garaaage s.r.o., IČO XXXXXXXX,
sídlem [ADRESA]. Váš kontakt jsme získali z veřejného registru
firmy.cz pro účel oslovení s nabídkou aukční služby (oprávněný
zájem dle čl. 6(1)(f) GDPR).

Nepřejete-li si další zprávy, odpovězte STOP nebo klikněte:
{{.UnsubURL}}

Privacy policy: https://garaaage.cz/privacy
```

**Resolves**: §7(4) CZ identifikace + label + opt-out, GDPR čl. 13/14/21.

### S0.2 — Per-recipient unsub token
**Files**:
- `features/outreach/campaigns/sender/engine.go` — SendRequest struct: `+ UnsubToken string`
- `features/outreach/campaigns/campaign/runner.go` — Enqueue loop: generate token from `(send_event_id|email_hash|secret)`
- `features/outreach/campaigns/content/template.go` — TemplateVars: `+ UnsubURL string`
- Runner pre-render: build `UnsubURL = base + "/unsubscribe?t=" + token`

**Token format**: HMAC-SHA256 over (campaign_id, contact_id, mailbox) truncated to 16 chars hex. Determinístický (re-render same tick = same token), nezveřejní email-hash.

### S0.3 — BFF /api/unsubscribe endpoint
**File**: `features/platform/outreach-dashboard/server.js`
**Add**:
- `GET /unsubscribe?t=TOKEN` — public, no auth
- Validate token (recover campaign_id+contact_id+mailbox via HMAC verify)
- Lookup contact email via contact_id
- Insert into `suppression_list` with `reason='link_optout'`
- Update `contacts.status = 'unsubscribed'`
- Return rendered "You have been unsubscribed" page (HTML inline)
- Audit log entry

**Rate limit**: 10 req/min per IP (anti-abuse).

### S0.4 — Privacy policy minimum viable
**File**: `docs/legal/privacy-policy.md` (text), deployed to `garaaage.cz/privacy`
**Content (operator-supplied or Claude-drafted)**:
- Data controller identity (Garaaage s.r.o., IČO, sídlo, kontakt DPO if any)
- Categories of data processed (email, name, company, region, ICO)
- Sources (public registries firmy.cz, ARES)
- Purposes + legal basis (oprávněný zájem čl. 6(1)(f) — direct marketing)
- Recipients (none — internal only; processors: Railway DB, anti-trace-relay)
- Retention (24 months from last contact, suppression_list permanent)
- Data subject rights (Art. 15, 16, 17, 18, 21)
- Complaint authority (ÚOOÚ)
- Cookies (none on portal yet)

### S0.5 — LIA-001 dokument
**File**: `docs/compliance/lia-001-garaaage-cold-outreach.md`
**Three-prong test** documented:
- Purpose: marketing aukčního portálu (legitimate per Recital 47)
- Necessity: cold outreach na targeted B2B segment je etablovaná praxe
- Balancing: B2B context, public-registry source, opt-out provided, žádná special category data

### S0.6 — ROPA dokument
**File**: `docs/compliance/ropa-direct-marketing.md`
**Per čl. 30**: účel, kategorie subjektů, kategorie dat, recipients, transfers, retention, security.

## Exit kritérium
- [ ] Send-test mb=631 generuje email obsahující footer s validním unsub linkem
- [ ] Klik na unsub link smaže contact ze suppression dictionary AND status flip
- [ ] LIA + ROPA committed, reviewed by operator
- [ ] Privacy policy live na garaaage.cz/privacy nebo equivalent

## Risks
- **R0.1**: operátor nedodá IČO/sídlo včas → footer s placeholdery → still non-compliant. Mitigation: operátor priority Q.
- **R0.2**: garaaage.cz/privacy URL not live → footer odkazuje 404. Mitigation: deploy markdown na GitHub Pages or substack as fallback.

---

# S1 — First send (20 contacts live)

## Cíl
Campaign 455 odeslána, 20 sendů kompletních, metrics zachycené pro retro decision.

## Vstupy
- S0 hotový (compliance footer rendering)
- Anti-trace-relay reachable
- Mailboxy active, smoke test pass

## Scope

### S1.1 — Anti-trace-relay reachability check
```bash
curl -sf "$ANTI_TRACE_URL/health" -H "Authorization: Bearer $ANTI_TRACE_TOKEN" | jq .
```
Expected: `{"status":"ok",...}`. Fail-stop pokud not reachable — sender by panikoval.

### S1.2 — Send-test smoke (per mailbox)
```bash
curl -X POST "$BFF_URL/api/mailboxes/631/send-test?force=1" \
  -H "x-api-key: $OUTREACH_API_KEY" \
  -H "content-type: application/json" \
  -d '{"to":"<operator@email>","subject":"smoke 631","text":"smoke"}'
```
Same pro mb=632. Operator verify email arrives + footer renders správně + unsub link working.

### S1.3 — Activate kampaň
```bash
curl -X POST "$BFF_URL/api/campaigns/455/run" -H "x-api-key: $OUTREACH_API_KEY"
```
Status flip → 'running'. Scheduler pickne v dalším 60s ticku.

### S1.4 — 24h monitoring queries
**Run hourly first 4h, then every 6h**:
```sql
SELECT mailbox_used, status, COUNT(*) FROM send_events WHERE campaign_id = 455 GROUP BY 1,2;
SELECT * FROM mailbox_alerts WHERE created_at > now() - interval '6 hours' ORDER BY created_at DESC;
SELECT * FROM reply_inbox WHERE campaign_id = 455 ORDER BY created_at DESC;
```

**Auto-pause triggers** (already wired per `runCampaignWatchdogCron`):
- bounce_rate > 5% → status='paused'
- 3 consecutive SMTP failures → mailbox status='paused'

### S1.5 — Decision document
**File**: `docs/initiatives/2026-04-25-garaaage-launch-plan.md` — append "## S1 retro" section:
- Sent count
- Bounce rate
- Reply rate (positive / negative / question / unknown)
- Any spam-flag signals (auto-pause hits, mailbox alerts)
- Decision: scale to batch 2 (50)? iterate template? stop?

## Exit kritérium
- [ ] 20 sendů confirmed v `send_events` s `status='sent'`
- [ ] Bounce rate < 5%
- [ ] Žádný mailbox auto-paused
- [ ] Reply pulses captured (i kdyby 0)
- [ ] Decision document appended

## Risks
- **R1.1**: Mailbox auth fail at first send → password mismatch. Mitigation: send-test S1.2 chytne dříve.
- **R1.2**: Bounce rate spike → globální circuit breaker (commit `c508366` resets hourly). Pause pokud spike, investigate.
- **R1.3**: Anti-trace-relay flake → typed errors handler (`8383dd0`) treats jako transient, retry. Pokud persistent → S1 stop, fix infra.

---

# S2 — GDPR rights endpoints + S1 retro

## Cíl
Pokud někdo z 20 příjemců pošle data subject request, operator umí odpovědět do 1 měsíce. Plus S1 metrics inform batch 2.

## Vstupy
- S1 hotový (real data v DB pro testing endpoints)
- LIA + ROPA z S0

## Scope

### S2.1 — Art. 15 data subject access endpoint
**File**: `features/platform/outreach-dashboard/server.js`
**Add**: `GET /api/dsr/access?email=<EMAIL>` (operator-auth, X-API-Key)
- Output JSON s daty napříč:
  - `contacts` (full row)
  - `outreach_contacts` (full row, joined by email_hash)
  - `send_events` (all sends)
  - `reply_inbox` (all replies)
  - `tracking_events` (all opens/clicks linked to send_events)
  - `suppression_list` + `outreach_suppressions` (presence)
- Audit log entry `dsr_access` per request

### S2.2 — Art. 17 erasure cascade endpoint
**File**: `features/platform/outreach-dashboard/server.js`
**Add**: `POST /api/dsr/erase?email=<EMAIL>` (operator-auth)
- Cascading DELETE napříč všemi 6 tabulkami uvedenými výš
- Suppression_list zachovat (čl. 21 right to object — proof of opt-out)
- Audit log entry s timestamp + scope of erasure
- Idempotent (re-run nic neudělá pokud už smazáno)

### S2.3 — DSR runbook
**File**: `docs/playbooks/dsr-runbook.md`
- Step-by-step jak operator zvládne příchozí DSR (response template, time limit, escalation)

### S2.4 — S1 retrospective
- Append do tohoto dokumentu sekci "## S1 výsledky"
- Decision: batch 2 size + timing

## Exit kritérium
- [ ] DSR access endpoint vrátí JSON s 5+ tabulek pro test contact
- [ ] DSR erase smaže contact napříč tabulkami; access poté = 404
- [ ] DSR runbook reviewed by operator
- [ ] S1 retro decision documented

---

# S3 — Cesta B: BFF→Go enrollment bridge

## Cíl
UI `Campaigns/New` flow vytvoří kampaň + enrolluje contacty bez SQL bypassu. Cesta A (SQL skripty) retired.

## Vstupy
- S1 hotový (Cesta A proven works)
- Existing: Go service `features/outreach/campaigns/web/campaigns.go` má kompletní CreateCampaign + enrollContacts

## Scope

### S3.1 — Architecture decision: proxy vs native
**Doporučení**: BFF proxies POST /api/campaigns to Go service (CLAUDE.md says "BFF proxies via X-API-Key"). Reuses tested Go enrollment logic.

### S3.2 — BFF proxy implementation
**File**: `features/platform/outreach-dashboard/server.js`
**Replace** existing direct-DB POST /api/campaigns (line ~1547) s:
```js
app.post('/api/campaigns', async (req, res) => {
  const goRes = await fetch(`${GO_SERVER_URL}/api/campaigns`, {
    method: 'POST',
    headers: { 'x-api-key': OUTREACH_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(req.body)
  })
  res.status(goRes.status).json(await goRes.json())
})
```

### S3.3 — UI multi-select kategorií
**File**: `features/platform/outreach-dashboard/src/pages/CampaignNew.jsx`
**Step3 component**: nahradit single segment dropdown za multi-checkbox sectors:
```jsx
const SECTORS = ['machinery','metalwork','construction','agriculture',
                 'transport','automotive','woodwork','plastics',
                 'food_processing','chemicals','waste','energy','printing']
```
- formData: `selectedSectors[]` místo `segmentId`
- POST body: map sectors → category_paths (firmy.cz path prefixes)

### S3.4 — Contract test alignment
**File**: `features/platform/outreach-dashboard/test/contract/bff-campaigns-actions.contract.test.ts`
- Update expectations: BFF proxies → Go-side response shape
- Or: snapshot new request/response shape

### S3.5 — Dead table cleanup
**Migration**: drop `campaign_enrollments` table (vestigial, nikde nepopulated)
**File**: `features/inbound/orchestrator/migrations/0XX_drop_campaign_enrollments.sql`

### S3.6 — Migrate scripts/campaigns/launch-001-*.sql to deprecated/
**File**: `scripts/campaigns/_archived/launch-001-machinery-soft-20.sql`
- Move + add header note "Replaced by UI flow as of S3 (commit XYZ)"

## Exit kritérium
- [ ] Operator klikne UI Campaigns/New → vyplní → vytvoří kampaň + 20+ enrollnutých
- [ ] Žádný direct-DB INSERT do `campaigns` ani `campaign_contacts` v BFF
- [ ] Contract tests green (po update)
- [ ] `campaign_enrollments` dropped, žádné runtime errory
- [ ] Cesta A SQL scripts archived

## Risks
- **R3.1**: Go service není reachable z BFF (Railway internal DNS). Mitigation: smoke test → fallback to native bridge if proxy fails
- **R3.2**: UI form shape doesn't match Go's expectation. Mitigation: schema test on POST body

---

# S4 — Security hardening

## Cíl
Připravit pro scale: encrypted secrets, audit-grade logging, rate limits.

## Scope

### S4.1 — Encrypt mailbox passwords (pgcrypto)
**Migration**:
```sql
-- 1. Add encrypted column
ALTER TABLE outreach_mailboxes ADD COLUMN password_enc bytea;

-- 2. Encrypt existing rows (one-shot, transactional)
UPDATE outreach_mailboxes
SET password_enc = pgp_sym_encrypt(password, current_setting('app.secret_key'))
WHERE password IS NOT NULL;

-- 3. Drop plaintext column (after deploy verifies decrypt works)
ALTER TABLE outreach_mailboxes DROP COLUMN password;
ALTER TABLE outreach_mailboxes RENAME COLUMN password_enc TO password;
```

**Code**:
- `features/outreach/mailboxes/mailbox/postgres.go` — change LoadActive() SELECT to use `pgp_sym_decrypt(password, $1)` with secret from env
- Secret v Railway env var `MAILBOX_SECRET_KEY`

### S4.2 — Retention cron
**File**: `features/platform/outreach-dashboard/server.js` — new cron `runRetentionCron`
- Run daily at 03:00 Prague
- DELETE FROM contacts WHERE last_contacted < now() - interval '24 months' AND id NOT IN (SELECT contact_id FROM reply_inbox)
- Cascade per S2.2 logic
- Audit log entry per pruning batch

### S4.3 — /unsubscribe rate limit
- Per-IP limit 10 req/min
- Pre-existing `rateLimited()` middleware can wrap

### S4.4 — Audit log Art. 30 ROPA wiring
- Each campaign tick already writes `campaign_tick_completed` per `audit.Log` (commit from previous brownfield)
- Ensure DSR access/erase logs go to same table
- Operator dashboard Reports/Audit page (read-only view)

### S4.5 — DPA proxy provider
**File**: `docs/legal/dpa-proxifly.md`
- Either: download proxifly TOS + sign as data processor agreement
- Or: switch proxy provider to one with proper DPA (proxyscrape, geonode have GDPR docs)

## Exit kritérium
- [ ] New mailbox INSERT stores encrypted; SELECT vrátí decrypted; password column type=bytea
- [ ] Retention cron logs first run successfully (může být dry-run mode for first month)
- [ ] /unsubscribe nepřežije 100 req/sec attack (returns 429)
- [ ] DPA dokument signed nebo provider switched

---

# S5 — Data quality + maintenance

## Cíl
Vyčistit dluhy aby budoucí kampaně neměly stejné personalizační problémy + zavřít otevřené tickets.

## Scope

### S5.1 — `contacts.first_name` cleanup
- Regex-based detection of company-name fragments: ALL CAPS sequences, punctuation, length > 15
- One-shot SQL: `UPDATE contacts SET first_name = NULL WHERE first_name ~ '<bad pattern>'`
- Estimated rows affected: ~600k+ z 759k
- Run in chunks of 50k pro safety

### S5.2 — IMAP delta-detection fix (#27)
**Schema**:
```sql
ALTER TABLE mailbox_imap_state
  ADD COLUMN last_processed_uid INT,
  ADD COLUMN uid_validity INT;
```

**Code change** v `features/platform/outreach-dashboard/server.js` `runImapPollCron`:
- Use `last_processed_uid` jako delta watermark místo `prev_unseen` count
- Process UIDs > last_processed_uid
- On UIDVALIDITY change, reset (treat as fresh mailbox)

### S5.3 — Failing JS tests triage
10 pre-existing failing files:
- sentry init (3 tests)
- bundle budget (2 tests)
- replies routes (5 tests)
- production readiness (1 test)
- route error boundary (env)
- auth middleware (env)
- fetchWithSentry (env)

Per-file decision: fix vs skip-with-reason. Document in `docs/decisions/ADR-XXX-test-suite-triage.md`.

### S5.4 — Mailbox warmup ramp test
- Verify `pickMailbox` respects warmup limits Day 1 (10) → Day 7 (80)
- Add table-driven test in `features/outreach/campaigns/sender/engine_warmup_test.go` (if not present)
- Document warmup schedule in operator runbook

### S5.5 — Refresh ETL stub
**File**: `scripts/etl/refresh-firmy-cz.sh`
- Manual-trigger script (not cron yet, S6)
- Re-fetches subset of contacts whose `outreach_contacts.last_score_update` > 6 months
- Updates company_name, region, industry_tags, removes terminated firms

## Exit kritérium
- [ ] 90%+ of `contacts.first_name` rows are clean (real names or NULL)
- [ ] IMAP poller catches reply when external mark-read happened in same poll
- [ ] All JS test files either green or explicitly skipped with ADR
- [ ] Warmup ramp respected v automatized test
- [ ] Refresh ETL runs end-to-end on test subset

---

# S6 — Scale-readiness

## Cíl
Pokud S1 + S2 + S3 ukázaly že kampaně fungují, připravit infra pro 50+/měsíc.

## Vstupy
- S1, S2, S3 hotové
- Operator decision: scale ano/ne

## Scope

### S6.1 — DPIA-001 dokument
**File**: `docs/compliance/dpia-001-direct-marketing-scale.md`
- Per čl. 35 GDPR
- Risk assessment: large-scale processing, automated decision-making (none), special categories (none)
- Mitigations: opt-out, suppression, retention, encryption (S4)
- Operator-supervised review

### S6.2 — Multi-mailbox seed
- Add 3+ Seznam adresy (mb=633, 634, 635)
- Distribute load (per-domain rotation v engine.go)
- Update warmup schedule per-mailbox

### S6.3 — Reply triage UI
**File**: `features/platform/outreach-dashboard/src/pages/Replies.jsx` (already exists, expand)
- Photo+TP attachment preview
- Workflow: Review → Send to Garaaage portal → Mark resolved
- Status: new → reviewing → garaaage_listed → closed

### S6.4 — Refresh ETL automation
- Quarterly cron in server.js
- Refresh subset of contacts (per S5.5 logic)

### S6.5 — SCC dokumentace pokud Railway non-EU
**File**: `docs/legal/scc-railway.md`
- Verify Railway region (UI: Project Settings → Region)
- If us-*: signed SCC + transfer impact assessment (TIA)
- If eu-*: just confirm in privacy policy

### S6.6 — Multi-campaign template framework
- Followup1 template (different angle, same Garaaage)
- Final template (last attempt)
- Sequence config in campaigns.sequence_config supports multi-step

## Exit kritérium
- [ ] DPIA committed, operator-reviewed
- [ ] 5+ mailboxes pool working (smoke test)
- [ ] Reply triage UI functional (operator workflow runbook)
- [ ] Quarterly refresh ETL scheduled
- [ ] SCC if needed signed

---

# S7 — Garaaage product (out of code scope)

**Listed pro completeness, NEN v tomto plánu**:
- garaaage.cz frontend (současný stav?)
- Auction listing flow post-reply (foto+TP → appraisal → listing)
- Bidder registrace + payment
- Vehicle valuation logic
- Logistics (vehicle pickup arrangement)

Operátor decision: kdy se tohle pustí + jaký je MVP rozsah pro response handling.

---

# Open Questions (block specific sprints)

| # | Otázka | Blocks | Priority |
|---|---|---|---|
| Q1 | IČO + sídlo Garaaage s.r.o. | S0.1 footer | **HIGH** |
| Q2 | Phone strategy (776 299 933 vs Garaaage business?) | S0.1 footer | HIGH |
| Q3 | Privacy policy: text or Claude-draft? | S0.4 deploy | HIGH |
| Q4 | garaaage.cz domain status — live? skeleton? | S0.4 + S7 | HIGH |
| Q5 | Railway region (eu-/us-/asia-)? | S6.5 SCC | LOW |
| Q6 | Anti-trace-relay deployment location? | S6.5 SCC | LOW |
| Q7 | Reply ops kapacita — kdo zpracovává? | S6.3 UI scope | MED |
| Q8 | Multi-campaign timing (po jakém intervalu batch 2?) | S2 retro | MED |
| Q9 | Compliance budget — full setup nebo MVP? | S4 + S6 scope | MED |
| Q10 | AI Act prep — kdy se Ollama replies aktivuje? | future | LOW |

---

# Critical path

```
                         ┌─> S2 (rights endpoints + retro)
                         │
S0 (compliance) ─> S1 ─> ┼─> S3 (Cesta B BFF bridge)         ─> S6 (scale)
                         │
                         ├─> S4 (security hardening)
                         │
                         └─> S5 (data quality + maintenance)

                         S7 (Garaaage product) — parallel, ongoing, op-side
```

S0 je hard blocker pro S1 (legal). S2/S3/S4/S5 paralelní po S1.
S6 čeká na S1 retro decision + scale signal.

---

# Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Sprint |
|---|---|---|---|---|---|
| R0.1 | Operátor nedodá IČO/sídlo včas | MED | S0 blocked | priority Q1 communication | S0 |
| R0.2 | garaaage.cz/privacy URL not live | MED | S0 footer 404 link | GitHub Pages fallback | S0 |
| R1.1 | Mailbox auth fail při first send | LOW | 0 emails, debug | send-test S1.2 catches | S1 |
| R1.2 | Bounce rate spike >5% | MED | auto-pause, investigate | watchdog cron handles | S1 |
| R1.3 | Anti-trace-relay flake | LOW | retry via typed errors | classifier handles | S1 |
| R2.1 | DSR request before endpoints exist | LOW | manual SQL aggregation | runbook S2.3 covers | S2 |
| R3.1 | Go service unreachable z BFF | LOW | proxy fails | smoke test → fallback | S3 |
| R4.1 | Migration encrypt loses data | LOW-CRITICAL | password lost = sends fail | transactional + backup before | S4 |
| R5.1 | first_name UPDATE affects too much | LOW-MED | 600k rows altered | run in 50k chunks | S5 |
| R6.1 | Scale launches before S0 effective | HIGH | repeated legal violations | S0 hard prerequisite | gate |

---

# Acceptance: definition of done pro celý plán

Plán je "done" když:
- [ ] S0–S5 hotové (PR merged)
- [ ] Campaign 455 + (alespoň 2) další běžel end-to-end přes UI
- [ ] DSR endpoint testovaný na real contact
- [ ] Mailbox passwords encrypted v produkční DB
- [ ] Retention cron běží 30+ dní bez incidentu
- [ ] Žádný open ÚOOÚ complaint linked na garaaage emails
- [ ] Reply triage UI hot at first 50 replies

S6 + S7 — opt-in podle business rozhodnutí, ne striktně součást "done".

---

# Závislosti k vyřešení teď (pre-S0)

1. **Q1 IČO + sídlo** — operátor pošle do `docs/legal/garaaage-info.md` nebo přímo
2. **Q2 phone** — operátor potvrdí (default 776 299 933)
3. **Q3 privacy text** — operátor pošle nebo souhlasí s Claude-draftem
4. **Q4 garaaage.cz status** — pokud not live, kde hostit privacy URL?

Po vyřešení Q1–Q4 → S0 můžu pustit autonomně.

---

# Reference

- PR #25 (current branch): https://github.com/messingdev/hozan-taher/pull/25
- LAUNCH-CAMPAIGN-001 runbook: `docs/playbooks/LAUNCH-CAMPAIGN-001.md`
- Cesta A SQL: `scripts/campaigns/{preview,launch}-001-machinery-soft-20.sql`
- Initial template: `features/outreach/campaigns/configs/templates/initial.tmpl`
- Brownfield hardening summary: 13 commits, 2471+ tests race-clean (campaigns + contacts)
- Memory: `feedback_campaign_send.md`, `feedback_mailbox_passwords_via_db.md`, `project_two_suppression_tables.md`, `project_first_campaign_launch.md`, `feedback_no_ci_nag.md`
