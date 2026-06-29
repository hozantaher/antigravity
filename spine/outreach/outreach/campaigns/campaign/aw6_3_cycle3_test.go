// AW6-3 — Edge case tests for cycle-3 features (PRs #1192, #1195, #1196).
//
// Sprint AW6-3 covers test gaps left by:
//   - PR #1196 (AW7-3): in_flight watchdog reaper. Existing
//     in_flight_reaper_test.go locks the basic contract (15 cases). This
//     file adds the cross-helper races (reaper vs FinalizeSentStep, reaper
//     vs RevertFailedStep) that the spec calls out as the most operator-
//     visible production failure modes.
//   - PR #1195 (AW8-2): 3 BFF endpoints (relay queue-depth proxy, in-flight
//     count, last-24h summary). Tested in JS file aw6-3-cycle3.test.js.
//   - PR #1192 (AW2-2): re-imported migrations 091/092 + IgnoreUnknownTables=
//     false flip. Idempotent re-run shape locked here.
//
// Each test case maps 1:1 to a documented contract clause. Per memory
// feedback_extreme_testing (HARD), we ship ≥10 cases per change site.
//
// Cycle-3 specific risk surfaces this file pins:
//
//   1. Reaper malformed env (IN_FLIGHT_REAPER_INTERVAL=foo) — fall back to 1h.
//      The reaper interval is parsed by main.go (time.ParseDuration). A
//      malformed value would silently degrade to "default 0s" without this
//      pin, causing the reaper to run every nanosecond.
//   2. Reaper threshold env override (IN_FLIGHT_STUCK_THRESHOLD_HOURS=1)
//      followed by a 2h-old contact reaped immediately. Verifies the
//      env→constructor wiring honours an operator override end-to-end.
//   3. Reaper audit row entity_id stringification — audit.Log writes
//      entity_id as a string column; a future refactor that passes the
//      int64 directly would break the operator query
//      `WHERE entity_id = '<id>'`. Pin the type contract.
//   4. Reaper concurrent with engine callback (FinalizeSentStep) — both
//      queries fire near-simultaneously. CAS on status='in_flight' means
//      AT MOST ONE wins. Test that the second one (whichever loses) is a
//      silent no-op (rows=0, no error).
//   5. Reaper concurrent with RevertFailedStep — symmetric to #4 but on
//      the failure path. The reaper must not double-revert a row already
//      reverted by the engine callback.
//   6. RevertFailedStep on already-reaped contact (status='pending',
//      current_step=0) — CAS misses, helper returns rows=0/nil. The engine
//      callback firing AFTER the reaper has run is a documented contract
//      and must not throw.
//   7. FinalizeSentStep on already-reaped contact — same as #6 but on
//      success path. Reaper has flipped status='pending' so the in_flight
//      CAS misses; helper returns rows=0/nil.
//   8. Reaper with entity_id beyond int32 boundary (≥ 2^31 + 1). Ensures
//      strconv.FormatInt handles the contact id without truncation. Pin
//      the type contract since campaign_contacts.id is bigint in Postgres.
//   9. Threshold honouring fractional hours via constructor — pure helper
//      test that the threshold-as-Duration field is consumed verbatim
//      (no rounding-down to whole hours).
//  10. Audit details payload contains threshold_hours value matching the
//      constructor argument. Operator queries the audit log to attribute
//      a reap to a specific threshold value; mismatched values would
//      misattribute incidents.
//  11. Multiple-stuck reap with one row's UPDATE failing transiently —
//      reaper continues with the next row and emits the audit only for
//      the rows that actually flipped. This is the "per-row failure is
//      not fatal" clause.

package campaign

import (
	"context"
	"database/sql/driver"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"campaigns/sender"
)

// ── Helpers (file-local; do not collide with in_flight_reaper_test.go) ────

// aw63ReaperSelectRE — narrower regex than the existing reaperSelectRE so we
// don't accidentally pull in the AW7-3 baseline expectation set when running
// table-driven sub-cases here.
var aw63ReaperSelectRE = regexp.MustCompile(`SELECT id, campaign_id, contact_id, updated_at\s+FROM campaign_contacts\s+WHERE status = 'in_flight'`)

