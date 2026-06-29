# Inventory: Suppression / GDPR / Unsubscribe

Last updated: 2026-04-27 | Scope: all implementations across Go services + JS BFF + compliance docs

---

## 1. Suppression Lists: Read & Write Paths

### 1.1 Two-Table Architecture

**Go-side table: `outreach_suppressions`** (primary, Schema B)
- Written by: `features/acquisition/contacts/enrichment/suppress.go:SuppressEmail()`
- Reasons: `hard_bounce`, `complaint`, `unsubscribe`, `negative_reply`, `manual`, `honeypot`
- Columns: `email`, `domain` (nullable), `reason`, `source_event_id` (nullable), created_at, updated_at

**JS-side table: `suppression_list`** (mirror, Schema A)
- Written by: `/unsubscribe` endpoint (server.js), manual BFF ops UI
- Reasons: `link_optout`, `manual_optout`, `gdpr_erasure`
- Columns: `email`, `reason`, `contact_id`, suppressed_at

**Mirror contract (BF-E3)** — `/scripts/migrations/005_contacts_status_sync.sql:63-85`
- `TRIGGER bf_e3_mirror_suppression` on `outreach_suppressions` INSERT → updates `contacts.status='suppressed'`
- Backfill chunk-processed (50k rows/batch) to avoid long table locks
- Idempotent: re-running safe; guards against re-downgrading terminal statuses

### 1.2 UNION Filter Applied at Every Send

**Go-side (runner.go:22-44)**
```
features/outreach/campaigns/campaign/runner.go:35-39
suppressionFilterSQL = `lower(trim({col})) NOT IN (
    SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL
    UNION
    SELECT lower(trim(email)) FROM suppression_list WHERE email IS NOT NULL
)`
```

**JS-side (suppressionFilter.js:18-47)**
```
features/platform/outreach-dashboard/src/lib/suppressionFilter.js
SUPPRESSION_EXISTS_SQL: dual EXISTS checks, OR'd together
SUPPRESSION_LOOKUP_SQL: parameterized UNION lookup for single-address pre-send gates
```

**In-memory UNION (suppression-union.js:15-73)**
```
features/platform/outreach-dashboard/src/lib/suppression-union.js
unionSuppressions(): merges both rowsets into a Set<string> (normalized: lower+trim)
isSuppressed(email, set): O(1) membership check
classifyBounceForSuppression(): hard_bounce → suppress decision (SMTP codes 550/551/553/554)
```

### 1.3 Writes to Suppression Tables

**Auto-suppress on hard bounce**
- Location: `features/outreach/mailboxes/bounce/processor.go:95-143`
- Path: bounce event → event classification (5xx hard codes) → `SuppressEmail()` call
- Audit: logged to `operator_audit_log` with event_id link

**Auto-suppress on reply classification (negative sentiment)**
- Location: `features/platform/common/humanize/response.go:69-115`
- Mechanism: `ClassifyReply()` detects keywords ("odhlásit", "nechci", "spam", etc.) → `ReplyNegative` type
- Consequence: orchestrator's inbound pipeline routes to `SuppressEmail()` with reason `negative_reply`

**Unsubscribe link endpoint**
- Location: `features/platform/outreach-dashboard/server.js:286-359`
- Contract: `GET /unsubscribe?c=<campaign_id>&id=<contact_id>&t=<hmac_token>`
- Writes to both `suppression_list` + `outreach_suppressions` (belt-and-suspenders)
- Status flip: `contacts.status='unsubscribed'` + `operator_audit_log` entry
- Rate limit: IP-based bucket, 429 on >60 req/min

**Bounce webhook → suppression cascade**
- Location: `features/inbound/orchestrator/seed/prodlike/scenarios.go` (test simulation)
- Real flow: inbound SMTP bounce DSN → bounce processor classifies → suppresses on hard bounces
- Propagates: `outreach_contacts.status='suppressed'` + `outreach_threads` set to 'error' + `companies.email_status='invalid'`

