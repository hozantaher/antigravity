# MVP Launch Operator Checklist — 2026-05-05 07:00

> **Single-page operator-runnable checklist.** Initiative document with full
> context: [`docs/initiatives/2026-05-04-mvp-launch-2026-05-05.md`](../initiatives/2026-05-04-mvp-launch-2026-05-05.md).
> Master orchestration: [`docs/initiatives/2026-05-04-master-merge-and-rollout.md`](../initiatives/2026-05-04-master-merge-and-rollout.md).

## Pre-flight: load env

Open new shell:

```bash
cd ~/Documents/Projekty/hozan-taher
set -a; source features/platform/outreach-dashboard/.env; set +a
```

Verify:

```bash
echo "DB:    ${DATABASE_URL:0:40}..."
echo "Relay: $ANTI_TRACE_RELAY_URL"
echo "Token: ${ANTI_TRACE_RELAY_TOKEN:+SET}${ANTI_TRACE_RELAY_TOKEN:-MISSING}"
```

All three must be non-empty.

---

## Phase 1 — evening 2026-05-04 (T-12h to T-6h)

### 1.1 Merge launch-blocker PRs

```bash
gh pr merge 723 --merge --admin   # sanitizer paragraph fix (RCA root cause)
gh pr merge 740 --merge --admin   # HELO=localhost fix
gh pr merge 728 --merge --admin   # Engine HMAC Message-ID preserve (reply correlation)
```

`--admin` bypasses CI billing failure per memory `feedback_no_ci_nag`.

### 1.2 Verify Railway auto-deploy

After each merge, Railway redeploys `anti-trace-relay` automatically. Wait ~3 min.

```bash
curl -sS "$ANTI_TRACE_RELAY_URL/v1/egress-debug" -H "Authorization: Bearer $ANTI_TRACE_RELAY_TOKEN" | jq '{wireproxy_active, current_egress_ip, mullvad_peer_endpoint, transport_mode}'
```

Expected: `wireproxy_active: true`, `current_egress_ip: 146.70.x.x` (Mullvad CZ range), `transport_mode: "wgpool"`.

### 1.3 DE wgsocks restart (if dead)

```bash
curl -sS "$ANTI_TRACE_RELAY_URL/v1/proxy-pool" -H "Authorization: Bearer $ANTI_TRACE_RELAY_TOKEN" | jq '.endpoints[] | {label, ok_count, fail_count, quarantined}'
```

If DE shows `ok_count: 0, fail_count: >3` → operator action on Railway:

- **Option A (preferred):** Railway dashboard → `anti-trace-relay` service → Settings → Restart container. `entrypoint.sh` respawns wgsocks per endpoint.
- **Option B (if A unavailable):** Railway env → set `WIREPROXY_POOL_CONFIG` to a single-endpoint JSON (CZ only). Save → auto-restart.

Re-verify pool health 60s after restart.

### 1.4 Set HELO env (if not done)

Railway dashboard → `anti-trace-relay` service → Variables → `SMTP_HELLO_DOMAIN=email.cz` → Save.

