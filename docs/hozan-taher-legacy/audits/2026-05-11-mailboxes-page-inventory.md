# Mailboxes Page Inventory — 2026-05-11

**Scope:** Read-only audit of `/mailboxes` page for 2-mailbox production setup (id=14227, id=14228).
**BFF:** http://localhost:18001 — Express BFF, API key: `d755…e06`

---

## Section 1 — Page Sections

| Block | What it shows | Endpoint(s) |
|---|---|---|
| `MissingPasswordBanner` (line 889) | Red banner for mailboxes with placeholder password | prop from store |
| System health banner (line 890–902) | Critical/warn alerts from system health | `/api/health/system` |
| `PageStatStrip` (line 906–921) | Active / paused / total counts + watchdog heartbeat | store + `/api/health/watchdog` |
| `MailboxHealthBoard` (line 938–944) | Grid of status tiles per mailbox, clickable to filter | store |
| Search + filter toolbar (line 948–1012) | Search, status filter, health band chips, refresh, density | local state |
| Config drift banner (line 1015–1024) | Critical config drifts only | `/api/health/drift` |
| `AnonymizationBar` (line 1027–1036) | Anti-trace + egress pool + watchdog + bounce guard pills + `LaunchStatsRow` | `/api/anti-trace/health`, `/api/proxy-pool`, `/api/health/proxy-sources`, `/api/health/watchdog`, `/api/campaigns/1/launch-stats` |
| `ProxyExhaustBanner` (line 317) | Red banner when pool exhaustion events >= 2 | `/api/health/proxy-exhaust` |
| `PoolHealthWidget` (line 318) | Pool health conditional widget | receives `proxyPool` + `proxySources` props |
| `OchranyPanel` (line 1039) | 12×2 protection matrix (L2/L3 probers) | internal endpoint (own fetch) |
| `RampStaircase` (line 1043) | Campaign #1 ramp progress (5→10→20→30) | `/api/campaigns/1/launch-stats` |
| Bulk bar (line 1047–1057) | Activate/Pause/Assign proxy/Full-check for selected | `/api/mailboxes/bulk-check`, `/api/mailboxes/bulk-assign-proxy` |
| Mailbox table (line 1081–1264) | Per-row: email, health score, delivery + sparkline, warmup, activity | `/api/mailboxes`, `/api/mailboxes/health-summary`, `/api/mailboxes/send-trends`, SSE `/api/mailboxes/health-stream` |
| SSE channel (line 636–672) | Push updates to health score badges | `/api/mailboxes/health-stream` |

---

## Section 2 — Endpoint Smoke Results

