# Anonymity Baseline Ratchet — when score drops

When a PR fails the `TestAnonymityBaseline_RatchetScoreDrop` CI check, the anonymity score for one or more sender/template pairs has dropped more than 5 points below the 7-day rolling median.

## Status

**Nightly cron (A)**: Deferred to operator — see [follow-up](#follow-up-nightly-cron).

**Test file (B)**: `features/outreach/campaigns/content/anonymity_baseline_test.go` — runs at merge time if `DATABASE_URL` is set. Reads past 7 days of scored test messages and locks minimum score per (sender, template).

**This playbook (C)**: diagnostic workflow.

## When triggered

CI run fails with output like:

```
anonymity score drop detected (threshold > 5 points):
  sender=1 template="intro_machinery" baseline_median=92 current_avg=85.2 drop=7 min=81
```

Means: the intro_machinery template sent from mailbox ID 1 has dropped 7 points (85.2 now vs 92 baseline).

## Diagnostic workflow

### 1. Understand the leak

Read the detailed scores from the test run. If running locally:

```sh
# Run the test in verbose mode
DATABASE_URL=$DB go test -tags=integration -run TestAnonymityBaseline_RatchetScoreDrop \
  -v ./features/outreach/campaigns/content/ 2>&1 | tee baseline-debug.log
```

The test logs which sender/template groups violated the 5-point threshold. The PR's CI log also shows the drop.

### 2. Inspect the per-layer scores

The anonymity test produces reports with layer breakdowns:
- **L1** (IP leakage, 50 pts): Received chain analysis — external (non-Seznam) IPs detected
- **L2** (Header fingerprint, 20 pts): X-Mailer, User-Agent, Message-ID format
- **L3** (Envelope match, 10 pts): Return-Path != From
- **L4** (Auth, 20 pts): DKIM/SPF/DMARC results

If the report already exists in `reports/anonymity/<run-id>/scores.json`, extract the offending template's per-layer breakdown:

```sh
# View the layer scores for the failing run
jq '.messages[] | select(.sender_mailbox_id == 1 and .template_name == "intro_machinery") | 
  {id, score: .score, L1: .l1_ip_leak, L2: .l2_header_fp, L3: .l3_envelope, L4: .l4_auth, leaks}' \
  reports/anonymity/<run-id>/scores.json | head -20
```

### 3. Check for recent changes

**3.1 Relay / egress changes**

Reference memory: `egress_canonical` — relay sources, Mullvad VPN tunnel config, wgsocks userspace transport.

```bash
# Check recent relay code changes
git log --since="7 days ago" --oneline -- features/outreach/relay/ features/outreach/anti-trace-relay/

# Check recent transport layer changes (wgpool, chain selection)
git log --since="7 days ago" --oneline -- features/outreach/relay/internal/transport/
```

If L1 score dropped (more external IPs in Received chain):
- Mullvad tunnel misconfiguration or exit-point outage → check `features/outreach/relay/internal/transport/wgpool/pool.go`
- Relay egress chain broken → check `entrypoint.sh` and `wgsocks/main.go`
- Free proxy pool accidentally re-enabled → check `features/outreach/relay/internal/transport/chain.go` for `ErrFreePoolForbidden`

**3.2 Humanizer regression**

Reference memory: `humanize_safe_profile` — the HUMANIZE_DIACRITICS_DEGRADE setting and template variables that trigger imperfections.

```bash
# Check recent humanizer changes
git log --since="7 days ago" --oneline -- features/outreach/campaigns/content/humanizer/ \
  features/outreach/campaigns/configs/templates/

# Check if SkipHumanize flag changed
git log --since="7 days ago" -p -- features/outreach/campaigns/content/humanizer/engine.go | grep -A 5 -B 5 SkipHumanize
```

If L2 score dropped (unexpected automation headers):
- Humanizer accidentally adding telltale headers → check `features/platform/common/humanize/engine.go` for header injection
- Template variable substitution broke (e.g., `{{.Variable}}` rendering as `<bot-generated>`?) → check template `.tmpl` files for new vars

**3.3 Template edit**

```bash
# Check recent template changes
git log --since="7 days ago" -p -- features/outreach/campaigns/configs/templates/

# For the failing template, check:
# - Subject line change (spintax? invalid syntax?)
# - New variables introduced
# - Footer changes (especially GDPR compliance footer — if it changed, L2 may shift due to content-based heuristics)
```

If L2 or L3 score dropped without obvious code change:
- New subject spintax introduced → run `go test ./content -run Spin` to verify spintax validity
- Template variable missing → check if contact data migration broke (e.g., new contact type with missing field)

**3.4 DKIM/SPF/DMARC environment**

Reference memory: `mb_to_mb_anonymity_ceiling` — the maximum achievable score in mailbox-to-mailbox tests vs. real-world Gmail delivery.

```bash
# Check if the FROM address changed in the template or runner
git log --since="7 days ago" -p -- features/outreach/campaigns/content/template.go | grep -A 5 -B 5 "FROM\|from_addr"

# Check if authentication result handling changed
git log --since="7 days ago" -p -- features/inbound/orchestrator/cmd/anonymity-score/main.go | grep -A 5 -B 5 "dkim\|spf\|dmarc"
```

If L4 score dropped (auth failures):
- Sending domain SPF/DKIM misconfiguration → verify DNS records
- Test FROM address doesn't match the mailbox's actual sending domain → check orchestrator runner config
- Relay is stripping or altering Authentication-Results headers → check `features/outreach/relay/internal/delivery/privacy.go`

## Common causes

| Layer | Symptom | Cause | Fix |
|-------|---------|-------|-----|
| L1 | External IP in Received chain | Relay egress tunnel broken | Restart wgsocks containers; verify Mullvad tunnel status |
| L1 | Non-CZ proxy IP | Free SOCKS5 pool re-enabled (architecture ceiling) | Verify `chain.go` is enforcing `ErrFreePoolForbidden` |
| L2 | Unexpected X-Mailer / User-Agent | Humanizer injecting debug headers | Remove header from `features/platform/common/humanize/engine.go` |
| L2 | Message-ID not `<hash@email.cz>` | Relay's privacy sanitizer failed | Check `features/outreach/relay/internal/delivery/privacy.go` |
| L3 | Return-Path != From | Relay envelope config mismatch | Check bounce-handler routing in relay config |
| L4 | SPF/DKIM fail | Sending domain DNS or relay FROM-addr mismatch | Verify MX/SPF records; check template's FROM var |
| All | Multi-layer drop | Major refactoring or tool upgrade | Check git log; run full test suite |

## Recovery steps

### If the drop is a false alarm (regression in test harness, not code)

1. Run the anonymity test manually to confirm the drop:
   ```sh
   # From the monorepo root, after migration 023 applied:
   pnpm build
   cd features/inbound/orchestrator && go build ./cmd/anonymity-test/...
   RUN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
   ./anonymity-test --run-id="$RUN_ID"
   ./anonymity-harvest --run-id="$RUN_ID" --max-wait-seconds=300
   ./anonymity-score --run-id="$RUN_ID"
   cat "reports/anonymity/$RUN_ID/summary.md"
   ```

2. If the manually-run test shows no drop, the CI baseline may be stale. Review the baseline data:
   ```sql
   -- Show baseline medians per (sender, template)
   SELECT
     sender_mailbox_id,
     template_name,
     PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY anonymity_score)::int AS median,
     COUNT(*) AS samples,
     MIN(scored_at) AS oldest_sample,
     MAX(scored_at) AS newest_sample
   FROM anonymity_test_messages
   WHERE anonymity_score IS NOT NULL
     AND scored_at >= now() - interval '7 days'
   GROUP BY sender_mailbox_id, template_name
   ORDER BY sender_mailbox_id, template_name;
   ```
   
   If the baseline is dominated by old runs (e.g., 6 days old, now 6h away from the 7-day cutoff), wait for the nightly cron to expire that baseline and re-run the test after 24h.

### If the drop is real (code regression)

1. **Identify the offending PR** — the CI log shows which layer(s) regressed. Use the diagnostic table above to narrow the search space.

2. **Revert or fix** — depending on the change:
   - Simple config bug (humanizer flag flipped) → fix in-place
   - Template syntax error → fix and run `go test ./features/outreach/campaigns/content/`
   - Relay change → run local anti-trace-relay test (see `docs/playbooks/LOCAL-DEV-RELAY.md`)

3. **Re-run the baseline test locally** to confirm the fix:
   ```sh
   go test -tags=integration -run TestAnonymityBaseline_RatchetScoreDrop \
     ./features/outreach/campaigns/content/ -v
   ```

4. **Force a new baseline** (if the drop is justified and intentional):
   - Run the anonymity test with the new code.
   - Confirm that all L1–L4 layers are still healthy (scores within tolerance).
   - Update the 7-day window by running a fresh test run and letting the baseline age out naturally (7 days).
   - Alternatively, if the change is a known improvement (e.g., better humanization), document it in the PR and the operator can reset the baseline manually via SQL if needed.

## Follow-up: nightly cron (A)

The test framework (B) reads a 7-day rolling median computed from historical test runs. For the baseline to work, you need the nightly cron to populate `anonymity_test_messages` continuously.

**Setup required** (operator task, outside this PR):

1. Schedule a nightly job (e.g., Railway cron or GitHub Actions) that runs the full S1+S2+S3+S4 chain on staging:
   ```sh
   # Pseudocode
   RUN_ID=$(uuidgen)
   anonymity-test --run-id="$RUN_ID"           # S1: dispatch 36 test emails
   sleep 120  # wait for delivery
   anonymity-harvest --run-id="$RUN_ID"        # S2: harvest from receiver inboxes
   anonymity-score --run-id="$RUN_ID"          # S3: compute L1–L4 scores
   anonymity-humanlike --run-id="$RUN_ID"      # S4: compute human-likeness
   ```

2. Ensure the scheduled job has:
   - Valid staging mailboxes (4 active accounts with working passwords)
   - `DATABASE_URL` pointing to production DB (or staging if using a shadow copy)
   - Anti-trace-relay reachable
   - Sufficient timeout (≥10 minutes for full pipeline)

3. Once the cron runs for 7+ days, the baseline will auto-populate and the ratchet will become active in CI.

Until then, the test will skip gracefully if no baseline exists (see test code: "no baseline data in past 7 days; skipping check").

## See also

- [Anonymity test run](anonymity-test-run.md) — manual test execution procedure
- Memory: `egress_canonical` — anti-trace-relay egress strategy
- Memory: `humanize_safe_profile` — humanizer configuration and safe mode
- Memory: `mb_to_mb_anonymity_ceiling` — test limitations vs. production
- Initiative: [2026-05-01-cross-mailbox-anonymity-test](../initiatives/2026-05-01-cross-mailbox-anonymity-test.md) — full S1–S6 plan
