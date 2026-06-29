# Send Pipeline — Feature Catalogue + Test Gap Analysis

> Generated 2026-04-27 evening from sub-agent inventory of /Users/messingtomas/Documents/Projekty/hozan-taher.

35 core SEND pipeline features. Coverage ratio: ~85% unit/integration, ~15% gap (mostly real-time/live + chaos).

## Critical missing live tests (top 5)

1. **Domain day-count clock boundary** (runner.go:286–313). No test of `now() - interval '24 hours'` across midnight or DST.
2. **Self-send guard live verification** (engine.go, added 2026-04-27). New feature has no e2e test in production.
3. **PlainToHTML XSS escaping** (template.go:109). No live test with malicious plaintext; HTML injection risk if escaping is incomplete.
4. **Easter holiday calculation** (calendar/cz.go, Meeus). No live test of actual Good Friday / Easter Monday dates 2026–2027.
5. **DST transition** (calendar/sendwindow.go). No live test of InSendWindow / NextSendTime across March/October DST boundaries.

---

## SCHEDULER

### 1. Campaign Scheduler advisory lock (scheduler.go)
- **Cover**: Unit + contract (runner_audit_contract_test.go)
- **Gap**: Multi-process race; chaos lock-holder crash
- **Live**: 3 scheduler instances, concurrent RunCampaign on same id, verify only 1 acquires; measure failover

## RUNNER

### 2. Email status gate (runner.go:253–257)
- **Gap**: Property test of all email_status permutations; chaos null mid-query
- **Live**: Create contacts in {null, valid, suspect, invalid, bouncing}, run tick, verify only valid+suspect send

### 3. Holding cluster gate (runner.go:259–266)
- **Gap**: Load test 100+ contacts same parent_ico; chaos parent_ico=NULL
- **Live**: Enroll 200 contacts, 100 with parent_ico=X, run tick, expect ≤ HoldingClusterCap sends from X

### 4. Domain rotation per-tick (runner.go:268–279)
- **Gap**: Internationalized domains, race between concurrent ticks
- **Live**: 50 contacts at @acme.com, run tick → ≤ MaxPerDomainPerTick send; second tick continues batch

### 5. Domain day-count gate (runner.go:286–313) **CRITICAL**
- **Gap**: Clock boundary 23:59→00:00, DST, slow COUNT query
- **Live**: Backdate send_events to 23h55m ago, run tick (sends), advance 6m (blocks)

### 6. Suppression UNION gate (runner.go:35–39, 176–192) **CRITICAL**
- **Gap**: Both tables block independently; partial migration; case/whitespace
- **Live**: Insert into one table, then the other, verify each blocks; case/space variants

### 7. Template render + content engine (runner.go:344–354)
- **Gap**: Unsubscribe URL token verification e2e; malformed template; render timeout
- **Live**: Render 1000, verify each unsub token validates at /unsubscribe

### 8. Send window gate (runner.go:356–380)
- **Gap**: DST transition; tz database missing; region=NULL fallback
- **Live**: Region=SK, run at 17:30 Prague (07:30 SK), verify postpone to next 09:00 SK

### 9. Step advance CAS (runner.go:440–487) **CRITICAL**
- **Gap**: Race between concurrent runners; CAS=0 rows handling
- **Live**: 2 runners on same campaign+contact, verify exactly 1 advances

## SENDER ENGINE

### 10. Queue + dequeue (engine.go)
- **Gap**: 1M+ overflow backpressure; consumer panic recovery
- **Live**: Enqueue 10k, verify all dispatch, no drops

### 11. Window check (engine.go:296)
- **Gap**: Daily reset at midnight (TZ-aware); slow warmup query
- **Live**: warmup_day=5 → limit=100, send 100, advance midnight, verify can send 100 more

### 12. Circuit breaker (watchdog/circuit_breaker.go + engine.go)
- **Gap**: Persistence across restart; concurrent record-fail vs cooldown-expire
- **Live**: 5 auth fails → trip, advance past cooldown → close

### 13. Mailbox pickup + self-send guard (engine.go) **CRITICAL — JUST ADDED**
- **Gap**: New self-send feature has no e2e test
- **Live**: Mailbox at example.com, send to founder@example.com, verify rejected

