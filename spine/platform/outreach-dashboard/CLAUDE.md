# outreach-dashboard

## Stack
React 19, Vite 6, React Router 7, Zustand 5, lucide-react, Express 5 (BFF)

## Dev
```
pnpm dev               # Vite on :18175 + Express BFF on :18001
pnpm test              # full test scope (TEST_SCOPE=all — was test:full)
pnpm test:fast         # default narrow scope (unit + audit + chaos)
pnpm test:contract     # BFF contract tests (mocked pool)
pnpm test:integration  # pg-mem integration tests
pnpm test:full         # alias for `pnpm test` (kept for back-compat)
pnpm e2e               # Playwright (tests/e2e/)
pnpm build             # vite build → dist/
```

**Default flip (#70):** `pnpm test` now runs the FULL scope so CI gates and
local dev hit the same surface. For tight inner-loop iteration use
`pnpm test:fast` which keeps the old narrow default.

**BFF hot-reload:** Express auto-restarts on `server.js` and `src/server-routes/` changes via `node --watch`.

## Dashboard authentication (AW-F1)

Local HTTP Basic Auth gate, single account, bcrypt-hashed (cost 12).
Both the BFF (`src/lib/dashboardAuth.js`) and Vite dev server
(`basicAuthPlugin` in `vite.config.js`) gate requests against the same
env vars so the operator configures credentials in one place.

- Default **DISABLED** (`DASHBOARD_AUTH_ENABLED=false`) — zero behavioral
  change until explicitly opted in. Backwards compat for existing
  operator workflow + all tests.
- To enable:
  1. Run `node scripts/set-dashboard-password.js` → interactive prompt
     for username + password (password is hidden, never echoed).
  2. Paste the printed `DASHBOARD_USER` + `DASHBOARD_PASS_HASH` lines
     into `apps/outreach-dashboard/.env`.
  3. Set `DASHBOARD_AUTH_ENABLED=true` in the same `.env`.
  4. Restart Vite (`pnpm dev`) and the BFF (`node server.js`).
- Bypass paths (never gated): `/health`, `/healthz`, `/api/health/*`,
  `/api/sentry/tunnel`, `/sentry-tunnel`, `/__schema-check`,
  `/api/__schema-check`. The Vite plugin additionally bypasses HMR
  protocol routes (`/@vite/`, `/@react-refresh`, `/@fs/`, `/@id/`,
  `/node_modules/`).
- Test bypass: `BFF_AUTH_DISABLED=1` (existing pattern preserved — same
  flag the X-API-Key middleware honors).
- Additive: the existing `X-API-Key` middleware stays mounted. Basic
  Auth runs first for browser callers; machine callers using `X-API-Key`
  still need the header. Both gates apply.

### Accessibility gate (axe-core)

`tests/e2e/a11y.spec.ts` runs `@axe-core/playwright` against 10 routes and
writes per-route violation counts to `reports/a11y/summary.json`.

Local run (Vite must be on :18175):
```
pnpm dev > /tmp/vite.log 2>&1 &
pnpm exec playwright test tests/e2e/a11y.spec.ts --reporter=list
cat reports/a11y/summary.json | jq -r '.[] | "\(.path): critical=\(.critical) serious=\(.serious)"'
```

**Current gate level:** blocks PRs on any **`critical`** axe violation
(WCAG 2 A + AA). Wired into `.github/workflows/dashboard-real-backend.yml`
(job: `a11y-gate`).

**One-way ratchet** — `BLOCKING_IMPACTS` in the spec only ever grows. When
serious violations are paid down (currently ~10 color-contrast on muted
text), the next step is to add `'serious'` to the set. Never lower the
bar to unblock a PR — fix the violation instead.

## Data model gotcha: "leady JSOU vozidla"

The standalone **leads funnel is dead.** `/leads` was redirected to `/contacts`
on 2026-05-15 ("sales funnel never used"); there is no Leads page. Do NOT build
a reply→lead pipeline or populate the `leads` table from the dashboard — the
operator's real pipeline is the **Vozidla (vehicles) inventory**: a hot reply →
a vehicle offer, tracked via `vehicles.status` (offered→negotiating→agreed→
paid→picked_up). A "lead" in this business IS a vehicle.

- The `leads` table is vestigial (39 backfill rows from 2026-05-26). The Go
  `upsertLead` (`services/orchestrator/thread/inbound.go`) is a Schema-B path
  (ON CONFLICT contact_id+campaign_id) that does not run against this Schema-A
  DB — leave it.
- Hot reply with no vehicle yet → surface via vehicle capture
  (`runVehicleAutoCaptureCron` / make-only), NOT a leads row.
- History: a reply→lead linking feature was built + reverted (#1572, commit
  2cb55b78) for missing this. Verify an entity is LIVE before "fixing" its gap.

## Architecture
- `src/` — React app (Vite entry) + BFF (`server.js`)
- `server.js` — Express BFF, proxies `/api/*` to Go backend
- `tests/` — **single test root** (Phase 0 of "Tests as Heart" initiative):
  - `tests/unit/` — fast unit (lib/, components/, pages/, hooks/, helpers/, scripts/, legacy/)
  - `tests/integration/` — real backend (pg-mem) + `_setup/` fixtures
  - `tests/contract/` — BFF contract (vi.mock pool, supertest)
  - `tests/chaos/` — Markov sims + multi-entity invariants
  - `tests/audit/` — discipline ratchet checks (observability, explanation, GDPR shape)
  - `tests/synthetic/` — PROD continuous monitoring
  - `tests/regression/` — incident replay
  - `tests/e2e/` — Playwright specs (+ `_fixtures/` console-guard)
  - `tests/helpers/` — shared test infra (slo, state-machine, chaos-sim, fixtures)

Test config: single `vitest.config.ts` with `TEST_SCOPE` env switching
between projects (default | contract | integration | all). E2E separate via
`playwright.config.js → testDir: './tests/e2e'`.

## Campaign contact lease reclaim (AV-F9)

`campaign_contacts.status='in_flight'` is a short-lived lease the Go
sender daemon holds while submitting one SMTP send per contact. Lease
should take seconds; >1 hour means the daemon crashed mid-batch or was
killed without graceful shutdown.

`runCampaignContactsStaleReclaim` cron runs every 10 minutes and
reclaims in_flight rows with `updated_at < NOW() - INTERVAL '1 hour'`
back to `status='pending'` so the next sender tick can re-claim them
from a fresh pool. Per-row provenance is appended to
`campaign_contacts.details` (`released_from_in_flight_at`,
`released_reason='av_f9_stale_lease'`, `released_by_cron=true`) so
post-mortems can distinguish zombie releases from organic transitions.

Each reclaim writes `operator_audit_log`
(`action='campaign_contacts_zombie_release_cron'`) with per-campaign
counts. If a single tick reclaims `>=100` contacts, `mailbox_alerts`
emits a `'zombie_in_flight'` warn alert (`mailbox_id=NULL`,
system-wide) so the operator sees that the sender daemon likely
crashed recently and should review logs.

Tuning constants (no magic numbers) live in
`src/crons/runCampaignContactsStaleReclaim.js`:
`STALE_THRESHOLD_INTERVAL='1 hour'`, `RECLAIM_BATCH_LIMIT=5000`
(per-tick UPDATE cap), `ALERT_THRESHOLD=100`,
`RECLAIM_CRON_INTERVAL_MS=10*60*1000`. Batch limit protects against
runaway UPDATEs if a bug ever produces millions of in_flight rows —
the cron re-runs at the next tick.

History: this cron landed after the 2026-05-13 incident where
22 518 contacts sat in_flight for 7 days on campaign 457, paralyzing
send throughput. The incident was diagnosed + manually released on
2026-05-20 (`operator_audit_log
action='campaign_contacts_zombie_release'`).

## Cron engine conventions (Sprint AR6)

All repeating crons in `startCronEngine()` MUST use `scheduleCron(name, intervalMs, fn)` instead
of the bare `setTimeout(() => { fn(); setInterval(fn, interval) }, delay)` pattern.

`scheduleCron` adds a random ±5-minute jitter to the **first tick** so crons spread across
the scheduling window — inhuman regularity (always firing at :00/:15/:30/:45) is a
time-of-day bot fingerprint.

**Dev mode:** set `CRON_JITTER_SEED=<int>` env var for deterministic jitter in tests.

**Exceptions:** crons with complex in-flight guards (e.g. `runEgressChaosDetectionCron` with
`maybeImmediateDrain`) retain their custom `setTimeout` wiring — do not blindly convert them.

**Audit ratchet:** `tests/audit/ar6-cron-jitter.test.js` verifies that all named production
crons use `scheduleCron`. Add new crons to both the call site AND the ratchet.

## Email template content rules (Sprint AR2 + AR5)

**HARD RULES** for `email_templates` DB content (enforced at render-time in `services/campaigns/content/template.go`):

- **No tracking pixel**: do NOT add `<img src="...">` tags pointing to `/o?...` tracking endpoints. Open-pixel tracking is a detection signal for Seznam anti-spam filters. The `{{.OpenPixel}}` placeholder renders to empty string (infrastructure retained for legacy token expiry, new pixels not emitted). Render logs WARN if pixel pattern detected.
- **No short URLs** (AR5): `bit.ly`, `t.co`, `tinyurl.com`, `goo.gl`, `ow.ly`, `is.gd`, `buff.ly`, `rebrand.ly`, `short.io`, `tiny.cc` are phishing-like fingerprints. Render **fails hard** with `ErrShortURL` if any short URL found in rendered body. Always expand to the full target URL. Audit query: `SELECT id, name FROM email_templates WHERE body ~* 'bit\\.ly|t\\.co|tinyurl|goo\\.gl|ow\\.ly|is\\.gd|buff\\.ly|rebrand\\.ly|short\\.io|tiny\\.cc';`
- **No `{{.UnsubURL}}` in cold mail body**: opt-out via reply only ("stačí odepsat"). See `feedback_no_unsub_url_in_body`.

These rules complement `feedback_no_unsub_url_in_body` (T0 HARD RULE in MEMORY.md).

**Memory note (AR5):** Short URL guard implemented in PR #1155. Test coverage via `ar2_render_guard_test.go` (12 tests). Templates currently clean. DB audit recommended at each operator schema migration checkpoint.

## Env
| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `18001` | Express BFF port |
| `GO_SERVER_URL` | `http://localhost:8080` | Go outreach backend |
| `OUTREACH_API_KEY` | — | Must match Go service env |
| `CORS_ORIGIN` | `http://localhost:18175` | Vite dev origin (comma-list pro multi-env) |
| `CRON_JITTER_SEED` | — | Integer seed for deterministic cron jitter in dev/test |

## Proxy routes (server.js)
The BFF owns most `/api/*` endpoints directly against Postgres. Only the
campaign lifecycle + schema parity routes forward to the Go backend
(via `GO_SERVER_URL` + `OUTREACH_API_KEY` → `x-api-key`):

| Dashboard endpoint | Go endpoint | Notes |
|-------------------|-------------|-------|
| POST `/api/campaigns` | POST `/api/campaigns` | Falls back to direct-DB INSERT if `GO_SERVER_URL` unset or Go unreachable (legacy dev path) |
| POST `/api/campaigns/:id/run` | POST `/api/campaigns/:id/run` | Fallback: status flip to `running` |
| POST `/api/campaigns/:id/pause` | POST `/api/campaigns/:id/pause` | Fallback: status flip to `paused` |
| GET `/api/__schema-check` | GET `/schema` | Compares live manifest vs frozen `schema-manifest.json`; cached for `SCHEMA_CHECK_TTL_MS` |

Boot-time only (not request-scoped): `bootSchemaCheck()` and
`runBffBootInvariants()` also call Go's `/schema` and `/health` for
parity + readiness signals.

## Health store
`useOutreachHealth` Zustand store (`src/store/outreachHealth.ts`) exposes
`degraded` + `setDegraded()`. Banner consumers flip it when their feed
calls fail; the store does not poll a single endpoint itself.

## Watchdog scoring loop (CAD-S8 / issue #539)

`runFullCheckCron` was removed from `server.js` in CAD-S8 (2026-05-01).
Mailbox scoring (`last_score` / `last_score_at` on `outreach_mailboxes`) is
now owned by the Go orchestrator:
`services/orchestrator/intelligence/mailbox_score_loop.go`

The loop runs every 4h (configurable via `MAILBOX_SCORE_INTERVAL` env on the
orchestrator Railway service).  Disable with `DISABLE_MAILBOX_SCORE_LOOP=1`.
`pnpm report` stale-score alert is always critical >24h (no longer downgraded
when BFF is offline — Go runs 24/7).

## Per-mailbox operation rate caps (Sprint AP3, migration 072)

Hard per-hour limits to prevent credential hammering. Enforced atomically
via `src/lib/mailboxOpRateLimit.js` (`checkAndRecord`) backed by
`mailbox_op_rate_log` table (migration 072).

| op_type           | max/hour | wired into                              |
|-------------------|----------|-----------------------------------------|
| `imap_poll`       | 12       | `runImapPollCron` (per mailbox)         |
| `imap_inbox_fetch`| 6        | `GET /api/mailboxes/:id/imap-inbox`     |
| `full_check`      | 2        | `GET /api/mailboxes/:id/full-check` + `runStaleHealthCheckCron` |
| `smtp_probe`      | 12       | `GET /api/mailboxes/:id/smtp-check`     |
| `verify_email`    | 5        | `POST /api/contacts/:id/verify-email` (per probe mailbox) |

On refusal: HTTP 429 + `Retry-After` header + `{ error: 'rate_limit', op, used, max, retryAfterSec }` body.

**Cleanup:** daily at 03:00 Prague — deletes rows older than 7 days
(`runMailboxOpRateLogCleanup` cron in `server.js`).

**Emergency operator unblock:** to clear limits for a mailbox immediately
(e.g., after false-positive lockout during incident response):
```sql
-- Unblock specific mailbox for a specific op
DELETE FROM mailbox_op_rate_log
  WHERE mailbox_id = <id>
    AND op_type = '<op_type>'
    AND occurred_at > NOW() - INTERVAL '1 hour';

-- Unblock all ops for a mailbox
DELETE FROM mailbox_op_rate_log
  WHERE mailbox_id = <id>
    AND occurred_at > NOW() - INTERVAL '1 hour';
```
No deployment needed — takes effect on next request.

## Auth-fail auto-quarantine (Sprint AP6, migration 073)

Mailboxes that accumulate 3 auth-fails **of the same op_type** within 1 hour are automatically set to `status='auth_locked'`.

**Trigger threshold:** 3 auth-fails of the SAME op_type / 1h sliding window (BFF + IMAP cron).
**Per-op_type splitting (AP6 fix, 2026-05-08):** fail counts are evaluated independently per op_type.
  - 3 × `imap_inbox_fetch` in 1h → quarantine
  - 3 × `smtp_probe` in 1h → quarantine
  - 2 × `imap_inbox_fetch` + 2 × `smtp_probe` → NO quarantine (neither type hit 3 alone)
  - Rationale: prevents false-positive lockout when a network outage simultaneously
    fails multiple probe types. Each credential class must fail independently.
**Wired callers:**
  - `recordAuthFail(pool, id, 'smtp_probe', ...)` — `applyAutomationRules` in full-check (SMTP auth-invalid)
  - `recordAuthFail(pool, id, 'imap_inbox_fetch', ...)` — `GET /api/mailboxes/:id/imap-check` (auth error)
  - `recordAuthFail(pool, id, 'imap_poll', ...)` — `runImapPollCron` (per-mailbox poll errors)
**Cooldown:** 24h forced — operator cannot unlock before this elapses.
**Operator unlock:** `POST /api/mailboxes/:id/clear-auth-lock` with `X-Confirm-Send: yes` header.
  - Returns HTTP 425 `cooldown_not_elapsed` with `hours_remaining` if 24h not elapsed.
  - On success sets `status='paused'` (NOT `'active'`) — operator must explicitly resume after sanity-checking credentials.
**auth_locked semantics:**
  - Excluded from IMAP poll cron, health-summary, anonymity probe, and send paths.
  - `auth_locked_at`, `auth_locked_reason`, `auth_locked_by_observer` columns track incident.
**Helper library:** `src/lib/mailboxAuthFailGuard.js` — `recordAuthFail(pool, mailboxId, opType, errorMsg, observer)` and `canUnlock(pool, mailboxId)`.
**Emergency operator direct SQL unlock (when endpoint is unavailable):**
```sql
-- Only safe after 24h AND credentials have been verified/rotated
UPDATE outreach_mailboxes
  SET status='paused', auth_locked_at=NULL, auth_locked_reason=NULL, auth_locked_by_observer=NULL
  WHERE id=<id> AND status='auth_locked';
```

## IMAP via SOCKS5 — Sprint AO1

**HARD RULE (AO1):** All BFF IMAP dials MUST go through the relay's wgpool
SOCKS5 endpoint (`dialIMAPViaSOCKS5`) — never `new net.Socket()` directly.
Direct IMAP is the multi-country login pattern that triggered nowak.gorak
fraud detection (CZ residential IMAP poll + Mullvad SMTP = same-account
multi-country → automatic fraud lock).

### Architecture

1. `getMailboxSOCKS5Addr(mailboxRowOrId)` — resolves SOCKS5 addr per mailbox:
   - Reads `outreach_mailboxes.preferred_country`
   - Calls relay `GET /v1/imap-socks-addr?preferred_country=XX` → returns `{socks_addr, country, label}`
   - Falls back to any-country endpoint if in-country all quarantined
   - Throws `imap_socks_unavailable` if relay not configured / all down

2. `dialIMAPViaSOCKS5(socksAddr, host, port, timeoutMs?)` — SocksClient+TLS:
   - Opens SOCKS5 tunnel via wgpool endpoint (127.0.0.1:108X)
   - Wraps in TLS with SNI (tls.connect with servername)
   - Returns TLS socket ready for IMAP protocol

3. All 5 IMAP functions accept optional `socksAddr` 5th/6th parameter:
   `imapCheck`, `imapSearchUnseen`, `imapSearchUnseenUids`, `imapFetchHeaders`, `imapFetchByMessageId`

4. Relay exposes `GET /v1/imap-socks-addr?preferred_country=XX` (Sprint AO1) —
   in wgpool mode: calls `Pool.Pick("", "", country)` and returns `SocksAddr`.
   In single-endpoint mode: returns `SOCKS_PROXY_ADDR`.
   No auth required (returns loopback 127.0.0.1:108X only).

### Audit ratchet

`tests/audit/no_raw_imap_socket.test.js` — fails on any `new net.Socket()` near
IMAP context in server.js or src/. Baseline: 0 violations (15 checks).

### Dev mode

`runImapPollCron` skips in dev (`NODE_ENV != production`) unless `DISABLE_IMAP_CRON=0`.
Other IMAP endpoints (`/api/mailboxes/:id/imap-check`, `/imap-inbox`, `/header-probe`)
require relay to be reachable. Set `ANTI_TRACE_RELAY_URL_OVERRIDE=http://localhost:PORT`
during local development if relay is running locally.

## White-label brand configuration (Sprint AL)

Brand labels are operator-configurable via `operator_settings` DB table + UI.

**React components:**
- `useOperatorSetting(key, fallback)` hook: fetches a setting from `/api/operator-settings`
- Returns fallback if fetch fails or key missing
- Used in `src/pages/Replies.jsx` for handoff form labels

**BFF routes:**
- `GET /privacy` — fetches `controller_name` from DB for page title
- `GET /unsubscribe` — fetches `brand_label` for title + h1
- `POST /api/replies/:id/forward-to-crm` — new generic endpoint (accepts `crm_url`)
- `POST /api/replies/:id/forward-to-garaaage` — legacy alias for backward compat (deprecated 2026-08)

**MCP service:**
- `BRAND_LABEL` env var — read by OAuth authorize page title/heading
- Default: `'Garaaage'` if env unset

To rebrand:
1. Update `operator_settings.brand_label` row (via dashboard UI or SQL)
2. Update Railway env var `BRAND_LABEL` for MCP service
3. React UI re-fetches on next operator page reload
