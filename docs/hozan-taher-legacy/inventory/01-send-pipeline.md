# Inventory: Campaign Send Pipeline

Comprehensive catalog of existing implementation for: proxy pool, mailbox self-healing, SMTP AUTH probing, send pre-flight, ops endpoints. **Reuse these instead of writing new code.**

## 1. PROXY POOL MANAGEMENT

### Source fetching (relay)
- `features/outreach/relay/internal/transport/proxy_pool.go:26–55` — geonode + proxyscrape + proxifly fetchers
- `allowedCountryCodes()` (line 62) reads `PROXY_COUNTRY_CODES` env, default `CZ,SK,DE,AT,PL,HU,SI` (Central Europe)
- `strictGeoEnabled()` reads `PROXY_STRICT_GEO` env (any non-empty enables hard reject of non-EU)
- `filterByGeo()` drops candidates with no country tag or outside allowlist
- 15-minute background refresh ticker (line 98)
- SMTP AUTH probe filtering when `SMTP_PROBE_USERNAME` set

### BFF cache
- `features/platform/outreach-dashboard/proxyCacheLogic.js` — 15s read-through cache, `empty_pool_critical` immediate invalidation
- `features/platform/outreach-dashboard/server.js:3376` — `getProxyPool()` reads through cache
- `invalidateProxyCache()` line 3391 — called after bulk-assign, bulk-check, watchdog trigger

### Relay endpoints
- `GET /v1/proxy-pool` — snapshot `{working:[{addr,country,source,latency_ms,...}], count, last_refresh, empty_pool_critical}`
- `POST /v1/admin/refresh-pool` — async re-fetch+probe; 202 Accepted

## 2. MAILBOX SELF-HEALING

### Watchdog daemon (Go)
- `features/outreach/mailboxes/watchdog/daemon.go` — 5-min Tick loop
- `swapProxy()` line 334 — auto-swap on auth-fail spike (3 fails / 1h window)
- `pickProxy()` line 497 — filter via `AllowedProxy` callback, sort by ProbeMs, skip current proxy
- `decayBounce()` line 318 — counter decay after 24h quiet
- Circuit breaker (per-mailbox 3-fails / 30min cooldown)

### BFF crons + manual
- `POST /api/mailboxes/:id/recover` (server.js:2707) — force-release stuck mailbox
- `POST /api/mailboxes/:id/auth-reset` (server.js:2763) — zero auth-fail counter
- `POST /api/mailboxes/:id/assign-proxy` (server.js:3634) — single mailbox proxy reassignment
- `POST /api/mailboxes/bulk-assign-proxy` (server.js:5128) — bulk reassign `{ids:[...]}` — probes each via SMTP AUTH, picks first PASS
- `GET /api/mailboxes/:id/watchdog-events` (server.js:2688) — auto-heal timeline
- `POST /api/health/auto-recover-trigger` (server.js:7122) — manual cron trigger

### Auth cache
- `features/platform/outreach-dashboard/authCache.js` — memoize last-known-working proxy per mailbox
- Speeds reassignment when proxy still works

## 3. SMTP AUTH PROBING

### Relay endpoints
- `POST /v1/auth-check` (features/outreach/relay/web/probe.go:98) — probe one (proxy, smtp_creds) tuple
- `POST /v1/probe` (probe.go:249) — full check: SMTP + IMAP + proxy liveness

### BFF wrapper
- `smtpAuthProbe(addr, host, port, user, pwd)` (server.js:3630) → relay `/v1/auth-check`
- `relayClient.js:relaySmtpCheck/Probe/AuthProbe` — typed wrappers

## 4. SEND PRE-FLIGHT

### Campaign preflight gate
- `features/platform/outreach-dashboard/campaignPreflight.js` — 6 checks:
  1. **proxy_assignments** — all active mailboxes have proxy_url (or relay configured)
  2. **full_check_fresh** — every mailbox has check ≤6h old
  3. **suppression_populated** — UNION ≥1 entry
  4. **daily_capacity** — ≥100 sends/day total
  5. **templates_valid** — all sequence_config templates exist + non-empty
  6. **enrollment_populated** — campaign_contacts >0
- `GET /api/campaigns/:id/preflight` — JSON response

### Suppression UNION
- `features/platform/outreach-dashboard/campaignPreflight.js:44` — `UNION` over outreach_suppressions + suppression_list
- Mirrored by Go `features/outreach/campaigns/campaign/runner.go` suppressionFilterSQL

## 5. RELAY TRANSPORT MODES

- `features/outreach/relay/internal/transport/chain.go:79` — `BuildChain(mode, socksAddr, vpnTransport)`
- Modes: `direct` (default), `tor`, `vpn`, `vpn+tor`, `proxy` (rotating SOCKS5)
- For B2B: `TRANSPORT_MODE=direct` is OK per memory `project_b2b_transport_mode`
- Hard rule: no `openssl/curl/nc` direct-to-smtp from localhost (memory `feedback_no_direct_smtp`)

## 6. PLAYBOOKS

- `docs/playbooks/MAILBOXES-SELF-HEALING-SPRINTS.md` — sprints S1–S4 design
- `docs/playbooks/SEND-OPERATIONS.md` — send window, warmup, daily cap, troubleshooting
- `docs/playbooks/first-campaign-launch.md` — generic 0→1→5→20 staircase

## 7. CRON SCHEDULES (features/platform/outreach-dashboard/server.js)

| Cron | Cadence | Purpose |
|---|---|---|
| Proxy pool warm | every 5 min | prefetch pool snapshot |
| Full-check cycle | every 4h | probe all mailboxes |
| IMAP poll | every 15 min | inbox reads for replies |
| Warmup advance | daily 05:00 Prague | bump warmup_day |
| Daily report | daily 07:00 Prague | sends/bounces summary |
| Midnight reset | daily 00:00 Prague | clear daily counters |
| Mailbox health | every 30 min | auto-heal evaluation |
| Campaign watchdog | every 60 min | paused-campaign re-entry |

## 8. INVOKE CHECKLIST FOR FIRST SEND

```bash
# 1. Force pool refresh on relay
curl -X POST $RELAY_URL/v1/admin/refresh-pool -H "Authorization: Bearer $RELAY_ADMIN_TOKEN"

# 2. Bulk reassign 3 mailboxes (probes each via SMTP AUTH)
curl -X POST http://localhost:3100/api/mailboxes/bulk-assign-proxy \
  -H "Content-Type: application/json" -d '{"ids":[1,3,631]}'

# 3. Verify campaign 455 ready
curl http://localhost:3100/api/campaigns/455/preflight

# 4. After explicit user GO → start campaign run
```