**Manual operator add (future UI)**
- Not yet exposed; placeholder in BFF (contract test shows expected shape)
- Would write to `suppression_list` via POST `/api/suppression` with x-api-key auth

### 1.4 Honeypot Detection & Seeding

**Honeypot detection library**
- Location: `features/acquisition/contacts/enrichment/honeypot.go`
- Checks: typo domains, role-based prefixes (abuse, postmaster, noreply, etc.), suspicious patterns (test, asdf, xxx), consecutive dots, single-char local part
- Severities: low, medium, high, critical
- Usage: imported by enrichment pipeline but not yet wired to auto-suppress

**Honeypot seeding (integration tests)**
- Location: `features/inbound/orchestrator/honeypot/validation_test.go` (test-only fixtures)
- Common patterns: no-reply@, abuse@, test@example.com

---

## 2. Unsubscribe Mechanism

### 2.1 HMAC Token Contract

**Token generation (features/platform/common/token/token.go:12-24)**
```
GenerateUnsubToken(contactID int64, key []byte) → "<payload_b64url>.<mac_b64url>"
Format: 8-byte contactID in BigEndian + HMAC-SHA256 signature
```

**Token parsing & validation (token.go:26-54)**
```
ParseUnsubToken(tok string, key []byte) → (contactID int64, error)
Validates format (2 parts, 8-byte payload), constant-time HMAC compare (hmac.Equal)
```

**BFF unsubscribe endpoint token recomputation**
- Location: `server.js:312-318`
- Input: `c` (campaign_id), `id` (contact_id), `t` (token), `email` (queried from contacts)
- Recomputes: `createHmac('sha256', secret).update('${c}|${id}|${email}').digest('hex').slice(0, 16)`
- Secret: `process.env.UNSUBSCRIBE_SECRET` fallback `OUTREACH_API_KEY`
- Note: Go-side test (`runner_unsub_token_test.go`) and BFF test must agree on format

### 2.2 Unsubscribe Footer & Rendering

**Template variable substitution**
- Location: `features/outreach/campaigns/content/template.go:168-195`
- Variable: `{{UnsubURL}}` (dot notation: `{{.UnsubURL}}`)
- Inserted verbatim (no HTML escaping in plain text body)
- Multiple occurrences replaced in single pass

**URL construction & passing to sender**
- Location: `features/outreach/campaigns/campaign/runner.go` (passes `UnsubURL` to template engine)
- Format: `https://<BFF_BASE>/unsubscribe?c=<campaign_id>&id=<contact_id>&t=<token>`
- Token generated once per contact-campaign pair (deterministic: same (contactID, secret) → same token)

### 2.3 RFC 8058 List-Unsubscribe Header (One-Click)

**Status: parsed but not yet generated**
- Location: `features/outreach/campaigns/sender/engine.go:851-875`
- Headers validation: custom headers allowed (X-Mailer, List-Unsubscribe passed through)
- Security: CR/LF stripping on keys (reject outright) and values (strip, no second header injection)
- TODO: wire up template to auto-generate `List-Unsubscribe: <https://...unsubscribe...>`

---

## 3. GDPR / Data Subject Rights (DSR)

### 3.1 Article 15 — Right of Access

**Endpoint: `GET /api/dsr/access?email=<EMAIL>`**
- Location: `server.js:410-478`
- Auth: requires `x-api-key` (OUTREACH_API_KEY)
- Rate limit: 10 req/min/IP (BF-D1 defense in depth)
- Validation: email parameter required, must contain `@`

**Query aggregation (8 parallel queries, Promise.all)**
1. `contacts` — Schema A primary registry
2. `outreach_contacts` — Schema B enriched
3. `send_events` — max 500 latest (joined to contacts)
4. `reply_inbox` — replies sent BY them (max 500)
5. `tracking_events` — opens/clicks (max 1000, may need manual pagination)
6. `suppression_list` — CZ-side table
7. `outreach_suppressions` — Go-side table
8. `operator_audit_log` — operator actions on this contact (joined by email field or entity_id)

