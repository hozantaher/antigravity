# Gap Closure Plan — From comprehensive test audit to fully-tested production

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** 15 critical test gaps identified; folded into master plan phase 0 execution

**Builds on:**
- `docs/initiatives/2026-04-27-comprehensive-fixes.md` (S1-S8 — partially done)
- `docs/audits/2026-04-27-master-test-plan.md` (L0-L7 layered matrix)
- `docs/audits/2026-04-27-test-gaps-{send,reply,ops}.md` (118 features)

## Cíl

Uzavřít **15 critical gaps** identifikovaných v master test plan tak, aby
každá produkční funkce měla:
1. Unit / integration / contract test coverage
2. Real-time live verification
3. Failure mode dokumentován + handled
4. Hard rules respected (memory rules)

## Priorities legend

- **P0** = blocks first real send
- **P1** = important but not blocking
- **P2** = nice-to-have, schedule into next 30 days
- **P3** = backlog

## Sprinty

### S1 — Calendar correctness (P0, ~2h)

Czech holidays + DST jsou compliance-critical. Send on Easter Monday or
mis-shifted by 1 hour due to DST = ÚOOÚ-attackable.

| ID | Task | Acceptance |
|---|---|---|
| S1.1 | Property test: Easter for 2024-2030 (Meeus output vs known dates) | All Easter Mondays + Good Fridays match official CZ holiday calendar |
| S1.2 | Live test: InSendWindow at DST boundaries (2026-03-29 02:00 CET → 03:00 CEST, 2026-10-25 03:00 CEST → 02:00 CET) | Window respects new offset |
| S1.3 | Live test: NextSendTime spans weekend (Friday 17:00 → Monday 09:00) + holiday immediately after | Returns next workday 09:00 |
| S1.4 | Boundary test: 07:59:59 Mon = false, 08:00:00 = true; 16:59:59 = true, 17:00:00 = false | Exact boundary behaviour |

### S2 — Reply pipeline test coverage (P0, ~4h)

ReplyType action dispatch has 6 branches but ZERO tests. Suppression
cascade + lead upsert similarly bare. This is § 7 / GDPR core.

| ID | Task | Acceptance |
|---|---|---|
| S2.1 | Table-driven test for ReplyType switch (6 branches): Negative→close+suppress, AutoOOO→pause14d, Later→pause30d, Meeting→lead, Interested→lead, Objection→continue | Each branch has dedicated test case + verifies side effects |
| S2.2 | sqlmock test for upsertLead ON CONFLICT UPDATE | Both INSERT path (new) and UPDATE path (existing) verified |
| S2.3 | Integration test: outreach_suppressions INSERT → bf_e3 trigger fires → contacts.status='suppressed' (case-insensitive match) | Trigger verified end-to-end |
| S2.4 | Audit log test: each ReplyType emits correct EventType (Replied/Bounced/Suppressed) with proper metadata | Event JSON shape locked |
| S2.5 | LLM fallback test: confidence < 0.6 → regex classifier wins; confidence ≥ 0.6 → LLM result wins | Boundary cases pass |

### S3 — Send-status integrity (P1, ~3h, deferred from comprehensive-fixes S3)

Engine writes `send_events.status='sent'` even when relay later fails
delivery. DB lies about delivery outcome → analytics + cleanup downstream
broken.

| ID | Task | Acceptance |
|---|---|---|
| S3.1 | Decision: A) relay → orchestrator webhook OR B) engine polls relay status | Documented in this file |
| S3.2 | If B: add /v1/status/<envelope-id> endpoint to relay returning {status, error?} | Contract defined + tested |
| S3.3 | Engine async-poll after Submit (with backoff, max 30s) | send_events updated to delivered/failed |
| S3.4 | Test: simulate failed delivery, verify send_events status flips | TestEngine_RelayFailureUpdatesStatus |

### S4 — Ops hardening (P1, ~4h)

| ID | Task | Acceptance |
|---|---|---|
| S4.1 | Webhook circuit breaker: track per-mailbox failures, disable after 5 consecutive for 24h | watchdog test verifies disable/re-enable |
| S4.2 | DSR erasure: 30s timeout on cascade DELETE, SERIALIZABLE isolation, load test 100k+ rows | DSR test with synthetic 1M-row contact verifies completion <30s |
| S4.3 | Health surface panic recovery: log panic + Sentry event before returning nil | Add slog.Error with op + stack trace; assertion in test |
| S4.4 | Prometheus cardinality cap: 10k unique label values per metric, warn metric on exceed | Audit test counts unique labels per metric |

### S5 — Distributed migration runner safety (P2, ~2h)

`scripts/migrations/run.sh` has no file lock. Concurrent invocations
corrupt schema_migrations table.

| ID | Task | Acceptance |
|---|---|---|
| S5.1 | Add `pg_try_advisory_lock(MIGRATION_LOCK_KEY)` at script start | Concurrent runs: one waits, second fails fast |
| S5.2 | 60s timeout, exit code 6 on lock failure | CI documents handling |
| S5.3 | Smoke test: 2 parallel run.sh invocations | One succeeds, one fails clean |

### S6 — Self-send guard live verification (P0, 30 min)

Self-send guard committed in cc6072c but live behaviour untested in
production deploy.

| ID | Task | Acceptance |
|---|---|---|
| S6.1 | Run internal test campaign with mb=3 sender + a.mazher@email.cz recipient (mb=3 self) | Engine logs "all mailboxes at daily limit" because only mb=3 in pool, self-blocked |
| S6.2 | Add mb=631 to pool, repeat | Engine picks mb=631 (not mb=3), delivery succeeds |
| S6.3 | Document in master-test-plan as A.4 ✅ | Status updated |

