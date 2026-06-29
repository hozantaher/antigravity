# Production Health Inventory — 2026-05-03

**Status date**: 2026-05-03 (post-D2 rate-limit PR #640 + server.js decomp partial + secret hygiene incomplete)

**Critical alert**: Outreach-dashboard at 5/5 failed deploys (2026-04-21). Prod still serving Nuxt build (2026-04-17 SUCCESS). React rewrite in repo, undeployed.

---

## Service Status Summary

| Service | Status | Last Deploy | Concern |
|---------|--------|-------------|---------|
| `anti-trace-relay` | **ACTIVE** | 2026-04-21 18:49 | Pool refresh fixed; egress OK |
| `machinery-outreach` | **ACTIVE** | 2026-04-22 12:31 | Intel loop running; scheduler OK |
| `outreach-dashboard` | **DEGRADED** | 2026-04-17 21:16 (Nuxt) | React not deployed; 5× FAILED 04-21 |
| `outreach-db` | **ACTIVE** | 2026-04-04 (managed) | Postgres 16; no recent schema changes |
| `redis` | **ACTIVE** | 2026-03-26 (managed) | Session store, rate limiter OK |
| `privacy-gateway` | **ACTIVE** | 2026-04-04 02:04 | Stale (18+ days); audit log intact |

---

## Database State

- **Migration baseline**: No schema changes last 7 days (scripts/migrations/ untouched).
- **Suppression schema** (`048_suppression_list_status_sync`): Status unknown (no access to prod DB).
- **Expected row counts**: Last snapshot 2026-04-22 in SERVICES.md; no health report post-D2.
- **Index health**: Presumed stable; privacy-gateway audit path + campaigns.send_events active.

---

## Active Campaigns

- **Running**: Unknown (requires `machinery-outreach` API query or DB poll).
- **Paused**: Unknown.
- **Recommended probe**: `curl -s -H "X-API-Key: $OUTREACH_API_KEY" https://machinery-outreach-production.up.railway.app/api/campaigns?status=running` (requires Railway secret access).

---

## Egress Mode & AntiTrace Relay

- **Mode**: BFF proxies to anti-trace-relay (PR #625, 2026-04-25). Direct SMTP/IMAP banned (PR #626).
- **Current relay pool**: Proxifly primary + geonode secondary (stale state <5 min).
- **IP probe**: Requires `curl -s https://anti-trace-relay-production-a706.up.railway.app/v1/egress-debug` (auth unknown).

---

## Sentry Error Rate

- **Access**: Requires Railway workspace context (not available in isolated CLI).
- **Last commit signal**: 5 anti-speculation chore commits (2026-04-09–2026-04-22) suggest recent refactoring; error spike post-merge expected.

---

## Blockers & Next Steps

1. **Outreach-dashboard deploy failure**: 5 consecutive FAILED deploys (2026-04-21). Analyze React build errors before next attempt.
2. **Suppression schema audit**: Confirm migration 048 applied. Row counts via direct DB query.
3. **Campaign activity**: Poll `/api/campaigns?status=running` from machinery-outreach.
4. **Sentry + Railway logs**: Requires workspace CLI session or dashboard access.

**Recommendation**: Post-inventory requires **active Railway + Sentry dashboard session** for full diagnostic loop.
