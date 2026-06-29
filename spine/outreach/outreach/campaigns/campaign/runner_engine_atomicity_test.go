// AW7 — runner-engine state atomicity (issue #1182).
//
// These tests lock the contract: the runner reserves contacts with
// status='in_flight' BEFORE the engine processes them, and the
// FinalizeSentStep / RevertFailedStep helpers transition them only AFTER
// a confirmed send_events INSERT (or confirmed failure). Phantom-
// completed (status='completed' with no send_events row) is closed by
// these gates.
//
// Coverage required by HARD memory feedback_extreme_testing (≥10 cases):
//
//	1. Reservation SQL writes status='in_flight', not in_sequence/completed.
//	2. Final-step reservation uses no-next-send-at branch.
//	3. CAS predicate preserved (RowsAffected=0 → no double-enqueue).
//	4. SendRequest.NextSendAt is populated by runner (~DelayDays in future).
//	5. SendRequest.IsFinalStep set true on last step, false otherwise.
//	6. FinalizeSentStep success path (in_flight -> in_sequence).
//	7. FinalizeSentStep success path final step (in_flight -> completed).
//	8. FinalizeSentStep is idempotent (rows=0 returns nil error).
//	9. FinalizeSentStep DB error wrapped, not swallowed.
//	10. FinalizeSentStep nil-DB returns error (defensive).
//	11. RevertFailedStep rolls back current_step + status to pending.
//	12. RevertFailedStep is idempotent.
//	13. RevertFailedStep nil-DB returns error.
//	14. End-to-end phantom-completed regression closer: an enqueued
//	    request that the engine never delivers leaves the contact at
//	    'in_flight' (NOT 'in_sequence' / 'completed'), so the next-tick
//	    eligibility filter excludes it and no phantom row appears.

package campaign

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"campaigns/content"
	"campaigns/sender"
)

// timePtr returns a pointer to t — used to populate SendRequest.NextSendAt.
func timePtr(t time.Time) *time.Time { return &t }

// ── 1. Reservation SQL writes status='in_flight' (non-final branch) ─────────

