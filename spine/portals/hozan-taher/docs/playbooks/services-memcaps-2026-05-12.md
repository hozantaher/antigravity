# Services Memory Cap Runbook — 2026-05-12

Right-size Railway services to reduce monthly cost by ~$30-45. No service deletion.

## Audit findings

### Typesense
- 2 collections: `judikaty_decisions` (685 241 docs), `esbirka_acts` (8 875 docs)
- Current RAM: **4.46 GB allocated / 4.69 GB resident** (from `/metrics.json`)
- Request rate: **0 req/s** (scrapers dormant; MCP tools not called at scale)
- No stale/unused collections — both are in `SEARCH_INDEXES` and the MCP FTS path
- Root cause of high RAM: 685k court decisions with full text indexed in-process; Typesense keeps the full index in RAM by design

### Grafana
- 0 dashboards, 1 datasource (Loki), 1 active user
- 19 built-in datasource plugins enabled (CloudWatch, Azure Monitor, GCP, etc.) — none wired
- No alerting rules

### Loki
- Storage: `/tmp/loki` (ephemeral volume) — no explicit retention set previously → Loki default is no compaction → chunks accumulate

### searxng / privacy-gateway / scrapers
- No application-level config to change; RAM is set by Railway resource limits

---

## Actions taken (automated, 2026-05-12)

### Grafana — env vars applied via `railway variables set`

| Variable | Value | Effect |
|---|---|---|
| `GF_ANALYTICS_REPORTING_ENABLED` | `false` | Stops background analytics goroutine |
| `GF_ANALYTICS_CHECK_FOR_UPDATES` | `false` | No external check HTTP ticker |
| `GF_ALERTING_ENABLED` | `false` | Disables legacy alerting engine |
| `GF_UNIFIED_ALERTING_ENABLED` | `false` | Disables unified alerting engine |
| `GF_LOG_LEVEL` | `warn` | Reduces log buffer pressure |
| `GF_METRICS_ENABLED` | `false` | Disables internal Prometheus metrics server |
| `GF_LIVE_MAX_CONNECTIONS` | `0` | Disables WebSocket live push (no dashboards use it) |

Expected RAM reduction: ~60-80 MB (alerting + metrics engines off).

### Loki — env vars applied via `railway variables set`

| Variable | Value | Effect |
|---|---|---|
| `LOKI_COMPACTOR_RETENTION_ENABLED` | `true` | Enables compactor retention sweeps |
| `LOKI_LIMITS_GLOBAL_MAX_RETENTION_DURATION` | `168h` | 7-day global retention |
| `LOKI_STORAGE_RETENTION` | `168h` | 7-day storage retention |

Expected effect: chunks older than 7 days purged on next compaction cycle (runs every 10 min by default). Reduces volume usage and RAM pressure from chunk cache.

---

## Required manual steps in Railway dashboard

These changes require the Railway GUI (resource limits are not configurable via CLI):

### 1. Typesense — set memory limit to 512 MB

> Settings → typesense → Resources → Memory Limit → **512 MB**

**Why 512 MB and not 256 MB:** the `judikaty_decisions` index has 685k full-text documents. Typesense reports 4.46 GB allocated today because it has no cap. With a 512 MB hard cap Railway will OOM-kill and restart the service if it exceeds the limit — Typesense will reload the index from the `/data` volume (persistent). The index reload takes ~30-60s. For an on-demand FTS tool (MCP scraper, not a user-facing search box) this is acceptable. If OOM restarts happen frequently, raise to 1 GB.

**Alternative if restarts are unacceptable:** leave memory uncapped and accept the $42/mo cost.

### 2. Grafana — set memory limit to 256 MB

> Settings → garaaage-grafana → Resources → Memory Limit → **256 MB**

Current usage with 0 dashboards and 1 datasource is <150 MB. 256 MB gives headroom.

### 3. Loki — set memory limit to 128 MB

> Settings → loki → Resources → Memory Limit → **128 MB**

Loki single-binary in filesystem mode with minimal ingestion is well within 128 MB.

### 4. searxng — set memory limit to 256 MB

> Settings → searxng → Resources → Memory Limit → **256 MB**

### 5. privacy-gateway — set memory limit to 256 MB

> Settings → privacy-gateway → Resources → Memory Limit → **256 MB**

(`DELIVERY_MODE=record-only` — not in active relay path; minimal footprint.)

### 6. garaaage-scrapers — set memory limit to 256 MB

> Settings → garaaage-scrapers → Resources → Memory Limit → **256 MB**

Scrapers are dormant (BullMQ queue empty). 256 MB is generous.

---

## Restart sequence after Railway dashboard changes

After setting memory caps, redeploy each service **using `railway up`**, not `railway redeploy` (redeploy reuses old image):

```bash
# Each service independently:
railway up --service loki
railway up --service garaaage-grafana
railway up --service searxng
railway up --service privacy-gateway
railway up --service garaaage-scrapers
# Typesense: Railway dashboard Redeploy is fine (same image, new memory cap takes effect on restart)
```

Or just trigger a Redeploy from the Railway dashboard for each service — the new memory cap applies on the next container start.

---

## Estimated savings

| Service | Current bill est. | After cap | Saving |
|---|---|---|---|
| Typesense | ~$42/mo (4.5 GB RAM) | ~$6-8/mo (512 MB) | ~$34 |
| Grafana | ~$10-15/mo | ~$3/mo (256 MB) | ~$10 |
| Loki | ~$5-10/mo | ~$2/mo (128 MB) | ~$6 |
| searxng + privacy-gateway + scrapers | ~$5-10/mo | ~$3/mo | ~$5 |
| **Total** | | | **~$35-55/mo** |

Note: Railway bills by actual peak RAM usage within the cap window, not by cap size. Caps prevent cost spikes; actual savings depend on current metered usage.
