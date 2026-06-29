# TDD Task Backlog — hozan-taher/modules/outreach

Workflow per task: **RED** (write failing test) → **GREEN** (minimal impl) → **REFACTOR** (clean up).

Legend: `[ ]` = pending, `[x]` = done, `[-]` = skipped/N/A

---

## Go Backend

### sender (engine, rate limiter, warmup, anti-trace)
- [ ] TDD-001 RateLimiter.Allow() returns true within burst window
- [ ] TDD-002 RateLimiter.Allow() returns false when window exhausted
- [ ] TDD-003 RateLimiter resets counter at window boundary
- [ ] TDD-004 RateLimiter concurrent Allow() calls don't race
- [ ] TDD-005 WarmupSchedule: day 1 → limit 5 per mailbox
- [ ] TDD-006 WarmupSchedule: day 14 → limit 50 per mailbox
- [ ] TDD-007 WarmupSchedule: day 30 → limit 120 per mailbox
- [ ] TDD-008 WarmupSchedule: clamps to configured maximum
- [ ] TDD-009 Engine.Send() retries on transient SMTP 421 error
- [ ] TDD-010 Engine.Send() permanent 550 → trips circuit breaker
- [ ] TDD-011 Engine.Send() records send event on success
- [ ] TDD-012 Engine skips send when mailbox circuit open
- [ ] TDD-013 AntiTrace relay: uses relay URL when configured
- [ ] TDD-014 AntiTrace relay: falls back to direct when relay down
- [ ] TDD-015 humanize headers injected into outbound message
- [ ] TDD-016 envelope-from override via anti-trace config
- [ ] TDD-017 per-mailbox daily counter persists across restarts
- [ ] TDD-018 backpressure queue drains under high load (no drops)
- [ ] TDD-019 DKIM signing headers preserved after relay
- [ ] TDD-020 Engine stops gracefully on context cancel

### campaign (runner, batch, scheduling)
- [ ] TDD-021 Runner.Run() respects calendar gate (Fri after 17:00 blocked)
- [ ] TDD-022 Runner selects optimal mailbox via selector
- [ ] TDD-023 Runner skips suppressed contacts
- [ ] TDD-024 Runner pauses on circuit breaker open
- [ ] TDD-025 Runner records send event on success
- [ ] TDD-026 Runner skips contact on template expand error
- [ ] TDD-027 Batch size respects remaining daily limit headroom
- [ ] TDD-028 Runner.Stop() drains inflight sends before exit
- [ ] TDD-029 Runner emits metrics on each batch
- [ ] TDD-030 Runner retries failed batch segment next tick

### enrich (pipeline, score, promote, suppress)
- [ ] TDD-031 Pipeline detects honeypot contact → excludes
- [ ] TDD-032 Pipeline scores company by ICP factors
- [ ] TDD-033 Pipeline promotes contact on score ≥ threshold
- [ ] TDD-034 Pipeline suppresses contact on hard bounce signal
- [ ] TDD-035 RecalculateAll updates all stale scores
- [ ] TDD-036 RecalculateOne is idempotent on re-run
- [ ] TDD-037 Promote dry-run returns candidates without DB write
- [ ] TDD-038 suppress: blacklists contact on spam complaint

### intelligence (health report, engagement, loop)
- [ ] TDD-039 HealthReport aggregates domain bounce rates
- [ ] TDD-040 HealthReport: per-domain open rate calculation
- [ ] TDD-041 HealthReport: per-domain click rate calculation
- [ ] TDD-042 RunOnce returns cached report within TTL
- [ ] TDD-043 RunOnce re-fetches after TTL expires
- [ ] TDD-044 Loop fires at configured interval
- [ ] TDD-045 Loop stops on context cancel without leak
- [ ] TDD-046 Domain engagement: zero sends → rate=0 not NaN
- [ ] TDD-047 Report sqlmock: inserts report row with correct JSON

### mailbox (selector, adaptive, backpressure, validate)
- [ ] TDD-048 Selector weights mailboxes by remaining daily capacity
- [ ] TDD-049 Selector returns error when all mailboxes exhausted
- [ ] TDD-050 Selector skips circuit-broken mailboxes
- [ ] TDD-051 AdaptiveRelease increases limit on clean day
- [ ] TDD-052 AdaptiveRelease decreases limit on bounce spike
- [ ] TDD-053 AdaptiveRelease clamps to min/max bounds
- [ ] TDD-054 Backpressure queue rejects when buffer full
- [ ] TDD-055 Backpressure queue accepts when buffer has space
- [ ] TDD-056 Validate rejects missing SMTP host
- [ ] TDD-057 Validate rejects missing IMAP host
- [ ] TDD-058 HoldReleaser.Release() clears hold flag in DB

