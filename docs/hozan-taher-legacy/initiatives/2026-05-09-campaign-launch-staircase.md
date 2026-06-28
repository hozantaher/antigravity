# Campaign 457 Launch — Staircase with Mullvad-CZ Reality Check (Sprint AT)

**Status:** Open
**Datum:** 2026-05-09
**Trigger:** Po dokončení Sprint AO+AP+AQ+AR+AS frameworků (40+ PR za 2 dny) je Goran disaster scénář architektonicky uzavřen a defense-in-depth je 14 vrstev. Production audit (2026-05-09 ~17:30) potvrdil 24/24 ratchety baseline 0 a všechny defense layers active. Zbývá jediný **architektonický blocker**: Mullvad CZ exit IPs jsou na anti-VPN blacklistech většiny CZ recipient mailserverů (per `features/outreach/relay/CLAUDE.md` a paměť `seznam_proxy_geo_mismatch`). Operator vědomě akceptoval risk a zvolil cestu A — pošli, sleduj bounces, učiň datově podložené rozhodnutí. Sprint AT strukturuje launch jako staircase 0→1→3→10 mailů s explicitními rozhodovacími body.

Iniciativa NENÍ o tom "pošli ihned všech 100". Je o tom "pošli 1, počkej 10 min, podívej se na výsledek; pokud OK, pošli 3, počkej 30 min, podívej se; ..." Postupně škálujeme až na full warmup_d0 (10 mailů/den), pak přes phase ladder do production.

## Cíl

Po dokončení Sprint AT máme:

1. **První 10 sendů reálně doručeno (nebo odmítnuto)** s plnou observability — víme bounce rate per recipient mailserver vendor (seznam.cz, sourcefirma.cz, atd.)
2. **Datově podložené rozhodnutí** zda Mullvad CZ stačí pro CZ B2B (>70% delivery), nebo musíme pivotovat na vlastní VPS / transactional service
3. **Mailbox reputation chráněna** — AR11 bounce auto-pause spustí pokud >5% bounces; operator vidí v Sentry alertu a zastaví dříve než spálí
4. **Full warmup_d0 dokončený** za podmínky že delivery rate ≥ acceptable threshold; jinak pause + pivot
5. **Day-1+ ramp plan** připravený s phase-aware caps (warmup_d3=20/d, warmup_d7=50/d, atd.) až do production phase

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AT1 P1 verify | žádná | 15 min | P0 |
| AT2 P2 env explicit | AT1 | 10 min | P1 |
| AT3 first send (1) | AT1+AT2 | 1 mail + 10 min watch | P0 |
| AT4 escalate (3) | AT3 PASS | 3 mails + 30 min watch | P0 |
| AT5 first day full (10) | AT4 PASS | 4 hours | P0 |
| AT6 24h monitoring | AT5 | 24h passive watch | P0 |
| AT7 phase ramp d3→prod | AT6 PASS | 30 dní | P1 |
| AT8 Mullvad reputation tracking | AR15 | continuous | P2 |

## Sprint AT1 — P1 verify (P0, 15 min)

Před prvním sendem ověřit 2 P1 nálezy z production auditu, které pokud chybí způsobí silent data loss.

**Co uděláme:**

Operator akce na Railway dashboardu, anti-trace-relay service:

1. Settings → Variables → ověř `DATA_ENCRYPTION_KEY_B64` přítomnost. Pokud existuje, dekóduj base64 a verify 32 bajtů. Pokud chybí nebo nesprávná délka, generuj nový (`openssl rand -base64 32`) a set.
2. Settings → Volumes → ověř že `DATA_DIR` env var (default `/app/data`) ukazuje na persistent volume mount. Pokud na ephemeral `/tmp`, restart smaze pending envelopes — operator musí připojit volume.

**Acceptance:** oba env+volume ověřené. Bez toho launch refuse.

## Sprint AT2 — P2 env vars explicit (P1, 10 min)

Implicit defaults fungují, ale explicitní set zlepší debugging + auditability.

**Co uděláme:**

Na outreach-dashboard Railway service:

```
GLOBAL_AGGREGATE_CAP=50
ALLOWED_OPERATOR_IDS=operator,tomas,messing
SEND_WINDOW_START_HOUR=9
SEND_WINDOW_END_HOUR=17
SEND_WEEKDAYS_ONLY=true
```