### S7 — First real send (P0, ~30 min, GATED on Tomáš + window)

| ID | Task | Acceptance |
|---|---|---|
| S7.1 | Verify mb=3 OR mb=631 SMTP AUTH OK after recent pause cycle | /v1/auth-check returns ok=true |
| S7.2 | Reset contact 418176: current_step=0, next_send_at=NOW(), status=pending | Visible in campaign_contacts query |
| S7.3 | Restore campaign 455 status='running' | DB UPDATE (Tomáš GO required) |
| S7.4 | Wait for scheduler tick within window 8-17 Prague | Tick logs render OK + send OK |
| S7.5 | Verify send_events row + outreach_thread (Schema B may miss → graceful skip per S4 of comprehensive-fixes) | DB rows present |
| S7.6 | Monitor IMAP poll for any reply within 24h | reply_inbox + thread rows on reply |
| S7.7 | Tomáš explicit GO před S7.3 (memory `feedback_campaign_send`) | Recorded in send_log table of MVP plan |

### S8 — Post-launch hardening (P1, 1-2 weeks)

| ID | Task | Trigger |
|---|---|---|
| S8.1 | privacy@hozan-taher.cz inbox setup | After S7 |
| S8.2 | Footer update: include privacy@ DSR contact | After S8.1 |
| S8.3 | Retention cron (auto-delete >12 months, exclude suppressions) | Week 1 post-launch |
| S8.4 | LIA refresh for current scope (machinery export to MENA) | Week 2 |
| S8.5 | Bounce auto-suppress flow (hard bounce → suppress immediately, soft 3× → suppress) | Week 1 |
| S8.6 | Watchdog daemon callback — needs deployed BFF | After S9 |

### S9 — BFF deployment decision (P1, blocking S4.1+S8.6)

| ID | Task | Path |
|---|---|---|
| S9.1 | Decide: a) deploy as new Railway service / b) port to garaaage Nuxt / c) drop, use direct DB+relay | Architectural decision |
| S9.2 | If (a): Railway service `outreach-bff`, env from features/platform/outreach-dashboard/.env, deploy from main | Service live |
| S9.3 | If (b): port 144 endpoints to Nuxt server/api routes | Match contract |
| S9.4 | If (c): document direct-DB-only ops procedure | docs/playbooks/ops-without-bff.md |

### S10 — Mailbox 1 Seznam fix (P1, MANUAL)

| ID | Task | Owner |
|---|---|---|
| S10.1 | Login to mb=1 Seznam webmail, regenerate password OR generate app-password | Tomáš |
| S10.2 | UPDATE outreach_mailboxes SET password=<new>, status='active', status_reason='manual:resumed' WHERE id=1 | Tomáš |
| S10.3 | /v1/auth-check probe via relay confirms 235 OK | Verified |

## Dependencies

```
S1 (calendar) ─── independent
S2 (reply tests) ─── independent
S3 (send status) ─── independent
S4 (ops harden) ─┬─ S4.1 needs S9 (BFF deploy)
                 └─ S4.2/3/4 independent
S5 (migration lock) ─── independent
S6 (self-send live) ─── independent
S7 (first send) ─── needs Tomáš GO + send window
S8 (post-launch) ─── needs S7 done
S9 (BFF) ─── architectural
S10 (mb=1) ─── manual Tomáš
```

## Hard rules

1. NEsendovat na real B2B (campaign 455 → ing.martincech@centrum.cz) bez Tomášova explicit GO (memory `feedback_campaign_send`).
2. Mailbox passwords NIKDY do env / log / commit (memory `feedback_mailbox_passwords_via_db`).
3. Žádný direct SMTP z localhost (memory `feedback_no_direct_smtp`).
4. Suppression UNION pre-send check je gate.
5. Žádné nové services / external dependencies bez explicit ack (memory `feedback_no_external_services`).
6. Žádné nové monitoring stack mimo Sentry (memory `feedback_no_extra_monitoring`).
7. ≥10 test cases per change (memory `feedback_extreme_testing`).

## Otázky pro Tebe (gates)

| Gate | Otázka | Default |
|---|---|---|
| S3.1 | Webhook from relay (path A) nebo polled by engine (path B)? | B (less work, less coupling) |
| S7.7 | Real send GO zítra ráno 8-17 Prague? | čeká explicit GO |
| S9.1 | BFF deployment path: deploy/port/drop? | port (lowest cost, BFF has 144 endpoints used by Nuxt anyway) |
| S10 | Můžeš vyřešit mb=1 Seznam credential? | manual jen Ty |

## Execution order (autonomously, propose-execute-summarize)

1. **Today/now** (autonomous): S1, S2, S6, S5
2. **Tomorrow morning** (gate dependent): S7 (after Tomáš GO)
3. **This week** (mid-effort): S3, S4 (excluding S4.1)
4. **Next week** (architectural): S9 then S4.1, S8.6
5. **Next 2 weeks** (compliance): S8

## Send log

| Date | Recipient | Outcome | Envelope ID | Notes |
|---|---|---|---|---|
| 2026-04-27 19:06:12 UTC | b.maarek@email.cz (mb=631) | DELIVERED | env_34b756aa48f4f886ca28728b | direct relay submit |
| 2026-04-27 20:00:01 UTC | a.mazher@email.cz (mb=3 self) | DELIVERED | env_dbe900dbfdff2bed041c3be8 | campaign 456 step 0 |
| 2026-04-27 20:04:18 UTC | b.maarek@email.cz (mb=631) | FAILED | env_1657e3481268bd87ada0d174 | relay outbound_smtp_failed |