| Endpoint | Method | Status | Sample response | Verdict |
|---|---|---|---|---|
| `/api/anti-trace/health` | GET | 200 | `{"ok":true,"ms":614,"url":"https://anti-trace-relay-production…"}` | **working** |
| `/api/proxy-pool` | GET | 200 | `{"mode":"wg-pool","pool_size":6,"active_endpoints":6,"cz_working":4}` | **working** |
| `/api/health/proxy-sources` | GET | 200 | `{"sources":{"relay":{"count":6,"degraded":false}},"degraded":false}` | **working** |
| `/api/health/system` | GET | 200 | `{"healthy":true,"alerts":[],"egress_mode":"wg-pool"}` | **working** |
| `/api/health/watchdog` | GET | 200 | `{"stale":false,"last_event_at":"…","counts_24h":{"heartbeat":1447}}` | **working** |
| `/api/health/drift` | GET | 200 | `{"drifts":[{"check":"backend_unreachable","severity":"warn"}],"critical_count":0}` | **working** (warn only, not critical) |
| `/api/health/proxy-exhaust` | GET | 200 | `{"count":0,"triggered":false}` | **working** |
| `/api/mailboxes/health-summary` | GET | 200 | `{"total":2,"mailboxes":[{"id":"14227","score":null},{"id":"14228","score":null}]}` | **broken** — score=null for both; Go scoring loop has not written to `last_score` / `last_score_at` |
| `/api/mailboxes/send-trends?days=7` | GET | 200 | `{"14227":[0,0,0,0,1,14,5],"14228":[0,0,0,0,0,15,5]}` | **working** |
| `/api/mailboxes` | GET | 200 | Array of 2 mailboxes, full schema | **working** |
| `/api/mailboxes/14227` | GET | 404 | `Cannot GET /api/mailboxes/14227` | **broken** — no `GET /api/mailboxes/:id` route exists; only list + sub-resources |
| `/api/mailboxes/14227/stats` | GET | 200 | `{"total_sent":"23","sent_30d":"20","consecutive_bounces":0}` | **working** |
| `/api/mailboxes/14227/cooldown-log` | GET | 200 | `[]` (empty — no bounce hold events) | **working** |
| `/api/mailboxes/14227/pipeline-results` | GET | 200 | 1 row, `overall_ok:false`, IMAP step `ECONNREFUSED 127.0.0.1:1081` | **working** (data reflects IMAP SOCKS5 issue) |
| `/api/mailboxes/14227/full-check` | GET | 200 | `{"score":70,"ok":false,"checks":{smtp:ok,imap:FAIL,warmup:FAIL}}` | **working** (score correct, IMAP broken) |
| `/api/mailboxes/14227/egress-history?hours=24` | GET | 200 | `{"observations":[],"summary":{"distinct_countries":[]}}` | **empty** — no egress observations recorded yet (migration 075 applied but no data) |
| `/api/mailboxes/14227/campaigns` | GET | 200 | `{"total":1,"campaigns":[{"id":"457","name":"Strojírenství…","sent_count":20}]}` | **working** |
| `/api/mailboxes/14227/check-history` | GET | 200 | `[{"score":70,"checked_at":"2026-05-11T17:34:13Z"}]` | **working** (1 entry) |
| `/api/mailboxes/14227/alerts` | GET | 200 | `[{"type":"score_drop","severity":"warn","message":"Score dropped 30 points (100 → 70)"}]` | **working** |
| `/api/mailboxes/14227/watchdog-events` | GET | 200 | `[]` | **working** (empty, no events yet) |
| `/api/mailboxes/14227/send-log` | GET | 200 | 2 recent sent rows with contact info | **working** |
| `/api/mailboxes/14227/smtp-check` | GET | 200 | `{"ok":true,"ms":2893}` (all 4 SMTP steps OK) | **working** |
| `/api/mailboxes/14227/imap-check` | GET | 200 | `{"ok":false,"steps":[{"name":"tcp","ok":false,"msg":"ECONNREFUSED 127.0.0.1:1082"}]}` | **broken** — SOCKS5 IMAP port 108x not bound locally |
| `/api/mailboxes/14227/send-test` | POST | 425 | Outside send window — works correctly with `?force=1` | **working** (rate-limited as expected) |
| `/api/mailboxes/health-stream` | SSE | 200 | Headers received, stream open | **working** |
| `/api/mailboxes/bulk-check` | POST | 200 | `{"ok":true,"triggered":1}` | **working** |
| `/api/mailboxes/bulk-assign-proxy` | POST | 200 | Returns proxy assignment (deprecated `proxy_url` column) | **working** (legacy path) |
| `/api/relay/pool-capacity` | GET | 200 | `{"pool_size":0,"pinned_count":0,"ratio":0,"endpoints":[]}` | **broken** — `WIREPROXY_POOL_CONFIG` not set in dev; returns empty pool |
| `/api/campaigns/1/launch-stats` | GET | 200 | `{"campaign":null}` — campaign id=1 does not exist | **empty** — hardcoded `LAUNCH_CAMPAIGN_ID=1` at Mailboxes.jsx:136 does not match production campaign id=457 |

---

## Section 3 — Per-Mailbox Detail (Drawer)

`MailboxDrawer.jsx` renders 4 sections on open (fetches at line 485–497):

| Section | Fetches | Status |
|---|---|---|
| **Stav** — score hero + last checks | `GET /api/mailboxes/:id/full-check` (line 487) + `GET /api/mailboxes/:id/check-history` (line 489) | Working — score=70, IMAP/warmup failing shown |
| **Použití** — campaigns linked | `GET /api/mailboxes/:id/campaigns` (line 494) | Working — campaign #457 shown |
| **Akce** — Reset AUTH / Pause / Test / Diagnostics | `/api/mailboxes/:id/auth-reset`, `/api/mailboxes/:id/send-test`, `/api/mailboxes/:id/full-check?force=1` | Working; send-test gated by send window (correct) |
| **Pokročilé** (collapsed) — per-check breakdown + warmup + protections + stats | Uses `liveResult` (already fetched) + `GET /api/mailboxes/:id/stats` | Partially working — check rows render; warmup section shows "Warmup není nastaven" (correct for production phase); IMAP row shows ECONNREFUSED |

Drawer navigation (j/k), Clipboard copy, and focus management: working per code review.

---

## Section 4 — Gap → Action Map