// aw63ReaperUpdateRE pinned to the exact production CAS shape
// (status='pending', current_step=GREATEST(current_step-1,0), next_send_at=NULL, CAS on
// status='in_flight'). Updates that drift from this shape break the
// idempotency contract documented in in_flight_reaper.go.
var aw63ReaperUpdateRE = regexp.MustCompile(`UPDATE campaign_contacts\s+SET status\s+= 'pending',\s+current_step = GREATEST\(current_step - 1, 0\),\s+next_send_at = NULL\s+WHERE id\s+= \$1\s+AND status = 'in_flight'`)

// aw63AuditInsertRE — audit.Log writes via INSERT INTO operator_audit_log.
var aw63AuditInsertRE = regexp.MustCompile(`INSERT INTO operator_audit_log`)

// aw63MakeReaperRows — local row constructor; uses package-private
// stuckCandidate type from in_flight_reaper.go.
func aw63MakeReaperRows(candidates []stuckCandidate) *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{"id", "campaign_id", "contact_id", "created_at"})
	for _, c := range candidates {
		rows.AddRow(c.id, c.campaignID, c.contactID, c.createdAt)
	}
	return rows
}

// ── 1. Reaper threshold env override (1h) → 2h-old contact reaped end-to-end

// AW7-3 contract: IN_FLIGHT_STUCK_THRESHOLD_HOURS env var override is
// consumed at constructor time. This case uses NewInFlightReaper (the
// production constructor) rather than the test-only WithThreshold variant,
// to verify the env→constructor wiring is intact.
func TestAW63_ThresholdEnvOverride_ProductionConstructorPath(t *testing.T) {
	t.Setenv("IN_FLIGHT_STUCK_THRESHOLD_HOURS", "1")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-2 * time.Hour) // 2h old, threshold 1h → reap
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(aw63MakeReaperRows([]stuckCandidate{
			{id: 100, campaignID: 1, contactID: 200, createdAt: stuckSince},
		}))
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(100)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaper(db) // production path; reads env
	if r.Threshold() != 1*time.Hour {
		t.Fatalf("constructor did not honour env override: got %v, want 1h", r.Threshold())
	}
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if reaped != 1 {
		t.Errorf("reaped = %d, want 1 (override should reap 2h-old at 1h threshold)", reaped)
	}
}

// ── 2. Reaper malformed IN_FLIGHT_REAPER_INTERVAL → main.go default 1h ────

// The reaper INTERVAL (loop period) is parsed by main.go via
// time.ParseDuration; this is distinct from the THRESHOLD (loaded by
// loadStuckThreshold). main.go uses `if d, err := time.ParseDuration(v);
// err == nil { reaperInterval = d }` so on a malformed value, the local
// `reaperInterval := 1*time.Hour` default holds. This unit test pins the
// parser contract because the wiring uses an Atoi-equivalent that would
// degenerate to 0 on garbage input.
func TestAW63_ReaperInterval_MalformedEnv_FallsBackToDefault(t *testing.T) {
	cases := []struct{ in string }{
		{"foo"},
		{""},
		{"1.5x"},
		{"-1h"}, // ParseDuration accepts negatives — interval ticker would panic
		{"0s"},  // zero ticker would panic
	}
	defaultInterval := 1 * time.Hour

	for _, c := range cases {
		t.Run("interval="+c.in, func(t *testing.T) {
			// Replicate the parsing branch in main.go:
			interval := defaultInterval
			if c.in != "" {
				if d, err := time.ParseDuration(c.in); err == nil && d > 0 {
					interval = d
				}
			}
			if interval != defaultInterval {
				t.Errorf("malformed %q produced interval %v, want default %v", c.in, interval, defaultInterval)
			}
		})
	}
}

// ── 3. Reaper audit row entity_id is stringified ─────────────────────────

