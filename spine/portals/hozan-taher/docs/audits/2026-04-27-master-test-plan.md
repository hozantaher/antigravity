# Master Real-Time Test Plan — hozan-taher production pipeline

> 2026-04-27 evening. Built on top of inventory:
> - docs/audits/2026-04-27-test-gaps-send.md (35 features)
> - docs/audits/2026-04-27-test-gaps-reply.md (35+ features)
> - docs/audits/2026-04-27-test-gaps-ops.md (48 features)
>
> 118+ features catalogued, ~15 critical gaps.

## Test execution layers

| Layer | What it exercises | Tooling |
|---|---|---|
| L0 unit | Pure functions, individual structs | go test |
| L1 integration | Single service + DB (sqlmock or pg-mem) | go test integration tag |
| L2 contract | Inter-service contracts (HTTP, DB schema) | runner_audit_contract_test, antitrace_contract_test |
| L3 chaos | Markov sims, failure injection | tests/chaos (frontend) |
| L4 property | Invariants under random input | fast-check (frontend), property tests (Go) |
| L5 audit | Discipline ratchets | tests/audit, slog_op_audit_test |
| L6 synthetic | Continuous prod monitoring | tests/synthetic, /api/health/invariants |
| **L7 real-time** | **Live system, real DB, real relay, real SMTP** | **THIS DOC** |

## Real-time test domains (L7)

### Domain A — Send pipeline live

| ID | Test | Method | Expected | Status |
|---|---|---|---|---|
| A.1 | Render template v35 for synthetic contact | run intro_machinery.tmpl through engine.Render() with TemplateVars | subject="Plánujete prodej techniky?", body 869 B | ✅ verified earlier |
| A.2 | HMAC unsub token roundtrip | call buildUnsubURL, parse with token.VerifyUnsub | matches contact_id, campaign_id, email | TODO |
| A.3 | Suppression UNION blocks both tables | INSERT into outreach_suppressions only, runner skips; INSERT into suppression_list only, runner skips | both queries return 0 rows from runner SELECT | TODO |
| A.4 | Self-send guard rejects mb=recipient | enroll a.mazher@email.cz as recipient, mb=3 (a.mazher) only | engine logs "no available mailbox" | partially via campaign 456 self-send (mb=3 sent to mb=3 — guard added AFTER, deployed cc6072c) |
| A.5 | Send window engine gate (defense-in-depth) | runner enqueues outside window via SKIP_CALENDAR_CHECK, engine still blocks | enqueued=N, no actual delivery | ✅ verified at 19:37 UTC (count=1 enqueued, no delivery) |
| A.6 | Domain rotation per-tick (MaxPerDomainPerTick=2) | enroll 5 contacts at @example.cz, run tick | enqueued=2, 3 logged "domain rotation skip" | TODO |
| A.7 | Holding cluster cap (HoldingClusterCap=1) | enroll 3 contacts with parent_ico=X, run tick | enqueued=1, 2 logged "holding cluster blocked" | TODO |
| A.8 | Step CAS race | 2 concurrent runners on same campaign | exactly 1 advances, other logs "matched 0 rows" | TODO |
| A.9 | plainToHTML XSS escape | Render template with `<script>alert('xss')</script>` in field | `&lt;script&gt;` in BodyHTML output | TODO |
| A.10 | Czech holiday gate (Easter Monday 2026 = Apr 6) | run tick on Apr 6 with SKIP_CALENDAR_CHECK unset | scheduler logs "skipped non-sendable day" | TODO |
| A.11 | DST boundary InSendWindow (2026-03-29 02:00 → 03:00 Prague) | call InSendWindow at boundary | window respects new offset | TODO |
| A.12 | Anti-trace /v1/submit with invalid recipient | submit envelope to test+invalid@firma.cz | relay accepts (sealed), later outbound_smtp_failed | TODO |

### Domain B — Reply pipeline live

| ID | Test | Method | Expected | Status |
|---|---|---|---|---|
| B.1 | IMAP poll picks up internal-test send to mb=631 | wait 2 min for poll | reply_inbox row OR thread row | TODO (relay had outbound_smtp_failed for env_1657e3 → never arrived at mb=631) |
| B.2 | Bounce detection RFC 3464 Status field | inject synthetic DSN via mailsim.Bouncer | DetectBounce returns hard, processBounce updates contact | TODO |
| B.3 | Reply classifier "nechci" → ReplyNegative | inject synthetic reply with body="nechci" | ClassifyReply returns ReplyNegative | TODO |
| B.4 | Suppression cascade ReplyNegative | trigger ReplyNegative on contact 44853153 | outreach_suppressions INSERT + bf_e3 trigger fires | TODO |
| B.5 | OOO classifier (auto-replied + Auto-Submitted) | inject reply with X-Autoreply: yes | ReplyAutoOOO + thread.Pause(14d) | TODO |
| B.6 | Lead upsert on positive | inject reply "máme zájem" | leads row INSERT with status=new, source=reply_classifier | TODO |
| B.7 | Hard bounce → contacts.status='bounced' | inject DSN with Status: 5.7.1 | contacts.status flips, thread → 'bounced' | TODO |
| B.8 | Soft bounce → pause 3 days | inject DSN with Status: 4.3.0 | thread.next_action_at = NOW + 3d | TODO |

