# Cross-mailbox Anonymity & Human-Likeness Test

**Status:** active
**Vlastník:** Chat A (dev) + Chat B (tests)
**Datum založení:** 2026-05-01
**Datum uzavření:** —
**Trigger:** Operátor potřebuje před první ostrou kampaní (455 → 20 kontaktů, machinery sektor) ověřit, že odchozí e-maily skutečně:
1. **Neprozrazují** naši infrastrukturu (true egress IP, anti-trace-relay routing, identifikační headery, Message-ID patterns).
2. **Vypadají human-like** v očích příjemce (variace subjectů, humanizovaný body, konzistentní jméno + telefon, čisté Czech diakritika, GDPR footer který nepůsobí robotně).

Bez této verifikace odešleme produkční dávku naslepo a první negativní signál (spam folder, hlášení od příjemce) přijde až jako stížnost — drahé.

## Kontext

K dispozici máme 4 funkční mailboxy na Seznam.cz SMTP:

| ID | Adresa | SMTP host | Status |
|----|--------|-----------|--------|
| 1 | mazher.a@email.cz | smtp.seznam.cz:465 | active |
| 3 | a.mazher@email.cz | smtp.seznam.cz:465 | active |
| 631 | b.maarek@email.cz | smtp.seznam.cz:465 | active |
| 632 | maarek.b@email.cz | smtp.seznam.cz:465 | active |

Pipeline (BFF → Go orchestrator → anti-trace-relay → SMTP → Seznam) je ověřená — campaign 456 ("INTERNAL TEST") odeslala 6 e-mailů 27.–30. 4. mezi mb=3 a mb=631 úspěšně. Ale **nikdy jsme tyto e-maily nečetli ani neanalyzovali příchozí stranou.** Send_events tabulka ví "odešel", IMAP poller nikdy nepřečetl ten konkrétní inbox.

3 templates v DB / disk:
- `intro_machinery.tmpl` (subj 25 chars, body 1446 chars)
- `followup_1.tmpl` (subj 18, body 564)
- `followup_2.tmpl` (subj 15, body 397)

## Cíle

**Měřitelné výstupy** po dokončení:

1. **Anonymity score per (sender_mailbox, template) pair** — 0–100. Skladá se z:
   - True-egress IP leakage (Received chain neukazuje na náš datacentr / lokální IP)
   - Anti-trace-relay path není v headerech viditelná
   - Message-ID nemá doménu/hash z naší infry
   - X-Mailer / User-Agent neukazuje verzi naší knihovny
   - Return-Path = From (žádný envelope mismatch)
   - DKIM/SPF/DMARC pass (Seznam by měl signovat za nás)
2. **Human-likeness score per template** — 0–100. Skladá se z:
   - Subject variance (spinner přes 12 sendů produkuje ≥3 unikátní subjects)
   - Body humanizer artifacts (filler words, sentence length variance, Czech diakritika)
   - Greeting/sign-off konzistence (jméno + telefon = stejné napříč emaily ze stejného mailboxu)
   - GDPR footer netečí přes 4 řádky / není jako bloková reklama
   - LLM-as-judge verdikt: human / templated / spam-pattern
3. **Per-direction matrix** všech 12 directed pairs (4 sender × 3 receiver, self-skip), všech 3 templates = **36 test sendů + IMAP read + score**.
4. **Aggregated report** v `reports/anonymity/<timestamp>/` — JSON + markdown summary; per-mailbox + per-template ranking; konkrétní leaks a doporučení.
5. **CI ratchet (volitelné, S5)** — anonymity score baseline locked; PR drop blokátor.

## Plán (sprinty)

### Sprint S1 — Cross-send harness (1 den) {#sprint-s1}

Build executable: spustit 36 sendů řízeně, persistovat send_events s extra metadaty pro pairing.

- [ ] **S1.1** — Add CLI tool `cmd/anonymity-test/main.go` v `features/inbound/orchestrator/`
   - Reads mailbox list from DB
   - For each (sender, receiver, template) triple where sender != receiver: dispatches via `antitrace.Submit`
   - Writes test-send marker do `send_events.metadata` (`{"test_run": "<uuid>", "pair": "1->3", "template": "intro_machinery"}`)
   - 5s spacing mezi sendy aby se nepokrylo se Seznam rate-limit
- [ ] **S1.2** — Per-direction send_events extension — add nullable `metadata jsonb` column nebo reuse existing `headers`
- [ ] **S1.3** — Deterministic seed pro reproducibility — same test_run reproduces same humanize variants

