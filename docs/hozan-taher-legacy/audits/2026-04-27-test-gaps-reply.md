# REPLY/INBOUND Pipeline: Feature Catalogue & Test Gap Analysis
**Date:** 2026-04-27  
**Scope:** IMAP poller, inbound processor, bounce detection, reply classification, lead upsert, audit logging

---

## 1. IMAP Poller (features/inbound/orchestrator/imap/poller.go)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| UID watermark + delta detection | poller.go:230–243 | `poll_once_test.go` + `coverage_gaps_test.go` | ~85% | Missing: UID collision handling when two messages share same Message-ID; runWithReconnect backoff saturation (5m cap) not verified in production scenario | Monitor `lastPoll` timestamp drift; inject duplicate UUIDs via mock IMAP; verify backoff ceiling with artificially slow connects |
| Reconnect backoff (exponential, 5m cap) | poller.go:107–143 | `coverage_gaps_test.go` covers cap logic | ~80% | Edge case: backoff reset on success not verified under concurrent-failure patterns; timeout handling during dial phase under-tested | Simulate network partition; measure backoff progression via logs; confirm reset on first successful poll |
| NOOP heartbeat (20min interval) | poller.go:159–176 | `coverage_gaps_test.go` includes noop branch | ~90% | Live heartbeat never tested in prod; NOOP response parsing not validated against real IMAP servers (Fastmail, Gmail, GreenMail) | Deploy canary; capture raw NOOP responses; verify TCP keepalive doesn't interfere |
| Message-ID deduplication | poller.go:78–89 | Implicit in poll_once; no explicit table-driven test | ~70% | Missing: fallback to UID-based key (line 257) not exercised; collision under rapid repoll not covered | Craft message without Message-ID; poll same UID twice; check `seen` map behavior |
| IMAP FETCH header/body parsing (net/mail) | poller.go:362–450 | `imap_test.go` covers basic RFC 2822; `coverage_gaps_test.go` covers fallback | ~75% | Missing: real-world edge cases (broken CRLF, missing headers, >200KB bodies); Fastmail vs. GreenMail ordering variance (headers first vs. body first) | Use actual IMAP server fixtures; feed pathological RFC 822 fragments; verify literal extraction on out-of-order responses |
| MIME boundary extraction (extractIMAPLiteral) | poller.go:454–501 | `coverage_gaps_test.go` covers literal + fallback paths | ~80% | Missing: brace-mismatch edge case (stray `{` in header URL); count overflow (count > buffer); negative count handling | Inject malformed IMAP literal markers; test >32KB literal chunk detection |
| Graceful context cancel | poller.go:151–176 | `poll_once_test.go:39–63` (cancelled context) | ~85% | Missing: in-flight read()/write() cancellation on slow servers (>10s deadlines) | Cancel mid-FETCH; verify clean connection teardown; confirm no zombie goroutines |

**Test Count:** 8 tests in poll_once_test.go + 12+ in coverage_gaps_test.go  
**Monkey/Property Tests:** Quick-based NoPanic check on extractMailBody (coverage_gaps_test.go:80–88)

---