### thread (inbound, bounce detection, dedup)
- [ ] TDD-059 Inbound classifies OOO reply → thread status OOO
- [ ] TDD-060 Inbound classifies negative → blacklists contact
- [ ] TDD-061 Inbound classifies positive → marks interested
- [ ] TDD-062 Inbound classifies meeting request → marks meeting
- [ ] TDD-063 Bounce detection from DSN X-Bounced header
- [ ] TDD-064 Deduplicates reply by Message-ID header
- [ ] TDD-065 Thread closes after negative reply (no further sends)

### bounce (processor, classifier, registry)
- [ ] TDD-066 Processor classifies SMTP 550 → hard bounce
- [ ] TDD-067 Processor classifies SMTP 452 → soft bounce
- [ ] TDD-068 Processor classifies spam complaint → blacklist
- [ ] TDD-069 Registry routes bounce to correct handler
- [ ] TDD-070 sqlmock: updates mailbox bounce counter on hard bounce
- [ ] TDD-071 sqlmock: soft bounce increments retry count

### validation (email, MX, spamtrap)
- [ ] TDD-072 Rejects email without @ symbol
- [ ] TDD-073 Rejects email with no domain part
- [ ] TDD-074 Rejects email with consecutive dots
- [ ] TDD-075 Accepts valid Czech business email formats
- [ ] TDD-076 MX lookup marks domain as unresolvable on NXDOMAIN
- [ ] TDD-077 Spamtrap: known trap domain → flagged
- [ ] TDD-078 Verifier state machine: pending → verified → failed transitions

### warmup (schedule, ramp)
- [ ] TDD-079 Day 1 limit = 5 emails per mailbox
- [ ] TDD-080 Day 7 limit = 20 emails per mailbox
- [ ] TDD-081 Day 14 limit = 50 emails per mailbox
- [ ] TDD-082 Day 30+ limit = 120 emails per mailbox
- [ ] TDD-083 Limit clamps to MAILBOX_N_DAILY_LIMIT cap

### imap (pool, poll, mark seen)
- [ ] TDD-084 Pool creates TLS connection with correct server name
- [ ] TDD-085 Poll fetches UNSEEN messages from INBOX
- [ ] TDD-086 Poll marks messages as Seen after processing
- [ ] TDD-087 Pool reconnects after connection drop (retry)

### humanize (delays, user-agents, headers)
- [ ] TDD-088 Send delay falls within min/max bounds
- [ ] TDD-089 User-agent pool cycles deterministically across sends
- [ ] TDD-090 Header order randomization produces valid MIME
- [ ] TDD-091 Subject case variation doesn't change subject meaning

### content (template, spin, redirect, tracking)
- [ ] TDD-092 Template expands {{company_name}} variable
- [ ] TDD-093 Template expands {{first_name}} variable
- [ ] TDD-094 Template returns error on unknown variable
- [ ] TDD-095 Spin tag selects one of N variants by seed
- [ ] TDD-096 Click redirect rewrites all href links in body
- [ ] TDD-097 Tracking pixel injected before </body> tag
- [ ] TDD-098 Header sanitization strips X-Mailer header
- [ ] TDD-099 Link rewriting preserves https scheme

### audit (log, redaction)
- [ ] TDD-100 Logs send event with redacted email (***@domain)
- [ ] TDD-101 Logs reply event with classification label
- [ ] TDD-102 Sensitive fields redacted: no raw email in output
- [ ] TDD-103 sqlmock: insert row to audit_log table

### health (staleness, data quality)
- [ ] TDD-104 Staleness check error when no sends in 48h
- [ ] TDD-105 Staleness check ok when recent send found
- [ ] TDD-106 Data quality: contact coverage percentage calculation
- [ ] TDD-107 Status: aggregates all subsystem checks into single bool

### classify (ICP, job, confidence)
- [ ] TDD-108 ICP factor weights sum to 100
- [ ] TDD-109 Job processes batch of contacts via LLM
- [ ] TDD-110 Low confidence score → skip reclassification

### exclusion (detector, rules)
- [ ] TDD-111 Excludes honeypot-flagged contacts
- [ ] TDD-112 Excludes bounced contacts (hard bounce)
- [ ] TDD-113 Excludes opted-out contacts
- [ ] TDD-114 Excludes contacts with invalid email
- [ ] TDD-115 Does NOT exclude active contacts with good score