**Výstup:** `./anonymity-test --run-id=<uuid>` posílá 36 e-mailů; každý má test_run marker.

**DoD:** 36 send_events rows s `status='sent'` a markerem.

---

### Sprint S2 — IMAP harvest + parse (1 den) {#sprint-s2}

Read all 36 e-mailů z přijímacích inboxů, normalize headers + body, persistovat do nové analytic tabulky.

- [ ] **S2.1** — Add table `anonymity_test_messages`:
   ```sql
   id bigserial PK
   test_run_id uuid
   sender_mailbox_id bigint
   receiver_mailbox_id bigint
   template_name text
   send_event_id bigint  -- FK zpět na send_events
   imap_uid bigint
   imap_uidvalidity bigint
   raw_headers jsonb       -- Map<header_name, value[]>
   raw_body text
   received_chain text[]   -- z headers ale parsed
   message_id text
   from_addr text
   return_path text
   dkim_result text
   spf_result text
   dmarc_result text
   harvested_at timestamptz default now()
   ```
- [ ] **S2.2** — IMAP harvester `cmd/anonymity-harvest/main.go`:
   - Pro každý receiver mailbox: SELECT INBOX, fetch UID > last_seen, parse headers + body, find ones matching test_run marker (X-Test-Run-ID custom header)
   - Persist do `anonymity_test_messages`
- [ ] **S2.3** — Custom header injection při sendu — abychom v IMAPu spolehlivě poznali test e-maily, přidat `X-Test-Run-ID: <uuid>` do anti-trace-relay envelope
- [ ] **S2.4** — Wait-loop: po Submit počkat až Seznam doručí (typicky 5–60s), retry IMAP fetch s exponentialem; cap 5 minut

**Výstup:** 36 řádků v `anonymity_test_messages`, každý s plnými raw headery a body.

**DoD:** Pro každý send_event existuje match v anonymity_test_messages (100 % delivery; chybějící → sentry warning).

---

### Sprint S3 — Anonymity scorer (2 dny) {#sprint-s3}

Static rules + LLM judge, 0–100 score per zprávě + aggregate per (sender, template).

- [ ] **S3.1** — Rule-based scorer v `features/outreach/campaigns/content/anonymity_score.go`:
   - **L1 IP leakage (50 bodů):** Received chain musí obsahovat pouze Seznam SMTP IP rozsah (185.146.213.0/24 nebo podobné). Pokud zaznamená anti-trace-relay public IP nebo náš datacentr — minus body proporcionálně.
   - **L2 Header fingerprint (20 bodů):** X-Mailer absent / generic; Message-ID format `<random>@email.cz` (Seznam-format), ne náš template.
   - **L3 Envelope match (10 bodů):** Return-Path == From; žádný envelope-from mismatch.
   - **L4 DKIM/SPF/DMARC (20 bodů):** Authentication-Results pass pro alespoň DKIM + SPF.
- [ ] **S3.2** — LLM-as-judge verdikt s explanation. Prompt: "Below is the raw header set + body of an email. Identify any artifacts that suggest automated/templated origin. Score 0–100 (100 = indistinguishable from human). Cite specific headers/phrases."
- [ ] **S3.3** — Aggregate scoring:
   - Per (sender_mailbox, template) — average score, std deviation, leak count.
   - Per template — same.
   - Per sender mailbox — same.
- [ ] **S3.4** — Output `reports/anonymity/<run-id>/scores.json` + `summary.md`

**Výstup:** Scored matrix 36 messages; aggregated report.

**DoD:** Každá z 36 zpráv má:
- `anonymity_score` (0–100, rule-based)
- `anonymity_judge` (0–100, LLM)
- `anonymity_leaks` ([{rule, severity, evidence}, ...])

---

### Sprint S4 — Human-likeness scorer (1.5 dne) {#sprint-s4}

Variance + content checks + LLM judge.

- [ ] **S4.1** — Variance metrics:
   - Subject diversity per template: unique-subject ratio (ideálně ≥30 % ze 12 sendů)
   - Body length variance: stddev / mean ≥ 0.05
   - Sentence count variance: stddev ≥ 0.5
- [ ] **S4.2** — Content checks:
   - Czech diakritika present (no ASCII-only fallback)
   - Phone pattern `\d{3} ?\d{3} ?\d{3}` matches expected from `mailbox.metadata.phone`
   - Sign-off includes mailbox owner's name
   - GDPR footer present but ≤4 řádky