### 14. Warmup ramps
- **Gap**: Multi-week schedule with clock advance; monotonicity
- **Live**: Day 1→10 schedule, verify daily limit 100→200→350→500

### 15. Daily cap (engine.go DailyCapFunc)
- **Gap**: Counter persistence on restart; midnight reset
- **Live**: Send 500, crash, restart, verify counter intact

### 16. Anti-trace submit
- **Gap**: Real e2e to relay; relay timeout/500/accept-but-fail
- **Live**: Submit through engine to actual relay, verify envelope_id, query status

## ANTITRACE CLIENT

### 17. Typed errors
- **Gap**: Property test all paths wrap with %w
- **Live**: Inject 429, verify errors.Is(err, ErrAntiTraceRateLimited)

### 18. Bearer auth
- **Gap**: Token rotation (does engine restart?); empty token
- **Live**: Set token, send, capture Authorization header

## CONTENT ENGINE

### 19. Spin {a|b|c} resolution
- **Gap**: Distribution uniformity (33/33/33%); same contact same variant
- **Live**: Render same contactID 100×, verify same variant always

### 20. Conditionals
- **Gap**: Nested conditionals; undefined variable
- **Live**: {{if .Firma}}...{{end}} with/without Firma

### 21. Deterministic seed
- **Gap**: Collision test (1M pairs); cross-Go-version determinism
- **Live**: Hash 1M (contactID, step) pairs, verify no collisions

### 22. Subject variants
- **Gap**: Malformed comments; default subject
- **Live**: 3 variants → 100 recipients → verify ~33% each

### 23. plainToHTML escaping **CRITICAL**
- **Gap**: Malicious plaintext (script tags, entities)
- **Live**: `<script>alert('xss')</script>` → escape to `&lt;script&gt;`

### 24. Humanize directive markers
- **Gap**: Marker leak into MIME; malformed marker
- **Live**: {{/* humanize: off */}} → render → verify marker stripped

## TOKEN

### 25. HMAC unsub token
- **Gap**: Key rotation; e2e at /unsubscribe; property all-keys-valid
- **Live**: token sign with key1 → rotate → verify fail with key2

## CALENDAR

### 26. IsSendableDay (Czech holidays) **CRITICAL**
- **Gap**: Easter-relative dates (Meeus); tz db unavailable
- **Live**: Easter 2026 (Apr 5), verify Good Friday Apr 3 = false, Easter Monday Apr 6 = false

### 27. InSendWindow **CRITICAL**
- **Gap**: DST transitions; boundary times (07:59 vs 08:00)
- **Live**: 07:59:59 Mon → false, +1s → true

### 28. NextSendTime
- **Gap**: Weekend span; holiday immediately after
- **Live**: Friday 16:00 → Monday 09:00; before holiday Mon → Tuesday 09:00

## MAILBOX

### 29. Warmup day → daily_limit
- **Gap**: Multi-week ramp with clock advance; monotonic
- **Live**: 10-day warmup, advance daily, verify ramp 100→200→350→500

### 30. Circuit breaker pure func
- **Gap**: Concurrent TripCircuit + cooldown check; high failThreshold
- **Live**: 2 fails (no trip), 3rd (trip), advance cooldown (close)

## RELAY

### 31. /v1/submit intake
- **Gap**: Real SMTP delivery e2e; relay DB unavailable; concurrent intake order
- **Live**: 100 envelopes, poll status, verify all delivered in order

### 32. Delivery status transitions
- **Gap**: Permanent vs transient bounce classification; mid-transaction drop
- **Live**: Send to permanent-fail address, verify status='failed' with code

### 33. Transport chain (direct/tor/vpn/proxy)
- **Gap**: Real Tor circuit; VPN down; proxy pool exhausted
- **Live**: TRANSPORT_MODE=tor+vpn, send, verify envelope uses both

### 34. Proxy pool refresh + rotation
- **Gap**: Real SOCKS5 handshake; all sources down; rotation distribution
- **Live**: 10 proxies, 100 envelopes, verify distribution (no single proxy >20%)

### 35. Strict geo
- **Gap**: Non-EU rejection with real GeoIP; lookup fails fallback
- **Live**: PROXY_STRICT_GEO=1 + PROXY_COUNTRY_CODES=CZ, US proxy → reject, CZ proxy → accept