**Response shape**
```json
{
  "email": "...",
  "found_total": <count>,
  "contacts": [],
  "outreach_contacts": [],
  "send_events": [],
  "reply_inbox": [],
  "tracking_events": [],
  "suppression_list": [],
  "outreach_suppressions": [],
  "audit_log": [],
  "generated_at": "ISO timestamp"
}
```

**Audit trail**: automatically logs `dsr_access` action to `operator_audit_log` with email + `tables_queried: 8`

### 3.2 Article 17 — Right to Erasure ("Right to be Forgotten")

**Endpoint: `POST /api/dsr/erase?email=<EMAIL>` (or in body)**
- Location: `server.js:480-559`
- Auth: requires x-api-key
- Rate limit: 10 req/min/IP (BF-D1)
- Transactional: BEGIN → deletes → insert suppression → audit → COMMIT/ROLLBACK

**Deletion cascade (5 tables deleted)**
1. `tracking_events` (via send_event_id)
2. `reply_inbox` (direct)
3. `send_events` (direct)
4. `outreach_contacts` (direct by email)
5. `contacts` (Schema A, by id)

**What is KEPT (Art. 17(3)(b) + §7(4) Czech Act 480/2004)**
- `suppression_list` + `outreach_suppressions` — proof of opt-out (legal obligation)
- Erasure writes to `suppression_list(email, reason='gdpr_erasure')` as belt-and-suspenders

**Response shape**
```json
{
  "email": "...",
  "ok": true,
  "deleted": {
    "contacts": <int>,
    "outreach_contacts": <int>,
    "send_events": <int>,
    "reply_inbox": <int>,
    "tracking_events": <int>
  },
  "suppression_kept": true,
  "message": "..."
}
```

**Audit trail**: logs `dsr_erase` action with deleted counts + email + full deleted rowcount breakdown

### 3.3 Article 16 — Right to Rectification

**Status: manual process (no auto endpoint)**
- Location: `docs/playbooks/dsr-runbook.md:116-127`
- Procedure: operator runs SQL UPDATE directly, logs to `operator_audit_log` with action='dsr_rectify'
- Example: UPDATE first_name/last_name where email matches

### 3.4 Article 21 — Right to Object (Opt-Out)

**Automated paths:**
1. Unsubscribe link in email → `/unsubscribe` endpoint → `suppression_list` insert
2. Reply classifier detects "STOP"/"unsubscribe" keywords → `SuppressEmail(reason='negative_reply')`

**Manual opt-out:**
- Location: `dsr-runbook.md:129-146`
- SQL: INSERT into `suppression_list(email, reason='manual_optout')` + audit log with action='dsr_object'
- Example: phone-based opt-out, external channel

---

## 4. Compliance Documentation (Published)

### 4.1 Legal Notices

**Privacy Notice** — `docs/legal/privacy-notice.md`
- Czech language notice per §2(1) GDPR (transparency)
- Section 7: Data Subject Rights (Art. 15-22 with contact + process)
- Section 5: retention (12mo active, permanent suppression list)
- Section 4: legal basis (Art. 6/1/f — legitimate interest)
- Linked from: footer of emails (future), sent as Art. 14 info-on-request

**Privacy Policy** — `docs/legal/privacy-policy.md` (awaiting finalization)

**Article 30 Register (ROPA)** — `docs/legal/art30-register.md`
- 5 processing activities documented:
  1. B2B direct marketing (offsets, retention, recipients, security)
  2. Reply tracking + lead management
  3. Suppression management (permanent retention justified)
  4. Tracking events (opens/clicks, 12mo retention, EXISTS guard BF-D4)
  5. Audit log (compliance proof, Art. 5/2 + 24 + 30)