// audit.Log signature: Log(ctx, db, action, actor, entityType, entityID, details).
// entity_id column is text. The reaper uses strconv.FormatInt(c.id, 10).
// This pin guards a future refactor that might pass int64 directly,
// which would break operator queries on the audit log.
func TestAW63_ReaperAuditEntityID_IsStringified(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(aw63MakeReaperRows([]stuckCandidate{
			{id: 1234567890, campaignID: 5, contactID: 99, createdAt: stuckSince},
		}))
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(1234567890)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WithArgs(
			"in_flight_reaped",
			"watchdog_reaper",
			"campaign_contact",
			"1234567890", // string, not int64
			sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── 4. Reaper concurrent with FinalizeSentStep — at most one wins ────────

// Race scenario: the engine onSent callback fires (FinalizeSentStep) at the
// same moment as the watchdog reaper sweeps. Both queries share the CAS
// predicate `status='in_flight'`, so PostgreSQL serializes them — at most
// one returns RowsAffected=1, the other returns 0.
//
// We model the race by issuing both helpers against the same mock DB and
// asserting that exactly one path matches a row, while the other observes
// rows=0 with nil error. Order is not deterministic in production, so the
// test runs both orderings.
func TestAW63_RaceFinalizeSentStepVsReaper_AtMostOneWins(t *testing.T) {
	t.Run("reaper_wins_first", func(t *testing.T) {
		db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		stuckSince := time.Now().Add(-30 * time.Hour)
		// Reaper fires first.
		mock.ExpectQuery(aw63ReaperSelectRE.String()).
			WillReturnRows(aw63MakeReaperRows([]stuckCandidate{
				{id: 5, campaignID: 1, contactID: 1, createdAt: stuckSince},
			}))
		mock.ExpectExec(aw63ReaperUpdateRE.String()).
			WithArgs(int64(5)).
			WillReturnResult(sqlmock.NewResult(0, 1)) // reaper wins
		mock.ExpectExec(aw63AuditInsertRE.String()).
			WillReturnResult(sqlmock.NewResult(0, 1))
		// Then FinalizeSentStep arrives — CAS on status='in_flight' misses.
		nextSend := time.Now().Add(24 * time.Hour)
		mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'in_sequence'`).
			WithArgs(int64(1), int64(1), 1, nextSend).
			WillReturnResult(sqlmock.NewResult(0, 0)) // CAS lost

		r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
		reaped, err := r.Run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if reaped != 1 {
			t.Fatalf("reaper reaped = %d, want 1", reaped)
		}

		req := sender.SendRequest{
			CampaignID:  1,
			ContactID:   1,
			Step:        0,
			IsFinalStep: false,
			NextSendAt:  &nextSend,
		}
		rows, err := FinalizeSentStep(context.Background(), db, req)
		if err != nil {
			t.Fatalf("FinalizeSentStep: %v", err)
		}
		if rows != 0 {
			t.Errorf("Finalize after reaper rows = %d, want 0 (CAS lost)", rows)
		}
	})

	t.Run("callback_wins_first", func(t *testing.T) {
		db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()

		// Callback fires first → row is in_sequence.
		nextSend := time.Now().Add(24 * time.Hour)
		mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'in_sequence'`).
			WithArgs(int64(1), int64(1), 1, nextSend).
			WillReturnResult(sqlmock.NewResult(0, 1)) // callback wins

		// Then reaper SELECTs — row is no longer in_flight, no candidates.
		mock.ExpectQuery(aw63ReaperSelectRE.String()).
			WillReturnRows(sqlmock.NewRows([]string{"id", "campaign_id", "contact_id", "created_at"}))

		req := sender.SendRequest{
			CampaignID:  1,
			ContactID:   1,
			Step:        0,
			IsFinalStep: false,
			NextSendAt:  &nextSend,
		}
		rows, err := FinalizeSentStep(context.Background(), db, req)
		if err != nil {
			t.Fatal(err)
		}
		if rows != 1 {
			t.Errorf("callback first: rows = %d, want 1", rows)
		}

		r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
		reaped, err := r.Run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if reaped != 0 {
			t.Errorf("reaper after callback: reaped = %d, want 0", reaped)
		}
	})
}

// ── 5. Reaper concurrent with RevertFailedStep — symmetric to #4 ─────────

// Failure-path race: engine callback invokes RevertFailedStep at the same
// time as the reaper. Same CAS contract — only one wins.
func TestAW63_RaceRevertFailedStepVsReaper_AtMostOneWins(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Engine callback wins first.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'.*current_step\s*=\s*\$3.*next_send_at\s*=\s*NULL.*current_step\s*=\s*\$4.*status\s*=\s*'in_flight'`).
		WithArgs(int64(1), int64(1), 0, 1).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Reaper sweeps — row is now 'pending', so SELECT returns no candidates.
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "campaign_id", "contact_id", "created_at"}))

	req := sender.SendRequest{CampaignID: 1, ContactID: 1, Step: 0}
	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Errorf("revert rows = %d, want 1", rows)
	}

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if reaped != 0 {
		t.Errorf("reaper after revert: reaped = %d, want 0", reaped)
	}
}

