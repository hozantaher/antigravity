# Production Health Inventory — 2026-05-02

**Status:** Data collection template. Operator must execute queries on Railway PostgreSQL.

## Railway Services

| Service | Last Deploy | Status | Notes |
|---------|-------------|--------|-------|
| anti-trace-relay | — | — | MTU 1100 fix live (PR #628) |
| outreach-orchestrator | — | — | IMAP + thread state |
| outreach-bff | — | — | Express + Go proxy |
| outreach-db | — | — | PostgreSQL primary |

**Instructions:** Run `railway service list` + `railway status --service <name>` per service.

---

## outreach-db Inventory

### Row Counts

| Table | Rows | Notes |
|-------|------|-------|
| contacts | — | Base audience |
| suppression_list | — | Post-S1 migration |
| outreach_suppressions | — | Legacy; UNION at reads |
| campaigns | — | Last 5 IDs logged |
| schema_migrations | — | Applied versions |

**DSN:** `junction.proxy.rlwy.net` + Railway credentials.

### Migration Baseline

**Applied migrations (last 5):**

```
SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;
```

**Critical: 048_suppression_list_status_sync**

```
SELECT * FROM schema_migrations WHERE version = '048_suppression_list_status_sync';
```

Expected: Applied. If missing, data inconsistency risk.

### Index Performance (Post-Cleanup Verify)

**Top seq_scan tables** (should drop post-index creation):

```
SELECT relname, seq_scan, idx_scan 
FROM pg_stat_user_tables 
WHERE seq_scan > 100 
ORDER BY seq_scan DESC LIMIT 10;
```

Expected: seq_scan << idx_scan for indexed columns.

---

## Anti-Trace Egress (Local Probe — If Accessible)

```bash
curl -s "$ANTI_TRACE_RELAY_URL/v1/egress-debug" \
  -H "Authorization: Bearer $TOKEN"
```

Expected response:
```json
{
  "mode": "mullvad|socks5",
  "exit_ip": "1.2.3.4",
  "geoip": "CZ|other"
}
```

---

## Checklist

- [ ] Railway service health verified (all green)
- [ ] contacts + suppressions row counts logged
- [ ] 048_suppression_list_status_sync confirmed applied
- [ ] Top seq_scan tables post-cleanup < 50 each
- [ ] Anti-trace relay egress mode + IP confirmed
- [ ] Campaign status (last 5 IDs + send state)

**Operator:** Collect + populate. Update BOARD.md with findings.

**Date:** 2026-05-02  
**Branch:** `docs/inventory-prod-health-2026-05-02`