Po set restart BFF service. Verify v Sentry breadcrumbs že crony čtou nové hodnoty.

## Sprint AT3 — First send (P0, 1 mail + 10 min watch)

Nejdůležitější moment. Pošleme JEDEN mail, jednomu recipientovi, a sledujeme.

**Co uděláme:**

1. Activate campaign 457: `UPDATE campaigns SET status='active' WHERE id=457`
2. Pošli první vlnu **1 mailem** přes BFF send-batch endpoint:
   - Recipient: pm***@pmdp.cz (cc_id=244, contact_id=210, valid email_status, Ředitelství PMDP a.s.)
   - From: nowak.goran@seznam.cz (mailbox 14227, pinned cz-prg-wg-101)
   - Force-Send header pokud mimo 09-17 okno
3. Počkej 10 minut. Sleduj:
   - relay logs: `outbound_smtp_delivered` (success) NEBO `outbound_smtp_failed` s SMTP code
   - send_events DB row: status='sent' / 'bounced' / 'failed'
   - Sentry: žádný alert
   - mailbox_egress_observation: záznam s egress_country='CZ', label='cz-prg-wg-101'

**Decision gate AT3:**

| Outcome | Akce |
|---|---|
| ✓ delivered (250 OK) | proceed AT4 |
| 5xx hard bounce (550, 553, 554) | mailserver odmítl. STOP. Investigate konkrétní chybu. Možná firmy.cz mention v body? Mullvad blacklist na seznam.cz mailserveru? |
| 4xx soft bounce (421, 450, 451) | greylisting nebo temporary. AR11 retry path. Wait 1h, retry. Pokud opět fail, považuj za hard. |
| auth fail (535) | mailbox creds problém — STOP. Mailbox 14227 ne-funkční. |
| network timeout | relay-side issue. STOP, debug. |
| envelope queued >5min bez delivery | relay queue stuck. STOP, debug. |

## Sprint AT4 — Escalate to 3 (P0, 30 min)

Pokud AT3 PASS, escalate na 3 maily simultánní.

**Co uděláme:**

Pošli 3 maily rozprostřené po 5-10 min, alternuje mailbox:
- 18:00 → mailbox 14227 → recipient #2 (pr***@diamo.cz, DIAMO státní podnik)
- 18:08 → mailbox 14228 → recipient #3 (us***@adoz.cz, ADOZ s.r.o.)
- 18:16 → mailbox 14227 → recipient #4 (tu***@diamo.cz, DIAMO Hamr)

Sleduj 30 min.

**Decision gate AT4:**

| Delivery rate | Akce |
|---|---|
| 3/3 delivered | proceed AT5 |
| 2/3 delivered | proceed AT5 s vědomím že ~33% loss; warmup_d0 z 10 → ~7 doručených |
| 1/3 delivered | STOP. Mullvad ceiling silnější než očekáváno. Pivot decision (B/C). |
| 0/3 delivered | STOP. Pivot mandatory. |

## Sprint AT5 — First day full (P0, 4 hours)

Pokud AT4 PASS, dokončit warmup_d0 cap (5/mailbox = 10 total) přes 4h okno.

**Co uděláme:**

Stagger 10 mailů přes 18:30-22:30 nebo zítra 10:00-14:00 (operator decide podle aktuálního času):

- Každých 24 min jeden send, alternuje mailbox
- AP1 cap 5/d per mailbox enforced via DB trigger
- AR8 GLOBAL_AGGREGATE_CAP 50/h soft limit (10 mailů ve 4h = 2.5/h, dobře pod capem)
- AR17 phase-aware window: warmup_d0 10-14 Praha (1.25/h cap per mailbox, 10/4h = 2.5/h celkově)

Posloupnost recipientů per priority: prvních 10 valid + non-suppressed kontaktů z campaign 457 (cc_id 244, 248, 250, 251, 252, 253, 254, 255, 256, 258).

**Decision gate AT5:**

| 24h delivery rate | Akce |
|---|---|
| ≥80% (≥8/10 delivered) | excellent — proceed AT6 |
| 60-79% (6-7/10) | acceptable s reservou — proceed AT6 ALE day-2 cap snížený 50% |
| 40-59% (4-5/10) | marginal — STOP, pivot needed |
| <40% | failure — STOP, pivot mandatory |

## Sprint AT6 — 24h monitoring (P0, passive)