- [ ] **S4.3** — LLM-as-judge: "Read this email body. Score 0–100 (100 = human-written, 0 = obvious template/bot). Identify telltale templating phrases."
- [ ] **S4.4** — Combined score: 60 % rule-based + 40 % LLM judge.

**Výstup:** Per-template human-likeness score (3 templates × aggregate).

**DoD:** `reports/anonymity/<run-id>/humanlike.json` + summary section v markdown reportu.

---

### Sprint S5 — Operator-facing report (0.5 dne) {#sprint-s5}

Surface in /priprava (or new /diagnostika page) — anonymity badge per mailbox + last-test timestamp.

- [ ] **S5.1** — BFF endpoint `GET /api/anonymity/latest?mailbox_id=N` — returns last 7-day score, leaks, recommendation.
- [ ] **S5.2** — UI page `/diagnostika/anonymita`:
   - Tabulka 4 mailboxů s anonymity score + human-likeness score + last-tested timestamp
   - Click → drawer s konkrétními leaks per template
   - "Spustit test now" button (rate-limited 1/hod) — kicks off S1+S2+S3+S4 sprint pipeline

**Výstup:** Operátor vidí zelenou/žlutou/červenou indikaci per mailbox před launchem.

**DoD:** /diagnostika/anonymita renderuje aktuální data; tlačítko spouští backend chain.

---

### Sprint S6 — CI ratchet (volitelné, +1 den) {#sprint-s6}

Lock the score baseline; PR breaking the score blocks merge.

- [ ] **S6.1** — Nightly cron — runs anonymity test on staging (or test mailboxes), persists.
- [ ] **S6.2** — Audit test `features/outreach/campaigns/content/anonymity_baseline_test.go` — reads last 7-day median, fails if any (sender, template) drops more than 5 bodů below baseline.
- [ ] **S6.3** — Doc — `docs/playbooks/anonymity-baseline.md` — when score drops, what to investigate.

---

## Test matrix (36 directed pairs × samples)

```
Sender → Receiver matrix (4×3 = 12 pairs, self-skip):

         |  3   | 631  | 632  |
   1     |  ✓   |  ✓   |  ✓   |
   3     |  —   |  ✓   |  ✓   |
   631   |  ✓   |  —   |  ✓   |
   632   |  ✓   |  ✓   |  —   |

Each pair × 3 templates (intro_machinery, followup_1, followup_2) = 36 sends.
```

Per-template repetition může být zvětšeno na 3× pro lepší variance estimate (108 sendů). Default S1 = 36 sends, optional sprint S1.5 = 108.

## Risks / open questions

1. **Seznam rate-limiting** — 36 sendů přes 4 mailboxy během krátké doby může trigger antispam. Mitigace: 5s mezi sendy + max 9 sendů per sender.
2. **IMAP delivery latency** — Seznam delivery někdy ≥60s. S2.4 wait-loop musí být robustní.
3. **LLM judge cost** — 36 messages × $0.005 per judge call = ~$0.20 per run. OK pro občasné spuštění; ne pro CI cron každou hodinu (v S6 nakonfigurovat 1x denně).
4. **Test mailbox pollution** — všech 36 e-mailů se objeví v INBOX. Po S2 harvest přesunout do `Tested-Anonymity/<run-id>` IMAP folderu.
5. **Aktuální running campaign 1 + 456** — testy musí jet na non-conflict windowing. Před S1 spuštěním pause campaigns.

## Blokátory

- PR #527 (preflight scans correct dir + S1 pre-enqueued bypass) musí být mergnutý — jinak `anonymity-test` cmd by se chytlo na vlastním preflight check.

## Log

- **2026-05-01 ráno** — Initiative založen. Trigger: před první ostrou kampaní 455 (20 reálných příjemců).

## Cross-references

- Existing internal-test: campaign 456 (mb=3 ↔ mb=631, 6 sendů 27.–30. 4.) — historical baseline.
- IMAP poller: `features/inbound/orchestrator/imap/poller.go` — re-use UID watermark logic v S2 harvester.
- Anti-trace-relay client: `features/outreach/campaigns/sender/antitrace.go` — submit pathway pro S1.
- Send pipeline contract: `features/outreach/campaigns/CLAUDE.md` — `Engine.Run` flow.