### honeypot (pattern, role-based, TLD)
- [ ] TDD-116 Detects role-based mailbox: postmaster@, abuse@, noreply@
- [ ] TDD-117 Detects suspicious number-heavy domain (123.cz)
- [ ] TDD-118 Flags known spamtrap TLDs (.test, .invalid)
- [ ] TDD-119 Does NOT flag legitimate business domain

### prospect (firmy.cz client, pagination)
- [ ] TDD-120 Fetches page 1 of firmy.cz results
- [ ] TDD-121 Pagination stops at last page (no next_page)
- [ ] TDD-122 Maps firmy.cz fields to company struct correctly

### ares (client, import, sync)
- [ ] TDD-123 Client fetches company by IČO (httptest mock)
- [ ] TDD-124 XML import parses company name and address
- [ ] TDD-125 Sync marks updated_at on re-import
- [ ] TDD-126 sqlmock: upsert company record on conflict

### category (NACE, path, store)
- [ ] TDD-127 Maps NACE code 28.xx → machinery sector
- [ ] TDD-128 Path classify: firmy.cz /stavebnictvi → construction
- [ ] TDD-129 sqlmock: list categories returns correct rows

### company (metadata, snapshot, sync)
- [ ] TDD-130 Metadata snapshot captures current field values
- [ ] TDD-131 Metadata sync updates on ARES field change
- [ ] TDD-132 sqlmock: upsert company on ico conflict
- [ ] TDD-133 Sync sqlmock: bulk upsert 100 companies

### contact (status, transitions, store)
- [ ] TDD-134 Status transition: new → active
- [ ] TDD-135 Status transition: active → blacklisted on negative reply
- [ ] TDD-136 Status transition: active → bounced on hard bounce
- [ ] TDD-137 Excluded_statuses list covers all terminal states
- [ ] TDD-138 sqlmock: find contacts by company_id

### config (env loading, defaults, validation)
- [ ] TDD-139 Loads DB_HOST from environment
- [ ] TDD-140 Defaults DB_PORT to 5432 when unset
- [ ] TDD-141 Requires OUTREACH_API_KEY (fails if missing)
- [ ] TDD-142 Parses MAILBOX_N_DAILY_LIMIT for N=1..24
- [ ] TDD-143 Parses MAILBOX_N_SMTP_HOST for all N

### segment (filter, scheduling)
- [ ] TDD-144 Filter evaluates industry tag match
- [ ] TDD-145 Filter evaluates region match
- [ ] TDD-146 Scheduling rule: no weekend sends
- [ ] TDD-147 Scheduling rule: respects daily_limit cap

### calendar (CZ gate, holidays)
- [ ] TDD-148 Friday after 17:00 CET → send blocked
- [ ] TDD-149 Saturday → send blocked
- [ ] TDD-150 Sunday → send blocked
- [ ] TDD-151 Czech public holiday → send blocked
- [ ] TDD-152 Monday 09:00 CET → send allowed
- [ ] TDD-153 Friday 16:59 CET → send allowed

### web (handlers, auth, tracking)
- [ ] TDD-154 Tracking pixel GET /o/:token → 200 + 1x1 GIF
- [ ] TDD-155 Click redirect GET /c/:token → 302 to target URL
- [ ] TDD-156 Click redirect: invalid token → 404
- [ ] TDD-157 Unsubscribe GET /u/:token → sets contact status
- [ ] TDD-158 API key middleware: missing header → 401
- [ ] TDD-159 API key middleware: wrong key → 401
- [ ] TDD-160 API key middleware: correct key → passes through

### alert / protections (evaluator, webhook)
- [ ] TDD-161 Evaluator opens CRITICAL alert on L2 error
- [ ] TDD-162 Evaluator resolves alert when all probes OK
- [ ] TDD-163 Evaluator escalates L3 on 3 consecutive errors
- [ ] TDD-164 Evaluator skips all writes with nil DB
- [ ] TDD-165 Webhook signs payload with HMAC-SHA256
- [ ] TDD-166 Webhook rejects delivery on non-2xx response

### probe / protections (heartbeat, scheduler, L2/L3)
- [ ] TDD-167 Heartbeat.Run() writes timestamp to DB every cadence
- [ ] TDD-168 Heartbeat: nil DB → no-op (no panic)
- [ ] TDD-169 Scheduler.Add() appends prober to list
- [ ] TDD-170 L2 AntiTrace: 200 response → ok
- [ ] TDD-171 L2 AntiTrace: 500 response → error
- [ ] TDD-172 L2 ProxyPool: working > 3 → ok, 1 → warn, 0 → err
- [ ] TDD-173 L3 CircuitBreaker: nil DB → skip (no panic)
- [ ] TDD-174 L3 CanaryL3: nil DB → skip

