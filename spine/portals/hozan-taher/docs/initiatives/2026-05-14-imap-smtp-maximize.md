# Iniciativa AC — Maximální vytěžení IMAP a SMTP

**Status:** Active
**Datum:** 2026-05-14
**Trigger:** Po Sprint AA1 (4-worker engine) cluster běží 80 send/hod, burn-down 25 811 contactů = 15 dní. Operator chce výrazně urychlit, ale bez kompromisu na anti-detection baseline (anonymity test 2026-05-01).

## Severní hvězda

Za 3 týdny zvýšit produktivní throughput **80/hod → 200/hod** (2,5×) přidáním kapacity, ne snížením per-mailbox cadenci. IMAP cyklus zkrátit z 5 min → 2 min, aby odpovědi padaly do UI v reálném čase. Reply pipeline plně automatizovat — Haiku klasifikátor + auto-suppression negativních odpovědí.

Anti-detection rozpočet zůstává: 180s spacing per mailbox, 120s Poisson mean, žádný cluster-wide burst. Růst přes víc mailboxů, ne přes rychlejší jednu schránku.

## Co dnes víme

- 4 schránky `hozan.taher.75-78@post.cz` v `warmup_d0` (Den 0-2, cap 5/den z DB triggeru, override 420 je vyšší → neúčinné).
- Cluster sustained ~80/h post-AA1, kterých 4 × 20/h.
- IMAP poll funguje (Z3-A na Go runner, every 5 min, 0 unseen většinu času).
- Verify queue má od PR #1374 tier-priority ordering — A-tier (6 338) půjde první, jakmile lokální BFF cron běží.
- 3 odpovědi z minulého týdne jsou v `unmatched_inbound` (pre-wipe artefakty, matcher OK pro nové sendy).
- 0 nových bounces od X7 deploy (DNS pre-send gate).

## Fáze a sprinty

### Fáze 1 — Odblokování warmup capu (D+0 až D+3)

Cíl: dostat 4 mailboxy z warmup_d0 (5/den) do warmup_d7 (25/den) a pak production (100/den). Trigger `enforce_warmup_cap` dnes blokuje INSERT po překročení phase capu — daily_cap_override jen snižuje, nezvyšuje.

**Sprint AC1 — Sledování warmup_phase advance**
- DB function `advance_lifecycle_phase()` cron běží 03:00 Praha denně.
- Schránky byly založeny 2026-05-13 večer → 2026-05-14 = Day 0, 2026-05-15 = Day 1, atd.
- 2026-05-16 (Day 3) by měly přejít na `warmup_d3` (10/den), 2026-05-20 (Day 7) na `warmup_d7` (25/den).
- Žádný kód, pouze každodenní ověření po 03:00 + audit `operator_audit_log` rows.

**Sprint AC2 — Daily limit dashboard surface**
- Operator panel na `/mailboxes` zobrazí aktuální phase + daily quota + spotřebovaný počet × cap.
- Použij existující `MailboxHealthChart` rozšíření z PR #1368, přidat indikátor "X / 5 dnes".
- Playwright smoke spec.
- Důvod: dnes operator nevidí proč engine škrtí (cap z DB triggeru je neviditelný).

**Sprint AC3 — Volitelné zkrácení spacingu po production**
- Až všechny 4 schránky budou v `production` (D+30), zvážit `MAILBOX_MIN_SPACING_SECONDS` 180 → 120.
- Předpoklad: žádné bounces, žádné spam complaints po 30 dní burn-in.
- Pokud yes: per-mb cadence 30/h, cluster 120/h.
- Anonymity re-test PŘED změnou (pre-flight 2026-05-01 baseline rerun).

### Fáze 2 — Rozšíření flotily (týden 1, D+3 až D+10)

Cíl: 8 aktivních mailboxů namísto 4. Cluster strop se zdvojnásobí.

**Sprint AC4 — Provisioning 4 nových `@post.cz` schránek**
- `hozan.taher.79-82@post.cz` ručně přes Seznam UI (operator action — captcha + ověření telefonem).
- Po vytvoření INSERT do `outreach_mailboxes` přes dashboard `/mailboxes/new` (žádné env vary).
- Každá schránka začíná v `warmup_d0`.
- Důvod: operator preference 4×4 než 1×16 (rovnoměrné rozložení reputace, menší blast radius při Seznam blacklistu).

**Sprint AC5 — `SENDER_WORKER_COUNT=8`**
- Po provisioning + ověření že 8 mailboxů je `active` zvýšit env na Railway machinery-outreach.
- 4 workers extra. Mutex v engine.go bude testován reálným zatížením.
- Předpoklad: po 1h sustained 160/h cluster (8 × 20/h).

**Sprint AC6 — Distribuce audit**
- Cron Go runner každých 6h spočítá `MAX/MIN sends per mailbox za 24h` a alertne pokud rozdíl > 50%.
- Důvod: pickMailbox round-robin se může zaseknout na malé podmnožině; je třeba vidět.

### Fáze 3 — IMAP a reply automatizace (týden 2, D+10 až D+17)

Cíl: odpovědi v UI do 2 minut + automatická klasifikace + auto-suppression na NO.