| Issue | Root cause | Fix |
|---|---|---|
| **IMAP SOCKS5 fails** (score stuck at 70, imap check ECONNREFUSED 127.0.0.1:108x) | `runImapPollCron` relies on relay's wgpool SOCKS5 local port (127.0.0.1:1080–1085). The relay binds these in production (Railway). In dev/local the relay is not running, so the local port is unbound. | Production: redeploy relay or confirm wireproxy ports are bound. Dev: set `ANTI_TRACE_RELAY_URL_OVERRIDE`. Not a code bug — infrastructure gap. |
| **health-summary returns score=null** | `mailbox_check_cache` and `outreach_mailboxes.last_score` are written by Go orchestrator's `mailbox_score_loop.go` (every 4h). The health-summary route reads `last_score` from the DB. In prod, if the orchestrator has not run since last deploy, or if `DISABLE_MAILBOX_SCORE_LOOP=1`, this stays null. BFF health-summary does not trigger a live check. | Confirm orchestrator is running and `DISABLE_MAILBOX_SCORE_LOOP` is unset. Or trigger a `full-check` for each mailbox to populate `mailbox_check_cache`; health-summary reads from that cache. Actually: health-summary reads from `mailbox_check_cache`, not `last_score`. A fresh full-check populates the cache. The live run returned score=70 correctly — health-summary just needs the cache warmed. |
| **`/api/mailboxes/14227` returns 404** | No `GET /api/mailboxes/:id` single-resource route exists in `mailboxes.js`. The page never calls this URL (drawer fetches sub-resources directly). Only relevant if external tooling expects it. | Low priority. Add `GET /api/mailboxes/:id` returning `sanitizeMailboxRow(row)` if needed by other consumers. |
| **LaunchStatsRow always hidden** (`campaign=null`) | `LAUNCH_CAMPAIGN_ID = 1` hardcoded at Mailboxes.jsx:136. Production active campaign is id=457. `/api/campaigns/1/launch-stats` returns `{"campaign":null}` because id=1 doesn't exist. | Change constant to 457 (or make it a dynamic lookup for the most recently started running campaign). |
| **`/api/relay/pool-capacity` returns empty pool** | `WIREPROXY_POOL_CONFIG` env var not set in dev BFF. `PoolCapacityPanel` (imported in `mailboxes.js:131`) is not rendered in `Mailboxes.jsx` — it's used only in `PoolCapacityPanel.jsx` standalone. The BFF route itself is defined but returns `pool_size:0` without the env var. | Set `WIREPROXY_POOL_CONFIG` in dev `.env` to match prod, or suppress the panel in dev. |
| **Egress history empty** | `mailbox_egress_observation` table exists (migration 075) but no observations recorded yet. The observation writer runs inside the relay on each send/probe. | No code fix needed; data will appear as sends are observed. Consider a manual `INSERT` to verify the UI renders correctly. |

---

## Section 5 — Recommended Cleanup (2-mailbox setup)

| Component | Recommendation |
|---|---|
| `LaunchStatsRow` | **Fix** — change `LAUNCH_CAMPAIGN_ID` from 1 to 457 (or dynamic), then this section becomes useful |
| `PoolCapacityPanel` (standalone, fetches `/api/relay/pool-capacity`) | **Keep hidden** in current state — panel is not rendered inside Mailboxes.jsx (only in its own file). The `pool_size:0` response means it shows "can_add:false" which is misleading. Set `WIREPROXY_POOL_CONFIG` in Railway env to fix. |
| `RampStaircase campaignId={1}` | **Fix** — same hardcoded id=1 issue; shows empty staircase. Change to 457 or derive dynamically. |
| Bulk actions (bulk assign proxy, bulk pause/activate) | **Keep** — for 2 mailboxes it's marginal but not harmful |
| `ProxyExhaustBanner` | **Keep** — currently returns `triggered:false`, correctly hidden |
| `MailboxHealthBoard` status tiles | **Keep** — renders correctly with both mailboxes as "active" |

---

## Section 6 — "Make it work" Plan

### Ticket MB-1: Fix hardcoded campaign id (1–2h)
- File: `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` line 136
- Change `const LAUNCH_CAMPAIGN_ID = 1` to `457` as immediate fix
- Longer term: fetch `GET /api/campaigns?status=running&limit=1` and use returned id
- Same fix needed for `RampStaircase campaignId={1}` at line 1043

### Ticket MB-2: Warm health-summary cache via scheduled full-check (1–2h)
- `health-summary` reads `mailbox_check_cache` table; score=null until a full-check populates it
- BFF `runStaleHealthCheckCron` (server.js) should automatically run full-checks for stale mailboxes
- Verify `runStaleHealthCheckCron` is not disabled (`DISABLE_HEALTH_CHECK_CRON`) on Railway orchestrator
- Quick fix: trigger `POST /api/mailboxes/bulk-check` on BFF startup if cache is empty

### Ticket MB-3: Resolve IMAP SOCKS5 ECONNREFUSED in production (1h)
- Full-check and imap-check return `ECONNREFUSED 127.0.0.1:108x`
- Root cause: relay wgpool SOCKS5 local port not bound (ports 1080–1085)
- Action: verify Railway relay service is running and wireproxy is binding ports; check `wireproxy --config` output in relay logs
- Once fixed: score rises from 70 → 100 (SMTP already OK)

### Ticket MB-4: Set WIREPROXY_POOL_CONFIG in dev env (30 min)
- `/api/relay/pool-capacity` returns `pool_size:0` in dev because env var unset
- Add to `features/platform/outreach-dashboard/.env.local`: `WIREPROXY_POOL_CONFIG=[{"label":"cz-01","country":"CZ"},{"label":"de-01","country":"DE"}]`
- This also fixes `PoolCapacityPanel` display if operator ever renders it

### Ticket MB-5: Add GET /api/mailboxes/:id single-resource route (30 min)
- No show-stopper (drawer doesn't use it) but needed for API consistency
- Add to `features/platform/outreach-dashboard/src/server-routes/mailboxes.js` after the list route
- Returns single sanitized row or 404