### db (migrate, isMigrationApplied)
- [ ] TDD-175 Migrate: non-existent dir → error
- [ ] TDD-176 Migrate: empty dir → no-op
- [ ] TDD-177 Migrate: applies new SQL files in alphabetical order
- [ ] TDD-178 Migrate: skips already-applied migrations
- [ ] TDD-179 isMigrationApplied: true after apply, false before

### mailsim (bouncer, behaviors, reply)
- [ ] TDD-180 Bouncer: deliver recipient → OnRespond("deliver") fired
- [ ] TDD-181 Bouncer: silent recipient → OnRespond("silent") fired
- [ ] TDD-182 Bouncer: hard bounce → DSN injected via SMTP
- [ ] TDD-183 Bouncer: deduplicates same message-id across ticks
- [ ] TDD-184 Bouncer: Run() stops on context cancel

---

## Frontend — React Dashboard

### lib/api (HTTP client)
- [ ] TDD-185 GET adds X-API-Key header from env
- [ ] TDD-186 Non-2xx response throws error with status code
- [ ] TDD-187 Network timeout throws descriptive error
- [ ] TDD-188 POST serializes body to JSON

### lib/companiesApi
- [ ] TDD-189 list() returns paginated results envelope
- [ ] TDD-190 search() filters by name query param
- [ ] TDD-191 getById() returns single company

### lib/tokens
- [ ] TDD-192 Decodes valid JWT and returns payload
- [ ] TDD-193 Returns null for malformed JWT
- [ ] TDD-194 Returns null for expired JWT

### lib/validators
- [ ] TDD-195 Accepts valid Czech business email
- [ ] TDD-196 Rejects email without @
- [ ] TDD-197 Rejects email with no domain
- [ ] TDD-198 Validates IČO: 8 digits required
- [ ] TDD-199 Validates IČO: checksum digit correct
- [ ] TDD-200 Rejects IČO with wrong checksum

### lib/automation
- [ ] TDD-201 Evaluates send schedule: today allowed
- [ ] TDD-202 Blocks send on Saturday
- [ ] TDD-203 Blocks send on Sunday
- [ ] TDD-204 Returns next allowed slot when blocked

### lib/cohort
- [ ] TDD-205 Builds snapshot of active contacts count
- [ ] TDD-206 Groups contacts by industry tag
- [ ] TDD-207 Excludes blacklisted contacts from snapshot

### lib/dataQuality
- [ ] TDD-208 Flags contact with missing email as gap
- [ ] TDD-209 Flags contact with unverified email
- [ ] TDD-210 Returns quality score 0–100

### lib/emailVerify
- [ ] TDD-211 State: pending → verified on success
- [ ] TDD-212 State: pending → failed on MX error
- [ ] TDD-213 State: failed retries after backoff

### lib/filterSerializer
- [ ] TDD-214 Serializes filter object to query string
- [ ] TDD-215 Deserializes query string back to filter object
- [ ] TDD-216 Round-trip: serialize → deserialize is identity

### lib/scoring
- [ ] TDD-217 Weighted sum across ICP factors
- [ ] TDD-218 Missing factor treated as 0 weight
- [ ] TDD-219 Score clamped 0–100

### lib/scoreLearner
- [ ] TDD-220 Updates weights on positive feedback signal
- [ ] TDD-221 Updates weights on negative feedback signal
- [ ] TDD-222 Weights sum to 100 after update

### lib/mailboxUtils
- [ ] TDD-223 Calculates warmup limit for day N
- [ ] TDD-224 Fuzz: random day values don't throw
- [ ] TDD-225 Remaining capacity = daily_limit - sent_today

### lib/refreshPolicy
- [ ] TDD-226 Returns fresh within TTL
- [ ] TDD-227 Returns stale after TTL expires
- [ ] TDD-228 Force refresh ignores TTL

### lib/mxLookup
- [ ] TDD-229 Returns MX records array for valid domain
- [ ] TDD-230 Returns empty array on NXDOMAIN
- [ ] TDD-231 Caches result for duplicate lookups

### lib/readiness
- [ ] TDD-232 Checklist item FAIL: missing SMTP config
- [ ] TDD-233 Checklist item FAIL: no active mailbox
- [ ] TDD-234 Checklist item PASS: all config present