**Sprint AC7 — IMAP poll interval 5min → 2min**
- Z3-A cron Go runner: konstanta `imapPollInterval` z 5 minut na 2.
- 8 mailboxů × poll/2min = 4 polly/min average. wgpool max 6 simultaneous OK.
- Latence reply visibility: 5 min → 2 min (medián).
- Test: simulace 2× souběžných pollů, ověřit že nepadá ECONNRESET.

**Sprint AC8 — Haiku reply pre-klasifikace na ingestu**
- V `features/inbound/orchestrator/thread/inbound.go` po `ProcessReply` matchi: volat Haiku LLM s `body_plain` (max 2 KB) a požadavkem `{intent: positive|negative|info_request|unsubscribe|bounce, confidence: 0-1}`.
- Uložit do `reply_inbox.pre_classification` JSONB.
- Žádné akce na základě toho — jen tagging pro operator UI filtr "Pozitivní/Negativní/Info" na `/replies`.

**Sprint AC9 — Auto-suppression na negativní odpovědi**
- Pokud pre_classification.intent == 'negative' AND confidence > 0.85, INSERT do `outreach_suppressions` (reason='negative_reply') + UPDATE contacts SET status='opted_out'.
- Operator audit log + Sentinel alert na první takovou událost.
- Důvod: dnes operator musí ručně suppressovat → nestíhá.

**Sprint AC10 — Bounce rate hlídač 1h sliding**
- Alert na operator notifications drawer pokud bounce_rate > 1% za 1h sliding window (per mailbox + per cluster).
- Důvod: dnes monitor čeká 24h window — incident už uběhl.

### Fáze 4 — Vlastní doména `@balkanmotors.cz` (týden 3, D+17 až D+24)

Cíl: druhý send path mimo Seznam, vyšší trust pro A-tier kontakty.

**Sprint AC11 — DNS setup**
- Cloudflare DNS pro `balkanmotors.cz`: MX, SPF (`v=spf1 include:_spf.relay.outreach.com ~all`), DMARC, DKIM klíče.
- Per Sprint N playbook (existující doc).
- Verify přes `dig` + dnsstuff.com tester.

**Sprint AC12 — Anti-trace-relay routing balkanmotors.cz**
- Relay musí umět rozlišit `from_address @balkanmotors.cz` a routovat přes vlastní SMTP submission (ne Seznam SMTP).
- Nový SMTP backend: použít nějaký SMTP relay service (Mailgun, Postmark, etc.) — operator decision.
- Důvod: Seznam neumí host @balkanmotors.cz.

**Sprint AC13 — Hybridní sending strategy**
- Engine pickMailbox respektuje `mailbox.tier` (high_trust pro @balkanmotors.cz).
- Routing rule: contact.priority >= 0.85 (A-tier) → high_trust mailbox; jinak round-robin standard fleet.
- Audit per tier delivery rate.

**Sprint AC14 — Side-by-side analytics**
- 7-day porovnání reply rate `@post.cz` vs `@balkanmotors.cz` na stejných A-tier kontaktech.
- Pokud `@balkanmotors.cz` má > 1.5× reply rate, posun A-tier sends na own-domain celý.

## Predikce throughputu

| Fáze | Datum | Active mb | Per-mb | Cluster /h | /den (21h window) | Burn 25 811 |
|---|---|---|---|---|---|---|
| Dnes | D+0 | 4 | 20 | 80 | 1 680 | 15 dní |
| Fáze 1 konec | D+3 | 4 | 20 | 80 | 1 680 | 15 dní (cap, ne spacing) |
| Fáze 1 + AC3 | D+30 | 4 | 30 | 120 | 2 520 | 10 dní |
| Fáze 2 konec | D+10 | 8 | 20 | 160 | 3 360 | 7 dní |
| Fáze 4 konec | D+24 | 10 | 20 | 200 | 4 200 | 6 dní |

## Co tahle iniciativa neřeší

- Vlastní LLM pro reply generation (manual reply pipeline pro A-tier).
- Multi-region egress (jen CZ Mullvad zatím).
- Reply latency analytics dashboard (placeholder card v PR #1369 zůstává).
- E-tier rebuild (4 921 skipped contactů — odložené).

## Rozhodnutí, která operator musí udělat

1. **AC4 — provision 4 nové mailboxy:** kdy? Operator manual job (Seznam captcha + telefon).
2. **AC8 — Haiku ingest klasifikace:** OK utracet ~$0.02 per reply za pre-classification?
3. **AC11 — own-domain provider:** Mailgun ($35/měsíc), Postmark ($15), self-host MTA? — operator volba.
4. **AC13 — high-trust routing:** A-tier (priority ≥ 0.85, 6 338 contactů) vs vždy round-robin?

## Hard rules respektované

- Anti-trace path (`feedback_anti_trace_full_stack`) — všechny sendy přes Engine.Run, bez bypassu.
- Audit log on mutations (`feedback_audit_log_on_mutations`) — každý cap-raise + status flip.
- Schema verify before SQL (`feedback_schema_verify_before_sql`) — všechny migrace `\d <table>` cited.
- UX/UI first (`feedback_ux_ui_first`) — AC2, AC8, AC10 mají dashboard surface.
- Playwright smoke (`feedback_playwright_smoke_required`) — každý nový UI surface smoke landed.