## 2. Inbound Processor (features/inbound/orchestrator/thread/inbound.go)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| ProcessReply: match to thread (In-Reply-To + References) | inbound.go:69–178 | `n3_inbound_property_test.go:62–77` | ~85% | Missing: References header with 5+ Message-IDs (RFC 5322 allows arbitrary depth); no-match path with nil DB never hits DB calls | Feed long References chain; trace which Message-ID is matched first |
| Bounce gate (BEFORE reply classify) | inbound.go:85–87 | `process_bounce_test.go` + `bounce_test.go` | ~90% | Missing: integration test confirming bounce path suppresses reply-classification fallback (ensures MAILER-DAEMON phrases don't misclassify as "interested") | Send real DSN; confirm reply_type='bounced' not processed through humanize.ClassifyReply |
| Reply classification (keyword + LLM fallback) | inbound.go:89–99 | `classify_test.go` + `classify_llm_test.go` (mock Ollama) | ~85% | Missing: LLM classification failure → keyword fallback chain not end-to-end tested; confidence threshold (0.6) enforcement missing from Go code | Inject LLM timeout; verify humanize.ClassifyReply is invoked as fallback |
| ReplyType → action dispatch | inbound.go:122–175 | `process_bounce_test.go` (bounce only); reply actions untested | ~40% | **CRITICAL**: No tests for ReplyInterested/ReplyMeeting/ReplyObjection/ReplyNegative/ReplyLater/ReplyAutoOOO action branches; upsertLead never tested; onInterested hook never fired in tests | Add table-driven tests for each ReplyType; verify contact.status='suppressed' on negative; confirm pause duration (14d OOO, 30d Later) |
| Lead upsert (UNIQUE contact_id, campaign_id) | inbound.go:160, 169 | **NOT TESTED** | 0% | **CRITICAL**: ON CONFLICT UPDATE contract never verified; concurrent upserts; campaign_id join logic missing from test | Mock multi-contact upserting; verify idempotency; test duplicate suppression |
| Record inbound message | inbound.go:103–116 | Implicit via `process_bounce_test.go:21` (RecordInbound mock) | ~60% | Missing: InboundMessage fields (Sentiment, ReplyType) validation; BodyPlain truncation to 2000 chars not tested | Feed >5000 char reply; verify stored truncation |
| matchToThread DB error handling | inbound.go:276–305 | `n3_inbound_property_test.go:62–77` (no-match path); error path not covered | ~50% | Missing: QueryRow error (non-ErrNoRows) → fmt.Errorf wrapping; References iteration loop with partial matches (e.g., 2nd Message-ID succeeds after 1st fails) | Inject DB error in mid-References scan; verify early exit |

**Test Count:** 3 files (process_bounce_test.go, n3_inbound_property_test.go, classify_test.go); 15+ tests total  
**Major Gaps:** ReplyType action dispatch (6 branches, 0 tests); lead upsert (0 tests)

---

## 3. Bounce Detection (features/inbound/orchestrator/thread/bounce.go)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| RFC 3464 envelope heuristics (From, Subject, X-Failed-Recipients) | bounce.go:79–112 | `bounce_test.go:23–128` (7 tests covering gate logic) | ~95% | Missing: X-Failed-Recipients header detection (line 126) never tested; mixed-case header variants (X-Failed-Recipients, x-failed-recipients) | Craft DSN with header-case variance; verify looksLikeBounceEnvelope matches |
| DSN Status: field parsing (5.x.x vs 4.x.x) | bounce.go:85–104 | `bounce_test.go:23–56` | ~95% | Missing: malformed Status (e.g., 5.x, 5.x.x.x, non-numeric); multi-line Status fields | Feed Status: 5.x (incomplete); verify regex doesn't match |
| Action: delayed downgrade (5.x.x → soft) | bounce.go:108–110 | `bounce_test.go:86–101` | ~95% | Missing: case-insensitive Action matching variance (Action: DELAYED, Action: Delayed); Action on soft bounce (4.x.x) should be no-op | Test Action: DELAYED with 4.2.2; confirm BounceSoft unchanged |
| Fallback NDR detection (plain text, no Status field) | bounce.go:135–151 | `bounce_test.go:130–163` | ~90% | Missing: "mailbox unavailable" (singular vs plural); delayed+temporary-failure keyword combinations | Craft old-style Postfix NDR without Status; feed "box full"/"mailbox full" variants |
| Final-Recipient / Diagnostic extraction | bounce.go:155–161 | `bounce_test.go:29–41` (FailedRecipient + Diagnostic captured) | ~95% | Missing: multi-recipient DSNs (multiple Final-Recipient fields); Diagnostic code with newlines (multi-line SMTP response) | Craft RFC 3464 with 5 recipients; verify only first captured |
| BounceInfo.IsBounce() contract | bounce.go:36–38 | `process_bounce_test.go` (implicit); `bounce_test.go` (implicit) | ~95% | Missing: BounceNone edge case explicitly tested | Create BounceInfo with Kind="" and verify !IsBounce() |

**Test Count:** 8 tests in bounce_test.go  
**Coverage:** 95% + monkey tests not present for edge cases

---

## 4. Reply Classification (features/platform/common/humanize/response.go + features/inbound/inbox/reply/)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| Keyword-based classifier (Czech keywords) | response.go:69–115 | Implicit in orchestrator tests; no dedicated unit tests | ~60% | **CRITICAL**: Czech keywords (nemáme zájem, nechci, odhlásit, zájem, zavolej, schůzka, později, mimo kancelář) never unit-tested in isolation; substring matching vs word-boundary matching not covered | Extract keywords into test table; verify each keyword triggers correct ReplyType; test false positives (e.g., "zajímavo" should not match "zájem") |
| LLM classifier (Ollama JSON response) | classify.go:63–76 + classify_llm_test.go | `classify_llm_test.go:31–78` (mock server tests) | ~85% | Missing: LLM response with extra fields (wrapper JSON); confidence score extraction (if Ollama returns {response, confidence, done}); fallback chain when LLM returns unknown category | Test Ollama response with extra fields; verify ClassUnknown maps unknown strings; test ErrEmptyReply path |
| Confidence threshold (0.6) enforcement | classify_llm_test.go | **NOT TESTED** | 0% | **CRITICAL**: JavaScript llmReplyClassifier.js has confidence threshold; Go code doesn't enforce it; no cross-service contract test | Verify Go orchestrator/reply handles low-confidence responses; test JS→Go confidence propagation |
| Classification enum contract (6 classes) | classify_test.go:77–89 | `ValidClasses` frozen at 6 | ~95% | Missing: new class addition detection (test will fail if enum grows without UI update) | Add 7th class intentionally; verify test catches it |
| NLM fallback on error | classify_llm_test.go:63–78 | `classify_llm_test.go:63–78` (500 error) | ~85% | Missing: timeout fallback (>5s LLM latency); partial response (incomplete JSON) | Inject 5s+ latency; verify timeout → fallback |

**Test Count:** 18+ tests across classify_test.go, classify_llm_test.go, property_test.go  
**Monkey Tests:** `TestProperty_Normalize_*` (idempotency, bounds checking) in property_test.go

---

## 5. Lead Upsert & Suppression (inbound.go:160, 169, 133–140)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| Lead upsert (upsertLead function) | inbound.go:160, 169 | **NOT TESTED** | 0% | **CRITICAL**: Function never tested; ON CONFLICT UPDATE contract not verified; null campaign_id handling | Add test with sqlmock: INSERT into outreach_leads ON CONFLICT; verify UPDATE arm |
| Suppression cascade (outreach_suppressions → bf_e3_mirror_suppression trigger) | inbound.go:133–140 | **NOT TESTED** | 0% | **CRITICAL**: Trigger not verified in integration; contacts.status='suppressed' update dependency missing | Trace suppression INSERT → verify trigger fires; confirm contacts.status changes in same txn |
| Negative reply → thread close + suppress | inbound.go:123–142 | **NOT TESTED** | 0% | **CRITICAL**: Action dispatch for ReplyNegative never exercised; suppression path untested | Mock ReplyNegative classification; verify Close() called; verify suppression INSERT |
| OOO pause (14 days) | inbound.go:143–146 | **NOT TESTED** | 0% | Pause duration never verified against Manager.Pause contract | Verify inbound.go calls Pause(ctx, threadID, time.Now().AddDate(0,0,14)) |
| Later pause (30 days) | inbound.go:148–151 | **NOT TESTED** | 0% | Similar to OOO | Verify pause duration = 30 days |

**Test Count:** 0  
**Critical Gaps:** All 5 features untested

---

## 6. Audit Logging (features/inbound/orchestrator/thread/events.go)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| EventReplied logging | events.go:114–121 | **NOT TESTED** | 0% | Missing: LogReplied contract (event type, contact_id, thread_id, message_id) | Verify INSERT into outreach_events with EventReplied type |
| EventBounced logging + counter updates | events.go:122–134 | `process_bounce_test.go:33–45` (mock expectation only) | ~60% | Missing: counter increment verification (total_bounced, domain bounces); concurrent LogBounced calls | Execute LogBounced; verify outreach_contacts.total_bounced incremented |
| EventComplained (DSR GDPR) | events.go:135–147 | **NOT TESTED** | 0% | Missing: LogComplained integration | Test LogComplained event insertion |
| EventSuppressed (on negative reply) | events.go:148–160 | **NOT TESTED** | 0% | Missing: LogSuppressed verification | Verify suppression event logged with correct metadata |
| Metadata JSON encoding | events.go:49–55 | **NOT TESTED** | 0% | Missing: map[string]any marshaling edge cases (nil values, nested structures) | Test metadata with various types; verify JSON roundtrip |

**Test Count:** 0 dedicated tests (process_bounce_test mocks don't verify actual inserts)  
**Critical Gaps:** All event types untested

---

## 7. Reply Inbox Handler (features/inbound/inbox/web/threads.go)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| Manual reply POST /api/replies/{id}/reply | threads.go:19–77 | **NOT TESTED** | 0% | Missing: JSON body parsing error handling; empty body validation; database insert failure handling | Mock DB and test 400/404/500 paths |
| Reply-Inbox table join (send_event_id) | threads.go:48–59 | **NOT TESTED** | 0% | Missing: send_event_id lookup correctness | Query reply_inbox by send_event_id; verify join to send_events |
| Handled flag + timestamp | threads.go:69–71 | **NOT TESTED** | 0% | Missing: handled=true, handled_at=now() timestamp update verification | Verify UPDATE timestamp precision |

**Test Count:** 0

---

## 8. Mailsim Reply Generator (features/inbound/orchestrator/mailsim/reply.go)

| Feature | Source | Existing Test | Coverage | Gap | Live Verification |
|---------|--------|---------------|----------|-----|-------------------|
| RFC 822 reply message generation | reply.go:31–67 | `reply_bodyfor_test.go` covers bodyFor variants | ~80% | Missing: Message-ID bracketing edge case (< >); In-Reply-To/References ordering; OOO Auto-Submitted header presence | Generate reply and parse with net/mail; verify headers valid |
| Czech reply body variants | reply.go:73–113 | `reply_bodyfor_test.go` | ~90% | Missing: deterministic variant selection (hashVariant) collision coverage; body truncation (>1000 char) | Feed 50 Message-IDs; verify variant rotation deterministic; test >2000 char body |
| OOO Auto-Submitted + Precedence headers | reply.go:54–58 | **NOT TESTED** | 0% | Missing: OOO path verification (Auto-Submitted: auto-replied, X-Auto-Response-Suppress, Precedence: bulk) | Generate BehaviorOOO reply; parse headers; verify presence |

**Test Count:** 5+ in reply_bodyfor_test.go

---

## Summary of Biggest Gaps

### CRITICAL (Must Fix)

1. **ReplyType Action Dispatch (6 branches, 0 tests)** — inbound.go:122–175
   - ReplyNegative → Close + Suppress untested
   - ReplyMeeting/Interested → upsertLead never called in tests
   - ReplyAutoOOO/ReplyLater pause duration never verified
   - **Impact:** Core business logic (lead qualification, suppression, thread lifecycle) has zero coverage

2. **Lead Upsert (0 tests)** — inbound.go:160, 169
   - upsertLead function never invoked in any test
   - ON CONFLICT UPDATE contract unverified
   - **Impact:** Lead data integrity undefined; duplicate handling untested

3. **Suppression Cascade (0 tests)** — inbound.go:133–140 + bf_e3_mirror_suppression trigger
   - Trigger never tested; outreach_suppressions → contacts.status='suppressed' integration missing
   - **Impact:** Suppressed contacts may reappear in campaigns

4. **Audit Logging (5 event types, 0 dedicated tests)** — events.go:114–160
   - EventReplied, EventSuppressed, EventComplained, EventBounced counters untested
   - **Impact:** Audit trail integrity and contact metrics unreliable

5. **LLM Confidence Threshold** — JavaScript/Go boundary
   - JavaScript llmReplyClassifier.js (0.6 threshold) not enforced in Go
   - No cross-service integration test
   - **Impact:** Low-confidence predictions may incorrectly classify replies

### HIGH (Should Fix)

6. **Message-ID Matching Edge Cases** — inbound.go:276–305, poller.go:78–89
   - References header (5+ Message-IDs) iteration not tested
   - UID fallback to Message-ID collision not exercised
   - **Impact:** Non-standard reply threading may fail

7. **IMAP Header/Body Parsing Variance** — poller.go:362–450
   - Fastmail/GreenMail ordering (headers-first vs body-first) not end-to-end tested
   - Real-world pathological RFC 822 fragments not exercised
   - **Impact:** Silent email loss or truncation on production servers

---

## Live Verification Recommendations

| Component | Test Type | Duration | Cost |
|-----------|-----------|----------|------|
| Bounce detection (DSN gate) | Deploy canary with real IMAP servers + inject synthetic DSNs | 2h | Low |
| Reply classification (Czech keywords) | Corpus of 100 real Czech replies; run through classifier; compare keyword vs LLM | 1h | Low |
| Lead upsert idempotency | Simulate 10 concurrent ProcessReply calls for same contact/campaign | 30m | Low |
| Suppression cascade | Trace database trigger execution; verify contacts.status='suppressed' under negative reply | 1h | Low |
| IMAP NOOP heartbeat | 24h soak test on production IMAP servers; measure connection uptime | 24h | Medium |
| Message-ID matching (References) | Real-world email thread with 10-message References chain; verify correct thread match | 30m | Low |

---

## Test Organization

**Recommended file structure:**
```
features/inbound/orchestrator/thread/
  ├── inbound_actions_test.go        ← NEW: ReplyType dispatch (6 cases)
  ├── inbound_upsert_test.go         ← NEW: Lead upsert + suppression
  ├── events_test.go                 ← NEW: Audit logging (5 event types)
  └── integration_test.go            ← NEW: End-to-end bounce→suppress→contact

features/inbound/inbox/reply/
  ├── classify_keywords_test.go      ← NEW: Czech keyword isolation
  └── classify_llm_integration_test.go ← NEW: JS confidence threshold

features/inbound/inbox/web/
  └── threads_handler_test.go        ← NEW: Manual reply POST handler

features/inbound/orchestrator/imap/
  └── imap_integration_test.go       ← NEW: Real IMAP server fixtures
```

---

**Audit Date:** 2026-04-27  
**Generated by:** Feature Catalogue + Test Gap Analysis Script  
**Next Review:** After gap remediation + 2-week canary period