### lib/lookalike
- [ ] TDD-235 Flags domain differing by 1 char from known brand
- [ ] TDD-236 Does NOT flag legitimate unique domain

### lib/diagnostics
- [ ] TDD-237 Exports JSON containing all expected system fields
- [ ] TDD-238 No sensitive credentials in diagnostic output

### Hooks
- [ ] TDD-239 useUrlState: reads filter from URL on mount
- [ ] TDD-240 useUrlState: pushes state change to URL history
- [ ] TDD-241 useUrlState: clears param when value is null
- [ ] TDD-242 useCompanyFilters: applies industry filter correctly
- [ ] TDD-243 useCompanyFilters: clears all filters on reset
- [ ] TDD-244 useFacets: aggregates industry tag counts
- [ ] TDD-245 useFacets: invalidates cache on list change
- [ ] TDD-246 useFilterPresets: saves preset to localStorage
- [ ] TDD-247 useFilterPresets: loads preset on restore
- [ ] TDD-248 useFilterPresets: deletes preset by name
- [ ] TDD-249 useKeyboardShortcuts: fires handler on correct keydown
- [ ] TDD-250 useKeyboardShortcuts: removes listener on unmount
- [ ] TDD-251 useProtectionAlerts: criticalCount from API response
- [ ] TDD-252 useProtectionAlerts: warnCount excludes acked alerts
- [ ] TDD-253 useProtectionAlerts: ack() POSTs to correct endpoint
- [ ] TDD-254 useProtectionAlerts: refresh() re-fetches data
- [ ] TDD-255 useProtectionsMatrix: fetches matrix on mount
- [ ] TDD-256 useProtectionsMatrix: refresh() triggers re-fetch

### Store
- [ ] TDD-257 outreachHealth: degraded=true when backend 503
- [ ] TDD-258 outreachHealth: degraded=false when backend 200
- [ ] TDD-259 outreachHealth: banner message set when degraded

---

## Contract & BFF Tests

- [ ] TDD-260 GET /api/mailboxes returns {ok:true, data:[...]} envelope
- [ ] TDD-261 GET /api/companies returns paginated envelope with total
- [ ] TDD-262 POST /api/contacts requires X-API-Key header
- [ ] TDD-263 BFF forwards X-API-Key to Go backend on all routes
- [ ] TDD-264 BFF returns 503 with {ok:false} when Go backend down
- [ ] TDD-265 BFF returns 504 on Go backend timeout
- [ ] TDD-266 Route inventory snapshot matches actual Express routes
- [ ] TDD-267 Auth matrix: all write endpoints require auth
- [ ] TDD-268 Input fuzzing: /api/companies?q=<script> → safe response
- [ ] TDD-269 Structural invariants: all responses have ok field
- [ ] TDD-270 E2E failure: BFF handles Go 500 with graceful error

---

## System & Quality Gates

- [ ] TDD-271 Secrets scan: no hardcoded API keys in source
- [ ] TDD-272 Bundle budget: main JS < 150kb gzipped
- [ ] TDD-273 Bundle budget: CSS < 30kb
- [ ] TDD-274 Migration lint: no DROP COLUMN without prior rename step
- [ ] TDD-275 Dead code: no unused exports in lib/ directory
- [ ] TDD-276 Race matrix: concurrent campaign sends don't corrupt state
- [ ] TDD-277 Idempotency: running campaign run twice is safe
- [ ] TDD-278 Security: CSP header present on all HTML responses
- [ ] TDD-279 Security: X-Content-Type-Options: nosniff on all responses
- [ ] TDD-280 Security: no CSRF vulnerability on state-changing endpoints
- [ ] TDD-281 Lighthouse: LCP < 2.5s on dashboard page
- [ ] TDD-282 Lighthouse: CLS < 0.1 on dashboard page
- [ ] TDD-283 Replay diff: API response shape stable between deploys
- [ ] TDD-284 N+1 detection: company list doesn't issue N company queries
- [ ] TDD-285 Chaos: Go backend restart → BFF recovers within 5s
- [ ] TDD-286 Fault injection: DB timeout → campaign pauses gracefully
- [ ] TDD-287 Flaky detector: identify non-deterministic tests
- [ ] TDD-288 KPI diff: dashboard metrics match Go backend counts

---

## Stats

| Area | Tasks |
|------|-------|
| Go backend | 184 |
| Frontend lib | 54 |
| Frontend hooks | 18 |
| Frontend store | 3 |
| Contract/BFF | 11 |
| System/quality | 18 |
| **Total** | **288** |
