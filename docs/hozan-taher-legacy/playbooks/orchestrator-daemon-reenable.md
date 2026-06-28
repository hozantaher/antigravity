# Orchestrator daemon re-enable runbook (post AW7-6 fix)

> Status: Operational. Created 2026-05-10 after AW7-6 deeper RCA.
>
> Use this runbook when bringing the campaign daemon back up after it has
> been disabled (DISABLE_CAMPAIGN_DAEMON=1) — typically following an
> incident, a bad deploy, or a maintenance pause.

## Background

AW7-6 closed the runner-engine ordering race that caused log spam at
01:58 CEST 2026-05-09 ("step advance matched 0 rows — concurrent runner
detected"). Pre-AW7-6 the runner called `engine.Enqueue` BEFORE the
reservation `UPDATE campaign_contacts SET status='in_flight'`. Because
Enqueue is non-blocking and `engine.Run` consumes the queue from a
SEPARATE goroutine, the engine could call `FinalizeSentStep` before the
runner UPDATE landed — leaving contacts stuck `in_flight` forever and
flooding logs with false "concurrent runner" errors.

AW7-6 swapped the order: **reserve first, then enqueue**. CAS miss on
reservation now means simply "skip enqueue" — no send is dispatched,
nothing leaks, and the row stays eligible for the next tick.

## Pre-flight checks

Before flipping `DISABLE_CAMPAIGN_DAEMON=0`:

1. **Confirm the deploy includes AW7-6.** Check `git log` on the deployed
   commit for `fix(aw7-6)` in the message:

   ```bash
   gh release view --json tagName,commitish | jq -r '.commitish'
   git log --oneline <commit>..HEAD | grep aw7-6
   ```

2. **Confirm migration state.** `campaign_contacts.status` enum must
   already include `in_flight` (migration 091 / earlier). Run:

   ```bash
   ./scripts/migrations/run.sh --check
   ```

3. **Confirm the AW7-3 watchdog reaper is still wired.** Look for
   `in-flight reaper daemon started` in `outreach` service logs from a
   previous boot. The reaper threshold is 24h by default
   (`IN_FLIGHT_STUCK_THRESHOLD_HOURS`).

4. **Quiesce the queue.** If contacts are currently stuck `in_flight`
   from an earlier (pre-AW7-6) incident, sweep them BEFORE enabling so
   the boot tick starts clean:

   ```sql
   UPDATE campaign_contacts
      SET status       = 'pending',
          current_step = GREATEST(current_step - 1, 0),
          next_send_at = NULL
    WHERE status = 'in_flight'
      AND created_at < now() - interval '1 hour';
   ```

   Verify with:

   ```sql
   SELECT status, COUNT(*) FROM campaign_contacts GROUP BY status;
   ```

## Enable sequence

1. **Set the env var on Railway** (machinery-outreach service):

   ```
   DISABLE_CAMPAIGN_DAEMON=0
   ```

   Railway will trigger a redeploy.

2. **Watch the boot logs** for these expected lines (in order):

   ```
   Campaign daemon started interval=15m0s
   campaign daemon started interval=15m0s
   in-flight reaper daemon started interval=1h0m0s threshold_hours=24
   ```

3. **First tick fires immediately.** Expect within ~5 seconds of boot:

   ```
   campaign enqueued emails campaign=<name> count=<N>
   ```

   If `count=0` and you have `pending` contacts, check the calendar gate
   (CZ holiday / send window) and `cc.next_send_at` for stale future
   timestamps.

## Post-enable verification (first 5 minutes)

1. **No "reservation lost CAS" log spam.** Some rate is normal under
   real contention (in-flight reaper boot-sweep, operator manual edits)
   but >10/minute indicates a regression.

   ```
   railway logs --service machinery-outreach | grep "reservation lost CAS"
   ```

   Threshold: ≤5 hits per first 5 min on a clean boot.

2. **No "step advance matched 0 rows" log.** This wording was REMOVED in
   AW7-6. If you see it, the deploy did not include the fix.

3. **send_events row growth correlates with status changes.** Run:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM campaign_contacts WHERE status = 'in_sequence' AND updated_at > now() - interval '5 min') AS sequenced,
     (SELECT COUNT(*) FROM campaign_contacts WHERE status = 'completed'   AND updated_at > now() - interval '5 min') AS completed,
     (SELECT COUNT(*) FROM send_events                                       WHERE sent_at    > now() - interval '5 min') AS sent;
   ```

   `sequenced + completed` should approximately equal `sent`. Pre-AW7
   the phantom-completed bug had completed >> sent. Pre-AW7-6 the
   inverse race could have left in_flight rows orphaned (no
   in_sequence/completed rows even when sent succeeded). After AW7-6,
   the two should track within ~5% (small drift from in-flight rows
   awaiting their callback).

4. **Watch in_flight depth.** `in_flight` should be transient (seconds,
   not minutes). Persistent `in_flight` rows >5 minutes indicate an
   engine callback drop:

   ```sql
   SELECT COUNT(*) FROM campaign_contacts WHERE status = 'in_flight'
                                            AND updated_at < now() - interval '5 min';
   ```

   Expected: 0. Anything >0 within the first hour of boot suggests the
   `wrapSendCallbackWithRecover` path is failing — escalate to engineering.

## Rollback

If the dashboard shows runaway `in_flight` rows OR the "reservation lost
CAS" log fires >10/minute:

1. Set `DISABLE_CAMPAIGN_DAEMON=1` on Railway.
2. Wait 30 sec for the in-flight queue to drain (engine.Run goroutine
   exits on context cancel).
3. Sweep stuck rows:
   ```sql
   UPDATE campaign_contacts
      SET status = 'pending',
          current_step = GREATEST(current_step - 1, 0),
          next_send_at = NULL
    WHERE status = 'in_flight';
   ```
4. File a follow-up issue with logs from `outreach` service for the
   first 5 minutes after re-enable. Include the campaign IDs that were
   actively sending and counts from the verification SQL above.

## Why this is now safe (AW7-6 invariant)

The new ordering is enforced by:

- `features/outreach/campaigns/campaign/runner.go` — reservation UPDATE precedes
  `r.engine.Enqueue(...)`. CAS-miss path bails out without enqueueing.
- `features/outreach/campaigns/campaign/runner_aw7_6_ordering_test.go` — 12 test
  cases lock the contract:
  - reservation UPDATE happens before any engine queue depth change;
  - CAS miss → queue depth stays 0;
  - DB error on reservation → queue depth stays 0;
  - successful reservation → queue depth = 1;
  - one tick with two contacts → both reserve before either enqueues;
  - mixed CAS miss + success → only the success path enqueues.
- The existing AW7-3 watchdog reaper still catches anything that slips
  through (any `in_flight` row older than 24h is rolled back to
  `pending`).
- AW7-4 `BulkRevertInFlight` still fires on engine.Run goroutine panics.

The `wrapSendCallbackWithRecover` wrapper continues to guarantee that a
panicking onSent callback does not strand a contact in `in_flight` —
RevertFailedStep runs idempotently from the recover path.