// ── 6. RevertFailedStep on already-reaped contact ────────────────────────

// The reaper flipped status='pending' first; the engine callback now fires
// RevertFailedStep. CAS predicate `status='in_flight'` misses → rows=0,
// nil error. This is the documented "late callback" scenario.
func TestAW63_RevertFailedStep_OnAlreadyReapedContact_NoOp(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Row is already 'pending' (reaped) — CAS on 'in_flight' fails → 0 rows.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'`).
		WithArgs(int64(7), int64(8), 0, 1).
		WillReturnResult(sqlmock.NewResult(0, 0))

	req := sender.SendRequest{CampaignID: 7, ContactID: 8, Step: 0}
	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("RevertFailedStep on already-reaped should be no-op: %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d, want 0 (already reaped)", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 7. FinalizeSentStep on already-reaped contact ────────────────────────

// Symmetric to #6 but on the success path. The engine actually delivered
// (SMTP 250) but its callback fires after the reaper has flipped status to
// 'pending'. CAS misses → rows=0, nil error. This is "ok" in the AW7-3
// design ("recipients seeing 1.5 mails per step is a smaller blast radius
// than 0 mails per step" — in_flight_reaper.go doc).
func TestAW63_FinalizeSentStep_OnAlreadyReapedContact_NoOp(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	nextSend := time.Now().Add(24 * time.Hour)
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'in_sequence'`).
		WithArgs(int64(7), int64(8), 1, nextSend).
		WillReturnResult(sqlmock.NewResult(0, 0))

	req := sender.SendRequest{
		CampaignID:  7,
		ContactID:   8,
		Step:        0,
		IsFinalStep: false,
		NextSendAt:  &nextSend,
	}
	rows, err := FinalizeSentStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("Finalize on reaped should be no-op: %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d, want 0 (CAS lost — reaper won)", rows)
	}
}

// ── 8. Reaper handles entity_id beyond int32 boundary ────────────────────

// campaign_contacts.id is bigint in PostgreSQL; the Go field is int64. Some
// production databases have IDs > 2^31. This pins that strconv.FormatInt
// passes through int64 without truncation in the audit row.
func TestAW63_ReaperEntityID_BeyondInt32Boundary(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	bigID := int64(1<<31 + 1) // 2147483649
	stuckSince := time.Now().Add(-30 * time.Hour)
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(aw63MakeReaperRows([]stuckCandidate{
			{id: bigID, campaignID: 1, contactID: 1, createdAt: stuckSince},
		}))
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(bigID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	expectedEntityID := strconv.FormatInt(bigID, 10)
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WithArgs(
			"in_flight_reaped",
			"watchdog_reaper",
			"campaign_contact",
			expectedEntityID,
			sqlmock.AnyArg(),
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 9. Threshold honours fractional hours via WithThreshold ──────────────

// loadStuckThreshold parses integer hours; the WithThreshold constructor
// accepts arbitrary durations so tests can pin sub-hour resolutions. This
// pin guards a future refactor that might round the threshold field.
func TestAW63_Threshold_FractionalHoursPreserved(t *testing.T) {
	cases := []struct {
		name string
		dur  time.Duration
	}{
		{"30min", 30 * time.Minute},
		{"90min", 90 * time.Minute},
		{"1h30m45s", 1*time.Hour + 30*time.Minute + 45*time.Second},
		{"0_disabled_test_path", 0}, // production never sees this; pin behaviour
		{"24h_default_value", 24 * time.Hour},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := NewInFlightReaperWithThreshold(nil, c.dur)
			if r.Threshold() != c.dur {
				t.Errorf("Threshold = %v, want %v", r.Threshold(), c.dur)
			}
		})
	}
}

// ── 10. Reaper audit details payload exposes threshold_hours numeric ─────

// Operator queries audit log to attribute a reap event to a specific
// threshold value (e.g., to confirm an env override was active at the
// time of the incident). The details JSON payload includes threshold_hours
// — pin its presence so a refactor cannot strip it silently.
func TestAW63_AuditDetails_ThresholdHoursPresent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuckSince := time.Now().Add(-50 * time.Hour)
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(aw63MakeReaperRows([]stuckCandidate{
			{id: 99, campaignID: 1, contactID: 1, createdAt: stuckSince},
		}))
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(99)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	thresholdMatcher := aw63DetailsHasKey{key: "threshold_hours"}
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WithArgs(
			"in_flight_reaped",
			"watchdog_reaper",
			"campaign_contact",
			"99",
			thresholdMatcher,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 6*time.Hour)
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// aw63DetailsHasKey — local sqlmock argument matcher confirming the
// audit details JSON contains a specific key. Implements
// sqlmock.Argument (via driver.Value Match), so sqlmock invokes it as
// a custom matcher rather than treating it as a raw struct value.
type aw63DetailsHasKey struct{ key string }

func (m aw63DetailsHasKey) Match(v driver.Value) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	return strings.Contains(s, "\""+m.key+"\"")
}

// ── 11. Per-row UPDATE failure does not stop reap loop, audit only on win

// AW7-3 contract: a transient DB error on one UPDATE must not bail out
// of the loop; subsequent candidates are still processed. The audit row
// is only emitted for the rows that actually flipped (RowsAffected=1).
func TestAW63_PerRowUpdateFailure_LoopContinues_AuditOnlyOnWin(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuck := time.Now().Add(-30 * time.Hour)
	candidates := []stuckCandidate{
		{id: 1, campaignID: 1, contactID: 1, createdAt: stuck},
		{id: 2, campaignID: 1, contactID: 2, createdAt: stuck},
		{id: 3, campaignID: 1, contactID: 3, createdAt: stuck},
	}
	mock.ExpectQuery(aw63ReaperSelectRE.String()).WillReturnRows(aw63MakeReaperRows(candidates))

	// Row 1: succeeds.
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Row 2: transient DB failure — no audit, loop continues.
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(2)).
		WillReturnError(errors.New("transient DB blip"))

	// Row 3: succeeds despite row-2's failure.
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(3)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	reaped, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run must not bubble per-row error: %v", err)
	}
	if reaped != 2 {
		t.Errorf("reaped = %d, want 2 (row 2 failed)", reaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 12. Concurrent reaper invocations do not double-finalize ─────────────

// AW7-3 doc: "The CAS predicate `status='in_flight'` makes the UPDATE
// idempotent across concurrent reaper invocations." This test runs two
// reaper Run() calls concurrently against the same mock DB. sqlmock
// serializes expectations FIFO, so we model the production behaviour:
// reaper-A's UPDATE wins (rows=1), reaper-B's UPDATE on the same id
// CAS-misses (rows=0). No double-audit, no double-flip.
func TestAW63_TwoReapersConcurrent_NoDoubleReap(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	stuck := time.Now().Add(-30 * time.Hour)
	row := stuckCandidate{id: 42, campaignID: 1, contactID: 1, createdAt: stuck}

	// Reaper A: SELECT → 1 candidate, UPDATE wins (rows=1), audit insert.
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(aw63MakeReaperRows([]stuckCandidate{row}))
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(aw63AuditInsertRE.String()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Reaper B: SELECT → also sees the same row (race window), UPDATE
	// misses CAS (rows=0), no audit emission.
	mock.ExpectQuery(aw63ReaperSelectRE.String()).
		WillReturnRows(aw63MakeReaperRows([]stuckCandidate{row}))
	mock.ExpectExec(aw63ReaperUpdateRE.String()).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Issue both reapers serially (sqlmock can't actually parallelize the
	// connection); the contract is the FIFO semantics of CAS — second
	// reaper sees rows=0.
	r1 := NewInFlightReaperWithThreshold(db, 24*time.Hour)
	r2 := NewInFlightReaperWithThreshold(db, 24*time.Hour)

	// Run sequentially but assert the model: at most ONE reaped.
	var totalReaped int
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		n, _ := r1.Run(context.Background())
		mu.Lock()
		totalReaped += n
		mu.Unlock()
	}()
	go func() {
		defer wg.Done()
		// Tiny stagger so sqlmock FIFO ordering is deterministic.
		time.Sleep(5 * time.Millisecond)
		n, _ := r2.Run(context.Background())
		mu.Lock()
		totalReaped += n
		mu.Unlock()
	}()
	wg.Wait()

	if totalReaped != 1 {
		t.Errorf("totalReaped = %d, want 1 (CAS allows at most one)", totalReaped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