**Legitimate Interest Assessment (LIA)** — `docs/legal/lia-direct-marketing.md` + `docs/compliance/lia-001-garaaage-cold-outreach.md`
- Balancing test: outreach business interest vs. data subjects' rights
- Counterbalances: opt-out mechanism, suppression lists, short retention, limited categories
- References consent-free B2B outreach in Art. 6/1/f recital 47

**Data Protection Impact Assessment (DPIA)** — `docs/compliance/dpia-001-direct-marketing-scale.md`
- Risk assessment for large-scale B2B outreach
- Mitigation: suppression UNION, bounce cascade, honeypot detection (planned)
- Retention limits, audit logging, subprocessor vetting

**Register of Processing Activities (ROPA)** — `docs/compliance/ropa-direct-marketing.md`
- Subprocessors listed: anti-trace-relay (mail infra), Railway.app (hosting), Seznam.cz (e-mail provider)
- Data stays within EHA (no transfer outside)

### 4.2 SCC & Transfer Docs

**Standard Contractual Clauses (SCC)** — `docs/legal/scc-railway.md`
- Railway.app hosting agreement + SCCs for any transatlantic data flow risk mitigation

---

## 5. Privacy Gateway Service

### 5.1 Purpose & Architecture

**Standalone service: `features/compliance/privacy-gateway/`**
- Single binary, zero external dependencies (stdlib only)
- Purpose: alias-based email relay + message sanitization
- Not wired into send pipeline; operates independently

### 5.2 Key Components

**Alias service** — `internal/alias/service.go`
- Manages temporary/forwarding email aliases with TTL
- File-backed store (JSON), retention configurable

**Message sanitization** — `internal/delivery/privacy.go:9-64`
- `sanitizeHeaders()`: removes routing + client-fingerprint headers
- `stripPrivacyHeaders()`: removes Received, X-Originating-IP, X-Forwarded-For, X-Mailer, User-Agent
- `anonymizeMessageID()`: replaces Message-ID with random value (domain literal: "relay")
- All transformations return fresh copy, never mutate input

**Submission policy** — `internal/policy/service.go`
- Validates recipient count, message size constraints
- Enforces rate limits per policy

**Audit service** — `internal/audit/service.go`
- Records all relay submission events
- Retention configurable (default: time-based)

### 5.3 Configuration & Deployment

- Default `DELIVERY_MODE=record-only` (safe default, no live delivery)
- Alias domain via `ALIAS_DOMAIN` env (never hardcoded)
- Encryption keys via env vars (`DATA_ENCRYPTION_KEY_B64`, `VAULT_ENCRYPTION_KEY_B64`)

---

## 6. Contract Tests & Integration

### 6.1 BFF Suppression Contract

**File: `tests/contract/bff-suppression.contract.test.ts`**
- `GET /api/suppression` — returns rows, ORDER BY suppressed_at DESC, LIMIT 500
- No yet-implemented POST/DELETE (BFF ops UI not exposed in MVP)
- Mocked pg.Pool queries, contract validates response shape

### 6.2 BFF Unsubscribe Contract

**File: `tests/contract/bff-unsubscribe.contract.test.ts`**
- `GET /unsubscribe?c=<campaign>&id=<contact>&t=<token>`
- Happy path: 200 + suppression_list INSERT + contacts UPDATE + operator_audit_log INSERT
- Token recomputation: Go + BFF must agree on format (runners_unsub_token_test.go mirrors JS test)
- Idempotent: repeat request still succeeds (ON CONFLICT)
- Validation: 400 on missing params, 403 on token mismatch, 429 on rate limit

### 6.3 BFF DSR Contract

**File: `tests/contract/bff-dsr.contract.test.ts`**
- `GET /api/dsr/access?email=<EMAIL>` — aggregates 8 tables, audit logs access
- `POST /api/dsr/erase?email=<EMAIL>` — transactional delete + suppress + audit
- Mocked pg.Pool with client.query() for transaction support
- Validates SQL hit all expected tables (contacts, outreach_contacts, send_events, reply_inbox, tracking_events, suppression_list, outreach_suppressions, operator_audit_log)

