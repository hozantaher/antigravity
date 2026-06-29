# Pre-flight — Campaign 457 (Hozan Taher výkup techniky) launch

> Status: READY  
> Datum: 2026-05-13  
> Trigger: operator chce poslat první dávku z mailboxů taher.vykup / vykup.taher

## TL;DR

Otevři `/campaigns/457` → tab **Odeslání** → SendBatchPanel → klikni **Odeslat 5**.

Pokud chceš první živý send, otestuj sám sebou: nejprve **Odeslat 1**, dorazí na info@messing.dev (nebo jiný tvůj cíl) → ověř Inbox → pak **Odeslat 5** rozhodí do reálného cohortu.

## Zelené checky (10/10)

| # | Kontrola | Stav |
|---|---|---|
| 1 | Mailboxy 1053-1056 status=active, lifecycle=production, locale=cs, tz=Europe/Prague, has_password=true | ✅ |
| 2 | Daily cap per mailbox = 100/den (lifecycle production), spacing 180s = 3 min | ✅ |
| 3 | Žádný send today z taher / vykup schránek — celá kvóta 400/den k dispozici | ✅ |
| 4 | Campaign 457: status=paused, mailbox_min_spacing_seconds=180, mailbox_daily_cap_override=NULL | ✅ |
| 5 | Cohort 457: 23 751 pending, 7 448 in_flight (z minulých neúspěšných pokusů), 14 541 skipped, 166 completed | ✅ |
| 6 | Template intro_machinery: subject "Dotaz" (5b), body 593b, body_html 921b | ✅ |
| 7 | Operator settings: brand_label=Hozan Taher, controller_*=Hozan Taher/23219700/Praha, sender_company=Balkan Motors, sender_phone=776 299 933, legal_basis=Oprávněný zájem | ✅ |
| 8 | Anti-trace-relay /healthz → status ok (URL: anti-trace-relay-production-a706.up.railway.app) | ✅ |
| 9 | BFF /api/campaigns/457/send-batch endpoint reachable, count validation 1..100 active | ✅ |
| 10 | SendBatchPanel UI deployed na /campaigns/457 → tab Odeslání (PR #1333) | ✅ |

## Bezpečnostní bariéry zapnuté

- **Per-tick + 24h domain rotation** s freemail bypass (PR #1331) — corporate domény omezeny na 2/tick + 5/24h, freemail (seznam.cz, gmail.com, …) bez limitu.
- **DB trigger `trg_enforce_warmup_cap`** na send_events — žádný send nepřekročí lifecycle cap, ani když operator omylem natlačí víc.
- **Mailbox spacing 180s** — minimální mezera mezi sendy z téže schránky (3 min).
- **AR8 aggregate volume cap** — globální per-hour limit (env GLOBAL_AGGREGATE_CAP, default existuje v helperu).
- **AR17 phase-aware send window** — production phase = 8-20h, 9/hr per mailbox; mimo okno send_batch vrátí 412.
- **LIA scope filter** — send-batch helper respektuje legitimate-interest scope (B2B only, opt-out tracked).
- **FOR UPDATE SKIP LOCKED** — paralelní operator clicks neposílají duplicitně tomu samému kontaktu.
- **Operator audit log** v každé tx — kdo, kdy, kolik, kterej mailbox, kterej kontakt.
- **Idempotency key** per batch — opakovaný click v okně neodešle 2×.

## Rate plán

| Schránka | Cap/den | Spread (production) | Spacing min |
|---|---|---|---|
| taher.vykup@seznam.cz | 100 | 8-20h, 9/hr | 180s |
| vykup.taher@seznam.cz | 100 | 8-20h, 9/hr | 180s |
| taher.vykup@post.cz | 100 | 8-20h, 9/hr | 180s |
| vykup.taher@post.cz | 100 | 8-20h, 9/hr | 180s |

**Aggregate** = 400/den, 36/hr napříč všemi 4 schránkami.

Realisticky operator klikne **Odeslat 10** ~3-4× za hodinu (každých ~15-20 min) → 30-40 emailů/hr = ladí s rate plánem.

## Co dělat když

| Situace | Akce |
|---|---|
| SendBatchPanel vrátí "warmup_cap_exceeded" pro některou schránku | Ostatní schránky pokračují, počkej 1 hod nebo do dalšího dne |
| Endpoint vrátí 429 + Retry-After | Aggregate cap hit, počkej |
| Endpoint vrátí 412 + send_window_closed | Mimo 8-20h okno, počkej do rána |
| Bounce přijde na taher.vykup → IMAP poll | T4 R2 ještě nedosadí rfc_message_id matching → bounce zatím půjde do unmatched_inbound |
| Operator chce paused → running | Klikni "Spustit kampaň" v /campaigns/457 — Go runner se ji ujme, pokud mailbox ActiveAddresses() projde (T3 už mergnutý, fix nasazený) |

## Co NE

- ❌ Neotvírej `daily_cap_override > 0` u taher schránek — phase production už dává 100/den, override 50 by **snížil** cap.
- ❌ Neměň lifecycle_phase na "warmup_d0" — schránky už 2 dny aktivní, posuvný start zničí pacing model.
- ❌ Neměň template intro_machinery v DB — schválený obsah (Dotaz subject, Hozan Taher, Balkan Motors footer, GDPR § 7 + čl. 6/1/f).
- ❌ Nepouštěj Go runner pro 457 (status running) bez ověření že ActiveAddresses() v Railway logs neemituje Scan error po T3 deployu.

## Po každé dávce

1. Sleduj `/replies` — nové bounce / odpovědi by se měly objevit do 2 min po sendu (IMAP poll).
2. `/campaigns/457` → stats panel — sent count by měl narůst o N.
3. Sentry — žádný red error.