### Domain C — Tracking + protections

| ID | Test | Method | Expected | Status |
|---|---|---|---|---|
| C.1 | /o pixel with bogus token | GET /o?t=abc123 | 200, but no tracking_events row (BF-D4 EXISTS guard) | ✅ verified |
| C.2 | /o pixel with valid token | (HMAC-encoded send_event_id) | tracking_events INSERT with event_type='opened' | partial — token format unclear |
| C.3 | /c click redirect with bogus | GET /c?t=abc123&u=https://example.com | 302 to example.com, no event | ✅ verified |
| C.4 | /c click with valid token | as above with valid token | 302 + tracking_events INSERT event_type='clicked' | TODO |
| C.5 | /unsubscribe with valid HMAC | GET /unsubscribe?t=<token> | suppression INSERT, 200 OK | TODO |
| C.6 | /unsubscribe with tampered HMAC | invalid token | 400 Bad Request, no INSERT | TODO |
| C.7 | DSR /api/dsr/access | GET with email param | 200 + 8-table aggregate JSON | TODO |
| C.8 | DSR /api/dsr/erase | POST with email | 5-table cascade, audit log row | TODO (DESTRUCTIVE, needs synthetic only) |
| C.9 | Health surfaces stale_advisory_lock | introduce stale lock manually | /health degraded, lock_id in response | TODO |
| C.10 | Greylist queue depth | check queue | /health greylist_queue_depth populated | TODO |

### Domain D — Watchdog + auto-heal

| ID | Test | Method | Expected | Status |
|---|---|---|---|---|
| D.1 | Auth-fail spike → swapProxy | inject 3 mailbox_auth_fails rows in <1h window | watchdog tick swaps proxy_url | TODO (BFF not deployed → swap path disabled) |
| D.2 | Bounce decay 24h quiet | mailbox with consecutive_bounces=2, no recent bounce | next watchdog tick → counter --1 | TODO |
| D.3 | Circuit breaker auto-resume | mailbox circuit_opened_at older than ttl | watchdog tick resumes | TODO |
| D.4 | Heartbeat dedup 10min | trigger watchdogFromBFF twice in 5min | second skipped via dedup | N/A (BFF not deployed) |
| D.5 | Audit log entry for every heal action | every auto-recover writes watchdog_events row | rows incremented | ✅ verified (heartbeat events visible) |

### Domain E — Schema integrity

| ID | Test | Method | Expected | Status |
|---|---|---|---|---|
| E.1 | bf_e3 trigger mirror | INSERT into outreach_suppressions, check contacts | contacts.status='suppressed' for matching email | ✅ verified during cleanup |
| E.2 | campaign_lock_audit on tick | check audit table after scheduler tick | row exists with held_for_ms | TODO |
| E.3 | Suppression case+whitespace | INSERT with " A.MAZHER@EMAIL.CZ " | runner blocks lower(trim()) | ✅ verified (sender-self entries normalised) |
| E.4 | UNIQUE constraint on (contact_id, campaign_id) in leads | concurrent INSERT same pair | one wins, other ON CONFLICT UPDATE | TODO |
| E.5 | Schema migrations idempotent | re-run 005 + 007 | no errors, NOTICE: trigger exists | ✅ verified during migration apply |

## Critical real-time tests prioritised (top 10)

1. **A.2 HMAC unsub token roundtrip** — without this no opt-out works
2. **A.6 Domain rotation per-tick** — protects sender reputation
3. **A.7 Holding cluster cap** — same
4. **A.9 plainToHTML XSS** — security boundary
5. **B.3 + B.4 Reply "nechci" → suppress** — GDPR / § 7 compliance
6. **B.7 Hard bounce → contact bounced** — list hygiene
7. **C.5 + C.6 /unsubscribe HMAC verify** — security + GDPR
8. **C.7 DSR access** — Article 15 obligation
9. **D.1 Watchdog swapProxy** — currently broken (BFF not deployed) — known gap
10. **A.5 Engine window gate (defense-in-depth)** — already verified

## Test execution sandbox

To execute tests safely:

1. Use synthetic contacts with `email_status='valid'` but with company.email_status != 'valid' to suppress sender side
2. Or use suppression_list pre-population to block actual delivery
3. Or use a test campaign with mailbox_pool=[] (no mailbox can pick) for render-only tests
4. Always leave campaign 455 + production mailboxes paused while testing

## Hard rules during testing

- Never UPDATE outreach_mailboxes status to 'active' for mb=1 (broken Seznam auth)
- Never UPDATE campaign 455 status to 'running' without explicit user GO
- Never INSERT into campaign_contacts for campaign 455 (real recipient list)
- Never call /api/dsr/erase on real contacts without snapshot