### 6.4 Go-side Tests

**Runner suppression filter** — `features/outreach/campaigns/campaign/runner_suppression_test.go`
- Validates suppressionFilterSQL guards against sending to suppressed addresses
- UNION contract lock (both tables must be checked)

**Bounce processor** — `features/outreach/mailboxes/bounce/processor_silent_drop_test.go`
- Hard bounce → suppression, soft bounce → pause/escalation logic
- Non-fatal error logging on partial failures (H3 2026-04-21 audit findings)

**Unsubscribe token** — `features/outreach/campaigns/campaign/runner_unsub_token_test.go`
- Token generation & parsing symmetry
- HMAC validation, constant-time compare

---

## 7. Operator Runbook & Workflows

### 7.1 DSR Playbook Location

**File: `docs/playbooks/dsr-runbook.md`**
- SLA: 48h confirmation, 1 month substantive response
- Identity verification: email match OK, different email requires proof
- Art. 15 workflow: curl /api/dsr/access → export JSON → human-readable template response
- Art. 17 workflow: curl /api/dsr/erase → verify suppression_kept=true → send confirmation template
- Art. 16 (rectification): manual SQL UPDATE + audit log insert
- Art. 21 (opt-out): automated via unsubscribe link OR manual SQL INSERT to suppression_list
- Complaint escalation: ÚOOÚ reference, LIA-001 document, audit log defense

### 7.2 Suppression Audit & Monitoring

**Audit log queries** (dsr-runbook.md:175-185)
```sql
-- Per-month DSR statistics:
SELECT date_trunc('month', created_at) AS month,
       action,
       COUNT(*)
FROM operator_audit_log
WHERE action LIKE 'dsr_%'
GROUP BY 1, 2
ORDER BY 1 DESC;
```

---

## Summary: Key Compliance Gateways

| Feature | Location | Trigger | Guard |
|---------|----------|---------|-------|
| **Suppression UNION filter** | runner.go:35-39, suppressionFilter.js:18-47 | Every send tick | Both tables queried, normalized (lower+trim), NOT IN clause |
| **Hard bounce auto-suppress** | bounce/processor.go:95-143 | DSN received | SMTP code classification (550/551/553/554) → SuppressEmail() |
| **Negative reply suppress** | humanize/response.go:69-115 | IMAP fetch | Keyword detection ("stop", "unsubscribe") → SuppressEmail() |
| **Unsubscribe link** | server.js:286-359 | Recipient click | HMAC token validation, IP rate limit 60/min, idempotent INSERT |
| **DSR Access (Art. 15)** | server.js:410-478 | operator /api/dsr/access | x-api-key auth, 10 req/min/IP, audits access itself |
| **DSR Erasure (Art. 17)** | server.js:480-559 | operator /api/dsr/erase | transactional (COMMIT/ROLLBACK), suppression_list kept as proof, audits deletion |
| **Honeypot detection** | enrichment/honeypot.go | enrichment pipeline | typo domains, role-based prefixes, suspicious patterns (not yet auto-suppress) |
| **Mirror trigger (BF-E3)** | migrations/005_contacts_status_sync.sql:63-85 | INSERT outreach_suppressions | AFTER trigger, contacts.status sync, guards terminal statuses |

---

**Total lines of code inventory**: ~2,300 (Go suppression + bounce) + ~1,100 (JS union/filter) + ~600 (BFF DSR/unsubscribe) + ~4,200 (tests) + ~800 (legal docs) = ~9,000 words of compliance-critical code.

**Critical files by read frequency:**
1. `suppressionFilter.js` + `suppression-union.js` (campaign preflight, every contact)
2. `features/outreach/campaigns/campaign/runner.go` (send gating, every tick)
3. `server.js` (unsubscribe + DSR endpoints, production APIs)
4. `features/acquisition/contacts/enrichment/suppress.go` (auto-suppress writes)
5. `features/outreach/mailboxes/bounce/processor.go` (bounce cascade)