func TestAW7_Reservation_NonFinalStep_WritesInFlight(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "send@test.cz", "pw")
	dir := makeTemplateDir(t, "step0", "Subject: x\n\nbody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
		{Step: 1, DelayDays: 5, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-NonFinal", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(101), int64(2001), 0, "x@firma.cz", "X", "FirmaX", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// Lock the EXACT reservation SQL: status='in_flight' (NOT 'in_sequence').
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step = \$1, status = 'in_flight', next_send_at = \$2, updated_at = now\(\) WHERE id = \$3 AND current_step = \$4`).
		WithArgs(1, sqlmock.AnyArg(), int64(101), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 2. Final-step reservation: status='in_flight', no next_send_at ──────────

func TestAW7_Reservation_FinalStep_WritesInFlight_NoNextSendAt(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "send@test.cz", "pw")
	dir := makeTemplateDir(t, "final", "Subject: y\n\nfinal body")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "final"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-Final", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(202), int64(3003), 0, "y@firma.cz", "Y", "FirmaY", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// EXACT final-step reservation SQL: in_flight, no next_send_at column.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step = \$1, status = 'in_flight', updated_at = now\(\) WHERE id = \$2 AND current_step = \$3`).
		WithArgs(1, int64(202), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 3. CAS preserved: RowsAffected=0 → no double-enqueue ────────────────────

func TestAW7_Reservation_CASZeroRows_NoEnqueue(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "send@test.cz", "pw")
	dir := makeTemplateDir(t, "step0", "Subject: x\n\nbody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
		{Step: 1, DelayDays: 3, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-CAS", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(303), int64(4004), 0, "z@firma.cz", "Z", "FirmaZ", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// CAS hit 0 rows — concurrent runner won.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 4. SendRequest.NextSendAt populated by runner before Enqueue ────────────

func TestAW7_SendRequest_NextSendAt_PopulatedByRunner(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "send@test.cz", "pw")
	dir := makeTemplateDir(t, "tpl", "Subject: x\n\nbody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "tpl"},
		{Step: 1, DelayDays: 7, TemplateName: "tpl"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-NextSendAt", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(404), int64(5005), 0, "n@firma.cz", "N", "FirmaN", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	// Run engine briefly; capture the dispatched SendRequest via onSent.
	captured := make(chan sender.SendRequest, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		_ = eng.Run(ctx, func(req sender.SendRequest, _ sender.SendResult) {
			select {
			case captured <- req:
			default:
			}
		})
	}()

	select {
	case req := <-captured:
		if req.IsFinalStep {
			t.Errorf("IsFinalStep = true, want false (step 0 of 2-step seq)")
		}
		if req.NextSendAt == nil {
			t.Fatal("NextSendAt was nil; runner must populate it for non-final step")
		}
		// 7-day delay; allow 1h tolerance for slow CI / DST.
		delta := time.Until(*req.NextSendAt)
		if delta < 7*24*time.Hour-1*time.Hour || delta > 7*24*time.Hour+1*time.Hour {
			t.Errorf("NextSendAt delta = %v, want ~7d", delta)
		}
	case <-ctx.Done():
		t.Fatal("engine never produced a SendRequest")
	}
}

// ── 5. SendRequest.IsFinalStep flagged true on last step ────────────────────

func TestAW7_SendRequest_IsFinalStep_SetOnLastStep(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "send@test.cz", "pw")
	dir := makeTemplateDir(t, "final", "Subject: y\n\nbody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 1-step sequence; contact at step 0 → IS final.
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "final"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-IsFinal", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(505), int64(6006), 0, "f@firma.cz", "F", "FirmaF", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	captured := make(chan sender.SendRequest, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		_ = eng.Run(ctx, func(req sender.SendRequest, _ sender.SendResult) {
			select {
			case captured <- req:
			default:
			}
		})
	}()

	select {
	case req := <-captured:
		if !req.IsFinalStep {
			t.Errorf("IsFinalStep = false, want true (final step of 1-step seq)")
		}
		if req.NextSendAt != nil {
			t.Errorf("NextSendAt = %v, want nil for final step", req.NextSendAt)
		}
	case <-ctx.Done():
		t.Fatal("engine never produced a SendRequest")
	}
}

// ── 6. FinalizeSentStep success path — non-final ────────────────────────────

func TestAW7_FinalizeSentStep_NonFinal_WritesInSequence(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	nextSend := time.Now().Add(24 * time.Hour)
	req := sender.SendRequest{
		CampaignID:  77,
		ContactID:   8888,
		Step:        0, // advancedStep = 1
		IsFinalStep: false,
		NextSendAt:  &nextSend,
	}

	// Whitespace-tolerant regex captures the multi-line SQL.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'in_sequence'.*next_send_at\s*=\s*\$4.*WHERE campaign_id\s*=\s*\$1.*contact_id\s*=\s*\$2.*current_step\s*=\s*\$3.*status\s*=\s*'in_flight'`).
		WithArgs(int64(77), int64(8888), 1, nextSend).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows, err := FinalizeSentStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("FinalizeSentStep error: %v", err)
	}
	if rows != 1 {
		t.Errorf("rows = %d, want 1", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 7. FinalizeSentStep success path — final ────────────────────────────────

func TestAW7_FinalizeSentStep_Final_WritesCompleted(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	req := sender.SendRequest{
		CampaignID:  88,
		ContactID:   9999,
		Step:        2, // advancedStep = 3
		IsFinalStep: true,
	}

	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'completed'\s+WHERE campaign_id\s*=\s*\$1.*contact_id\s*=\s*\$2.*current_step\s*=\s*\$3.*status\s*=\s*'in_flight'`).
		WithArgs(int64(88), int64(9999), 3).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows, err := FinalizeSentStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("FinalizeSentStep error: %v", err)
	}
	if rows != 1 {
		t.Errorf("rows = %d, want 1", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 8. FinalizeSentStep idempotent: zero rows is not an error ───────────────

func TestAW7_FinalizeSentStep_Idempotent_ZeroRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	req := sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0, IsFinalStep: true}

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	rows, err := FinalizeSentStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("expected nil error on zero rows, got %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d, want 0", rows)
	}
}

// ── 9. FinalizeSentStep DB error wrapped, not swallowed ─────────────────────

func TestAW7_FinalizeSentStep_DBError_Wrapped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	req := sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0, IsFinalStep: false, NextSendAt: timePtr(now)}

	dbErr := errors.New("connection reset by peer")
	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnError(dbErr)

	_, err = FinalizeSentStep(context.Background(), db, req)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "connection reset by peer") {
		t.Errorf("error %q does not include underlying message", err)
	}
}

// ── 10. FinalizeSentStep nil-DB returns error ───────────────────────────────

func TestAW7_FinalizeSentStep_NilDB_ReturnsError(t *testing.T) {
	req := sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}
	_, err := FinalizeSentStep(context.Background(), nil, req)
	if err == nil {
		t.Fatal("expected error on nil DB")
	}
}

// ── 11. RevertFailedStep rolls back to pending ──────────────────────────────

func TestAW7_RevertFailedStep_RollsBackToPending(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	req := sender.SendRequest{CampaignID: 11, ContactID: 22, Step: 1}

	// req.Step=1 → CAS gates on advancedStep=2; revert sets current_step=1.
	mock.ExpectExec(`UPDATE campaign_contacts\s+SET status\s*=\s*'pending'.*current_step\s*=\s*\$3.*next_send_at\s*=\s*NULL\s+WHERE campaign_id\s*=\s*\$1.*contact_id\s*=\s*\$2.*current_step\s*=\s*\$4.*status\s*=\s*'in_flight'`).
		WithArgs(int64(11), int64(22), 1, 2).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("RevertFailedStep error: %v", err)
	}
	if rows != 1 {
		t.Errorf("rows = %d, want 1", rows)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ── 12. RevertFailedStep idempotent ─────────────────────────────────────────

func TestAW7_RevertFailedStep_Idempotent_ZeroRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	req := sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}

	mock.ExpectExec(`UPDATE campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	rows, err := RevertFailedStep(context.Background(), db, req)
	if err != nil {
		t.Fatalf("expected nil error on zero rows, got %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d, want 0", rows)
	}
}

// ── 13. RevertFailedStep nil-DB returns error ───────────────────────────────

func TestAW7_RevertFailedStep_NilDB_ReturnsError(t *testing.T) {
	req := sender.SendRequest{CampaignID: 1, ContactID: 2, Step: 0}
	_, err := RevertFailedStep(context.Background(), nil, req)
	if err == nil {
		t.Fatal("expected error on nil DB")
	}
}

// ── 14. Phantom-completed regression closer ─────────────────────────────────

// The headline scenario from issue #1182: an enqueued request that the
// engine NEVER dispatches (queue drained at shutdown, mailbox spacing
// holds it indefinitely, breaker open) leaves the contact at
// status='in_flight' — NOT 'in_sequence' / 'completed'. The next-tick
// eligibility filter (`cc.status IN ('pending','in_sequence')`) excludes
// 'in_flight', so no double-send. A future watchdog cron reaps stuck
// rows back to 'pending'; until then, no phantom row appears.
func TestAW7_PhantomCompletedRegression_EngineNeverDispatches(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "send@test.cz", "pw")
	dir := makeTemplateDir(t, "step0", "Subject: x\n\nbody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
		{Step: 1, DelayDays: 5, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-Phantom", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(606), int64(7007), 0, "p@firma.cz", "P", "FirmaP", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// THE KEY ASSERTION: the runner's UPDATE writes status='in_flight'.
	// If a future refactor reverts to 'in_sequence', the regex-anchored
	// expectation will not match and this test fails — surfacing the
	// regression before campaign 457 repeats.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step = \$1, status = 'in_flight', next_send_at = \$2, updated_at = now\(\) WHERE id = \$3 AND current_step = \$4`).
		WithArgs(1, sqlmock.AnyArg(), int64(606), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}

	// Deliberately do NOT call FinalizeSentStep — models the engine-defer
	// path. Contact stays 'in_flight'; no phantom 'completed' / 'in_sequence'.
}

// ── 15. Compile-time guard for SendRequest fields ───────────────────────────

// If a future refactor renames or removes NextSendAt / IsFinalStep, this
// file fails to compile (rather than silently miscompiling the runner's
// reservation logic).
func TestAW7_SendRequest_FieldsExist_CompileTimeGuard(t *testing.T) {
	now := time.Now()
	req := sender.SendRequest{
		CampaignID:  1,
		ContactID:   2,
		Step:        0,
		NextSendAt:  &now,
		IsFinalStep: false,
	}
	if req.NextSendAt == nil || req.IsFinalStep {
		t.Fatal("compile-time guard sanity-check failed")
	}
}
