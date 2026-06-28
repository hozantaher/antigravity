# Reply Pipeline Recovery — make replies/bounces actually surface

> **Status**: Closed (R1-R6 vše merged 2026-05-13)
> **Datum**: 2026-05-13
> **Trigger**: Operator zjistil 146 sent / 0 replies v `reply_inbox` po 2 dnech kampaně 457. Drilldown odhalil 2-3 reálné B2B reply a ~7 bounces čekají v `unmatched_inbound`, klasifikační pipeline nematchuje.
>
> **Outcome (2026-05-13)**:
> - R1 RCA + R2 rfc_message_id (#1335) + R3 unmatched bounce (#1336) + R4 sidebar badge (#1337) + R5 test filter (commit ac481277) + R6 E2E test (#1339).
> - Backfill: 6 contacts → email_status='bounce_hold' (PR #1336). 21 unmatched → 3 reálné B2B odpovědi (AGD, AGAU, PMDP) zbylé pro operator manual review.
> - 400 thread package tests green (+11 R6 cases).

## Cíl

Operator chce vidět **každý reply + každý bounce** v `/replies` UI do 1 minuty od příchodu. Aktuálně:

- **146 emails sent** za kampaň 457 (2 dny, 2 mailboxy)
- **0 rows** v `reply_inbox` — UI ukazuje žádné replies
- **22 rows** v `unmatched_inbound` (21 unreviewed) — skutečné replies + bounces čekají bez review
- Reply rate skutečnost: **~1.5–2%** (2-3 real B2B replies), bounce rate **~4-5%** (7+ bounces), ne `0%` jak ukazuje UI

## Root cause (3 propojené bugy)

### Bug 1 — `send_events.message_id` ≠ RFC 5322 Message-ID

`send_events.message_id` column drží **internal envelope ID** (`env_f8167a8e33deda950da6c232`). Skutečný RFC 5322 `Message-ID` header v doručeném emailu (např. `<19f0a203e32d950b.1778536968367539313@seznam.cz>`) je generován Seznam SMTP a NIKDY se neuloží.

Reply matching v `features/inbound/orchestrator/thread/inbound.go` (nebo BFF reply ingest) hledá `unmatched_inbound.in_reply_to → send_events.message_id`. Protože sloupec drží jiný ID, **lookup vždy selže** → reply jde do `unmatched_inbound` místo `reply_inbox`.

### Bug 2 — Bounce DSN parsing chybí

Bounce zprávy (Mailer Daemon postmaster@seznam.cz, MAILER-DAEMON@in4.smtp.cz) přicházejí jako standardní emails s DSN body:

```
Vaše zpráva pro <objednavky@radoststavby.cz> ze dne 12.05.2026 nemohla být doručena.
```

Aktuálně:
- Žádný parser nečte DSN body → bounce zůstává v `unmatched_inbound`
- `send_events.status` nikdy neflipne na `'bounced'`
- `contacts.email_status` neflipne na `'bounce_hold'`
- Recipient dostane další pokus v dalším kroku sekvence (waste of mailbox quota)

### Bug 3 — UI nepingá operatora o `unmatched_inbound`

`unmatched_inbound` má 21 unreviewed rows, ale dashboard nikde nezobrazí badge. Operator musí explicit otevřít `/replies` filter `?unmatched=true` nebo SQL query. **Žádná UI signalizace** že čeká 21 messages na klasifikaci.

## Cílový stav

```
INBOX                                    DETECTOR                   STORAGE
┌─────────────────┐                     ┌──────────────────┐      ┌─────────────────┐
│ IMAP folder     │  →  inbound.go  →   │ Reply matcher    │  →   │ reply_inbox      │
│   INBOX/Reply   │                     │  In-Reply-To →   │      │   (linked)       │
│                 │                     │  rfc_message_id  │      └─────────────────┘
└─────────────────┘                     │                  │      ┌─────────────────┐
                                        │ Bounce DSN       │  →   │ send_events      │
                                        │  parser          │      │   status=bounced │
                                        │                  │      │ contacts         │
                                        │                  │      │   email_status=  │
                                        │                  │      │   bounce_hold    │
                                        │                  │      └─────────────────┘
                                        │ Fallback         │  →   │ unmatched_inbound│
                                        │                  │      │   (with badge!)  │
                                        └──────────────────┘      └─────────────────┘
```

## Sprinty

### Sprint R1 — Diagnose + measure (P0, 30 min)

Read-only investigation. Cíl: confirm 3 bug hypotheses před implementací.

- Verify `send_events.message_id` schema vs reality (already done above)
- Read `features/inbound/orchestrator/thread/inbound.go` match logic — kde to selhává
- Count bounce messages v unmatched za posledních 30 dní napříč campaigns
- Vyrobit RCA dokument `docs/audits/2026-05-13-reply-pipeline-rca.md`

**Acceptance**: RCA dokument s git SHA + exact code locations + measured baseline.

### Sprint R2 — RFC 5322 Message-ID capture (P0, 1-2h)

Nový sloupec `send_events.rfc_message_id` (text, nullable). Při send IMAP APPEND do Sent folder fetch real Message-ID header z appended message, store. Backfill pro 146 existing rows přes IMAP scan posledních 7 dní.

- Migration `110_send_events_rfc_message_id.sql` — ADD COLUMN + INDEX `idx_send_events_rfc_msgid`
- `features/outreach/relay/internal/.../append.go` — po APPEND fetch UID, parse Message-ID, return up the chain
- Reply matcher: lookup `unmatched.in_reply_to → send_events.rfc_message_id` first, fallback na envelope_id
- Backfill: scan IMAP `goran.nowak/`+`nowak.goran` Sent folder, match envelope_id → rfc_id

**Acceptance**:
1. Po fresh send, query `SELECT rfc_message_id FROM send_events ORDER BY sent_at DESC LIMIT 1` vrací non-null `<...@seznam.cz>` formát.
2. Replay 3 unmatched (AGD, AGAU, PMDP) → 3 rows v `reply_inbox` s vyplněným `send_event_id`.
3. `feedback_schema_verify_before_sql` HARD rule dodržen (psql `\d` před query).

### Sprint R3 — Bounce DSN parser (P0, 1-2h)

Detect bounce messages by `From:` patterns (postmaster@*, MAILER-DAEMON@*) + `Subject:` patterns (Undelivered, Nedoručitelná, Rejected). Parse body extracts original recipient + diagnostic code. Flip `send_events.status='bounced'` + `contacts.email_status='bounce_hold'` v same tx.

- New `features/inbound/orchestrator/thread/bounce_parser.go`
- Patterns: `BounceFromPatterns` regex list (postmaster, MAILER-DAEMON, mailer-daemon) jako named const per `feedback_no_magic_thresholds`
- Extract recipient z `Final-Recipient:` (DSN RFC 3464) nebo regex `<([^>]+@[^>]+)>` v body
- Audit log INSERT per `feedback_audit_log_on_mutations`
- Update Sprint M5 reputation panel (bounce_rate teď bude reálné, ne `0%`)

**Acceptance**:
1. Process 7 unmatched bounces v `unmatched_inbound` → 7 contactů má `email_status='bounce_hold'`.
2. Send_events.status='bounced' count > 0.
3. Reputation panel M5 vidí non-zero bounce.

### Sprint R4 — Unmatched badge v UI (P1, 30-60 min)

Dashboard sidebar item "Odpovědi" má badge (sprint F1 SSE) ukazuje unhandled replies. Přidat **vedlejší badge** "21 nezpracovaných" pro `unmatched_inbound` count. Click → `/replies?tab=unmatched`.

- Update `Layout.jsx` sidebar nav — add unmatched count from `/api/replies/stats` (already exists per F1)
- Style: red dot pro unmatched count > 0 (distinguishable from unhandled)
- Smoke row: `/`, `mustSee: 'nezpracovaných'` tag F6

**Acceptance**:
1. Po landing `/`, sidebar zobrazí "Odpovědi" + red dot s number > 0.
2. Click → `/replies?tab=unmatched` filter, ukáže 21 entries.
3. Smoke test green.

### Sprint R5 — Test message filter (P1, 30 min)

Vlastní smoke/test emails (Subject prefix `[smoke]`, `[test-B]`, `[hdr-test]`) **přicházejí do unmatched** a znečišťují operator's queue. Per HARD `feedback_test_send_synthetic_only` jsou test messages syntetické — mají detectable prefix. Filter před INSERT do `unmatched_inbound`.

- New const `TEST_SUBJECT_PATTERNS = ['[smoke]', '[smoke-clean]', '[hdr-test]', '[test-A]', '[test-B]', 'probe ']`
- `features/inbound/orchestrator/thread/inbound.go` — pokud Subject matches, SKIP insert + log `[inbound] discarded test message subj=<prefix>`
- Backfill: DELETE existing test rows v unmatched (10 ks)

**Acceptance**:
1. Send vlastní `[smoke]` reply → not appear in unmatched_inbound
2. 21 unreviewed → ~11 (10 test messages removed)
3. Per HARD `feedback_test_send_synthetic_only` cross-ref dokumentován.

### Sprint R6 — End-to-end test (P2, 1h)

Integration test: send synthetic email → fake IMAP append → process inbound → assert reply_inbox row exists s correct `send_event_id`.

- `tests/integration/reply-pipeline-roundtrip.test.js` — uses pg-mem + mock IMAP
- 5 cases: real reply (RFC 5322 matching), bounce (DSN parsing), test message (filtered), unmatched fallback, threading (Re: Re: chain)
- Failing test counter: was 0 pre-fix, expects 5/5 post-R2+R3+R5

**Acceptance**: 5/5 tests green. Pipeline regression-safe.

## Sekvencování + závislosti

- **R1 → R2 → R3 → R4 → R5** sequential (R2 unblocks R6, R3 unblocks R4 unmatched count is wrong)
- **R6** depends na R2+R3+R5 hotové
- R1 jen read-only — agent can produce RCA in 30 min
- R2 + R3 jsou meaty backend changes — Sonnet tier
- R4 + R5 + R6 jsou Haiku tier (UI badge, regex filter, integration test)

## Estimát

- R1: 30 min (Haiku)
- R2: 1.5h (Sonnet)
- R3: 1.5h (Sonnet)
- R4: 45 min (Haiku)
- R5: 30 min (Haiku)
- R6: 1h (Haiku)
- **Total**: ~6h serial, ~3h paralelně (R4+R5 spolu po R3, R6 po R5)

## Riziko

- Backfill rfc_message_id pro 146 existing rows — pokud IMAP Sent folder neobsahuje, fallback je accept nemůže reattribute = ztracené.
- Bounce parser false positives — některé legit "Rejected:" subjects mohou být real reply o rejekci nabídky. Whitelist by From: MAILER-DAEMON only.
- UI badge — žádný.

## Cross-reference HARD rules

- `feedback_schema_verify_before_sql` T0 — psql `\d send_events` před R2 migration
- `feedback_node_check_before_commit_server_js` T0 — pre-commit verify R3 + R4 BFF code
- `feedback_audit_log_on_mutations` T0 — R3 status flip + R4 unmatched mark-reviewed
- `feedback_smoke_gate_operator_strict` T0 — R4 + R6 musí FAIL na 4xx/5xx
- `feedback_verify_agent_self_report` T0 — verify each sprint's PR merged + endpoint responds before next