Po dokončení 10 sendů 24h passive sledování.

**Co sleduj:**

- AP6 auth_locked status — žádný mailbox by se neměl objevit (AR11 bounce monitor zachytí dřív než auth-lock)
- AR11 bounce monitor result — bounces ratio
- AR15 endpoint reputation — cz-prg-wg-101 + 102 nemají abnormal bounce
- Replies — odpovědi z recipientů? AR10 reply chain simulation cron stejně bude polovat oba inboxy 4h
- Spam complaints — mailbox abuse@email.cz (manual check Seznam UI)
- Sentry: žádný `mailbox_bounce_rate_high`, `egress_chaos_detected`, `pool_exhausted`

**Decision gate AT6:**

| Status post-24h | Akce |
|---|---|
| 0 incidents + ≥1 reply | green light AT7 day-2 ramp |
| 0 incidents, 0 replies | proceed cautiously, day-2 same volume |
| 1+ auth_locked | STOP, investigate |
| bounce rate >5% next 24h | STOP, AR11 already paused mailbox |

## Sprint AT7 — Phase ladder ramp d3→production (P1, 30 dní)

Per AP1 lifecycle phase advance (auto-cron, 03:00 Praha daily).

**Schedule per AP1 + AR17:**

| Day | Phase | Cap/mailbox | × 2 | AR17 window | Spread |
|---|---|---|---|---|---|
| 0-2 | warmup_d0 | 5 | 10/d | 10-14 | 1.25/h |
| 3-6 | warmup_d3 | 10 | 20/d | 9-17 | 1.25/h |
| 7-13 | warmup_d7 | 25 | 50/d | 8-18 | 2.5/h |
| 14-29 | warmup_d14 | 50 | 100/d | 8-19 | 4.5/h |
| 30+ | production | 100 | 200/d | 8-20 | 8.5/h |

Total možný outbound volume v 30 dnech: cca 1500 mailů. Campaign 457 má 100 contacts (54 valid). Single campaign vyčerpá za první den + week, ale ramp drží reputaci v rostoucím režimu.

**Day-by-day decision:**

- Každý den 09:00 operator check Sentry + send_events za posledních 24h
- Pokud bounce rate > 3% prvních 7 dní → STOP, investigate
- Pokud bounce rate < 1% → continue
- Po 30 dnech production phase → operator decide další campaign

## Sprint AT8 — Mullvad reputation tracking (P2, continuous)

AR15 cron běží každých 6h, sleduje per-endpoint bounce ratio.

**Action items per AR15 alert:**

- Endpoint flagged (>2× avg bounce) → manual decision: re-pin mailbox na jiný endpoint nebo akceptovat
- Pokud >50% endpointů flagged → systemic issue, pivot decision
- Mullvad reputation drift over week → AR15 trends visible v `mailbox_egress_endpoint_health` table

## Otevřené otázky

1. **Send window override pro AT3 dnes večer?** — aktuální čas mimo 09-17, vyžaduje X-Force-Send. Nebo počkat zítra 10:00?
2. **Pivot threshold konkrétní procento** — 40% delivery = "marginal" je arbitrární. Možná 50%? Operator decide.
3. **Vlastní VPS plan B** — pokud Mullvad fail, máme nákupní path? €5-15/měsíc per VPS, deploy wgsocks bridge, integrate jako endpoint v `WIREPROXY_POOL_CONFIG`. Pre-shopped vendor (Hetzner/Vultr/DigitalOcean) připraven?
4. **Tracking pixel pro engagement signal** — AR2 audit removed pixel pro privacy. Bez pixelu nevíme open rate. Reply rate je proxy ale slabší. Akceptable pro warmup ale problem pro long-term metrics. Re-add po 30 dnech?
5. **Day-2+ campaign rozšíření** — má Goran další zdroje contacts (firmy.cz scraping?), nebo single 100-batch je celý plán?

## Co tato iniciativa NEDĚLÁ

- Pivot na vlastní VPS / transactional service (separate decision pokud AT3-AT5 fail)
- Re-write template content (final z 80+ iterací včera, schválené today)
- Více než 2 mailboxy (AS architectural fix #1171 P1 separate)
- Tracking pixel re-add (memory `feedback_no_unsub_url_in_body` HARD)
- Multi-campaign concurrent (single campaign 457 jako test)
- Day-30+ scaling (separate sprint po datech z first month)