(Optional — `pickHELODomain` from PR #740 derives sender domain by default. Explicit env is operator override.)

### 1.5 Smoke cross-send

```bash
bash /tmp/cross_send.sh   # if /tmp script lost, see scripts/anti-trace-verify/sprint_y.sh
```

Expected: ≥10/12 INBOX, 0 spam. Pre-fix baseline was 11/12 (92%) — post-fix should match or exceed.

### 1.6 Refresh test sentinel

```bash
cd features/platform/outreach-dashboard && pnpm test:fast 2>&1 | tail -3
cd ../.. && go test ./features/outreach/relay/internal/delivery/ ./features/outreach/campaigns/sender/ -count=1 -short 2>&1 | tail -3
touch .last-tests-passed
```

All Go tests must pass. Dashboard `test:fast` should pass (3 memory frontmatter failures fixed by Chat A overnight).

---

## Phase 2 — sleep window (T-6h to T-2h)

Set alarm 06:00. Verify Sentry inbox before bed. No proactive action.

---

## Phase 3 — morning 06:00–07:00

### 3.1 Start BFF

```bash
cd features/platform/outreach-dashboard && pnpm dev > /tmp/bff.log 2>&1 &
sleep 30
curl -sS -H "x-api-key: $OUTREACH_API_KEY" http://localhost:18001/api/health/system | \
  jq '{healthy, egress_mode, proxy_pool_size, watchdog_stale, alerts: (.alerts // [] | length)}'
```

Expected:

```json
{
  "healthy": true,
  "egress_mode": "wg-pool",
  "proxy_pool_size": 2,
  "watchdog_stale": false,
  "alerts": 0
}
```

`/api/health/system` is the canonical merged-health endpoint
(proxy pool + watchdog + alerts in one response). Bare `/api/health`
does NOT exist — `/api/health/*` sub-routes only (system, invariants,
cron-heartbeats, watchdog, drift). Tail boot log to verify exactly
one warning post-PR-#749:

```bash
grep "invariants" /tmp/bff.log
# expected: [invariants] passed=7 warnings=1 failed=0
# expected: [invariants] WARN schema-manifest-loadable
```

`schema-manifest-loadable` is intentional placeholder (TBD pending
S1 Go /schema endpoint deploy). NOT a launch blocker.

### 3.2 Verify-launch dry-run

```bash
cd features/platform/outreach-dashboard && pnpm verify:launch --campaign-id=1 --json 2>&1 | jq '.gates[] | {name, status, blocker}'
```

All 5 gates must report `status: "pass"`. Specifically:

| Gate | Expected |
|------|----------|
| egress_sanity | pass |
| bff_preflight | pass |
| smtp_probe | pass — 4/4 active mailboxes |
| template_render | pass — `intro_machinery.tmpl` resolves, `{{.UnsubURL}}` present |
| db_write_probe | pass (skipped in dry-run) |

If any FAIL: STOP. Investigate before continuing. Do NOT unpause campaign 1 without all gates green.

### 3.3 Single test envelope to operator's external mailbox

```bash
RECIPIENT="messing.tomas@gmail.com"   # or own external mailbox
psql "$DATABASE_URL" -At -F '|' -c "SELECT smtp_username, password, smtp_host, smtp_port, from_address FROM outreach_mailboxes WHERE status='active' ORDER BY id LIMIT 1;" | \
  awk -F'|' -v r="$RECIPIENT" '{
    printf "{\"from\":\"%s\",\"password\":\"%s\",\"smtp_host\":\"%s\",\"smtp_port\":%s,\"recipient\":\"%s\",\"subject\":\"Pre-launch smoke %s\",\"body\":\"Pre-launch smoke envelope.\\nDate: %s\\n\\n--\\nSmoke test\"}", $1,$2,$3,$4, r, ENVIRON["EPOCHSECONDS"], strftime("%Y-%m-%d %H:%M:%S")
  }' | curl -sS -X POST "$ANTI_TRACE_RELAY_URL/v1/raw-smtp-test" \
    -H "Authorization: Bearer $ANTI_TRACE_RELAY_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- | jq '{ok, endpoint_label, smtp_response, error}'
```

Expected: `ok: true, endpoint_label: "cz"`. Verify visually in Gmail INBOX within 60s.

### 3.4 07:00 sharp — UNPAUSE

```bash
psql "$DATABASE_URL" -c "UPDATE campaigns SET status='active' WHERE id=1 RETURNING id, name, status;"
```

Expected output: `1 | Strojírenství — první kontakt | active`.

Runner cron picks up campaign within 30 sec.

---

## Phase 4 — Day 1 monitoring (07:00–07:00 next day)

### 4.1 First 30 minutes (07:00–07:30)

Watch in 3 windows:

```bash
# Window 1: relay queue
watch -n 30 "curl -sS '$ANTI_TRACE_RELAY_URL/v1/status' -H 'Authorization: Bearer $ANTI_TRACE_RELAY_TOKEN' | jq '{queue_depth, oldest_pending_age_seconds, delivery_mode}'"
```

```bash
# Window 2: send_events tail
watch -n 60 "psql '$DATABASE_URL' -c \"SELECT campaign_id, status, count(*) FROM send_events WHERE sent_at > now() - interval '30 minutes' GROUP BY 1,2 ORDER BY 1,2;\""
```

```bash
# Window 3: cron heartbeats
watch -n 120 "psql '$DATABASE_URL' -c \"SELECT cron_name, last_run_at, last_status FROM cron_heartbeats ORDER BY last_run_at DESC LIMIT 6;\""
```

### 4.2 Half-day check (~13:00)

```bash
psql "$DATABASE_URL" -At -F '|' -c "
SELECT
  count(*) FILTER (WHERE status='sent')      AS sent,
  count(*) FILTER (WHERE status='bounced')   AS bounced,
  count(*) FILTER (WHERE status='suppressed') AS suppressed
FROM send_events WHERE campaign_id=1 AND sent_at > now() - interval '6 hours';
"
```

Expected: ~5-20 sent (Day 1 pacing 5/d/mb × 4 mailboxes), 0-1 bounced, 0 suppressed.

### 4.3 End-of-day check (~19:00)

```bash
psql "$DATABASE_URL" -At -F '|' -c "
SELECT
  count(*)::float / NULLIF(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END), 0) AS attempt_rate,
  count(*) FILTER (WHERE status='sent') AS sent_today,
  count(DISTINCT contact_id)            AS unique_recipients
FROM send_events WHERE campaign_id=1 AND sent_at > now() - interval '12 hours';
"
```

Plus IMAP probe a sample recipient (per anti-trace-verify toolkit) to confirm INBOX placement on receiving end.

---

## Rollback triggers + procedure

If ANY of these:

- Delivery rate <50% in first 4 hours
- Sentry error rate >10/min for 15+ minutes
- Mailbox `circuit_opened_at` populated for any active mailbox
- Mullvad pool zero `ok_count` across all endpoints
- Operator visual inspection of test recipient shows >20% in spam

**Pause immediately:**

```bash
psql "$DATABASE_URL" -c "UPDATE campaigns SET status='paused' WHERE id=1 RETURNING id, status;"
```

Verify queue drains:

```bash
curl -sS "$ANTI_TRACE_RELAY_URL/v1/status" -H "Authorization: Bearer $ANTI_TRACE_RELAY_TOKEN" | jq '{queue_depth, oldest_pending_age_seconds}'
```

`queue_depth` should approach 0 within 5 minutes (in-flight envelopes deliver). After drain, investigate Sentry stack traces, sender-engine slog records, relay logs in Railway.

If revert needed (e.g., #723 caused regression):

```bash
gh pr revert 723   # creates revert PR
gh pr merge --merge --admin   # admin merge → Railway redeploy
```

Document incident → post-mortem in `docs/audits/2026-05-05-launch-incident.md`.

---

## Phase 5 — week 1 ramp

| Day | Send rate per mailbox | Total/day across 4 mailboxes |
|-----|----------------------|-------------------------------|
| Day 1 | 5/d | 20 |
| Day 2 | 30/d | 120 |
| Day 3-4 | 60/d | 240 |
| Day 5-6 | 90/d | 360 |
| Day 7 | 120/d (daily_cap) | 480 |

Ramp config in `features/outreach/campaigns/sender/Engine` SendingConfig — operator updates per day morning. If delivery rate <80% any day, hold at current rate, escalate.

Day 7 evaluation: if 7-day delivery >80%, archive launch initiative + master rollout + amend ADR-013 to "Accepted". Otherwise rollback + post-mortem.

---

## Quick reference — env vars

| Variable | Source | Purpose |
|----------|--------|---------|
| `DATABASE_URL` | features/platform/outreach-dashboard/.env | Postgres TCP-proxy URL |
| `ANTI_TRACE_RELAY_URL` | same | https://anti-trace-relay-production-a706.up.railway.app |
| `ANTI_TRACE_RELAY_TOKEN` | same | Bearer for `/v1/submit` |
| `SMTP_HELLO_DOMAIN` | Railway env | HELO override (default: derives from sender domain post-#740) |
| `OUTREACH_API_KEY` | features/platform/outreach-dashboard/.env | BFF→Go orchestrator auth |

---

## Cross-references

- Launch initiative: [`docs/initiatives/2026-05-04-mvp-launch-2026-05-05.md`](../initiatives/2026-05-04-mvp-launch-2026-05-05.md)
- Master orchestration: [`docs/initiatives/2026-05-04-master-merge-and-rollout.md`](../initiatives/2026-05-04-master-merge-and-rollout.md)
- ADR-013: [`docs/decisions/ADR-013-anti-trace-safe-profile.md`](../decisions/ADR-013-anti-trace-safe-profile.md) (Proposed)
- Subsystem map: [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md) (refresh in flight)
- Diagnostic toolkit: [`scripts/anti-trace-verify/`](../../scripts/anti-trace-verify/)
- HARD RULE memories: `feedback_anti_trace_full_stack`, `feedback_no_pii_in_commands`, `feedback_campaign_send`, `feedback_mailbox_passwords_via_db`, `feedback_no_external_services`, `feedback_no_ci_nag`.
