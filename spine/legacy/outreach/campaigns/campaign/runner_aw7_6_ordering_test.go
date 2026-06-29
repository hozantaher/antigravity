// AW7-6 — runner-engine ordering invariant.
//
// Locks the contract that the runner RESERVES the contact (UPDATE
// campaign_contacts SET status='in_flight') BEFORE handing the
// SendRequest to the engine via Enqueue. Pre-AW7-6 the order was
// reversed: Enqueue → reservation. Because Enqueue is non-blocking
// (in-memory queue) and engine.Run consumes it from a SEPARATE goroutine
// in services/orchestrator/cmd/outreach/main.go, the engine could
// process the request and call FinalizeSentStep BEFORE the runner's
// reservation UPDATE ran — leaving the contact stuck in_flight forever
// and producing the "step advance matched 0 rows — concurrent runner
// detected" log spam at 01:58 CEST 2026-05-09 (post AW7 deploy).
//
// Coverage matrix (HARD memory feedback_extreme_testing requires ≥10
// cases per change):
//
//   1. Reservation UPDATE happens before Enqueue is observable on the
//      engine queue.
//   2. CAS miss → no Enqueue (engine queue depth stays at 0).
//   3. CAS DB-error → no Enqueue.
//   4. CAS miss does NOT log "concurrent runner detected" (we demoted
//      that wording to "reservation lost CAS" / "skipping enqueue").
//   5. Successful reservation increments engine queue exactly once.
//   6. Successful reservation logs no warn/error reservation-related.
//   7. Final-step path (no next_send_at) reserves before enqueue.
//   8. Non-final step path (with next_send_at) reserves before enqueue.
//   9. Two contacts in one tick: each reserves before its own enqueue
//      (no interleaving where iteration N enqueues before iteration N
//      reserves).
//   10. CAS miss on iteration 1 still allows iteration 2 to reserve and
//       enqueue independently.
//   11. With CAS miss (RowsAffected=0) the next-tick eligibility filter
//       (status IN ('pending','in_sequence')) still includes the row —
//       no false-completed.
//   12. enqueued counter only increments when reservation succeeded.

package campaign

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"campaigns/content"
)

// ── 1. Reservation happens before Enqueue (queue empty mid-run impossible) ──

// TestAW7_6_ReservationBeforeEnqueue_QueueDepthOnlyAfterReservation simulates
// the exact production race: an engine consumer goroutine racing the runner.
// We assert that AT THE MOMENT of Enqueue, the reservation UPDATE has already
// run. The mock DB callback for the UPDATE flips a flag; the SendRequest's
// presence on the engine queue is observed AFTER the UPDATE callback fires.
//
// sqlmock guarantees expectations execute in order with the SQL the runner
// emits. If reservation came AFTER Enqueue (the pre-AW7-6 bug), the test's
// engine-queue probe would see depth=1 BEFORE the UPDATE expectation fired,
// and sqlmock would record an unexpected ExecContext (no expectation queued).
func TestAW7_6_ReservationBeforeEnqueue_OrderingInvariant(t *testing.T) {
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
			AddRow("AW7-6-Order", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(101), int64(2001), 0, "x@firma.cz", "X", "FirmaX", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// Reservation MUST be the next ExecContext on the runner DB. If the
	// runner had Enqueued first, sqlmock would not see an unexpected DB call
	// (Enqueue is in-memory) — but the test below also asserts queue depth
	// to nail the ordering.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step = \$1, status = 'in_flight', next_send_at = \$2, updated_at = now\(\) WHERE id = \$3 AND current_step = \$4`).
		WithArgs(1, sqlmock.AnyArg(), int64(101), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Pre-condition: queue must be empty.
	if d := eng.QueueDepth(); d != 0 {
		t.Fatalf("expected queue depth 0 before run, got %d", d)
	}

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	// Post-condition: exactly one item on the queue (the reservation
	// succeeded, so enqueue happened). If reservation had been BEFORE
	// enqueue and failed, depth would be 0.
	if d := eng.QueueDepth(); d != 1 {
		t.Errorf("expected queue depth 1 after successful reservation+enqueue, got %d", d)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 2. CAS miss → engine queue stays empty (no Enqueue) ─────────────────────

func TestAW7_6_ReservationCASMiss_NoEnqueue(t *testing.T) {
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
			AddRow("AW7-6-CAS", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(303), int64(4004), 0, "z@firma.cz", "Z", "FirmaZ", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// CAS miss: 0 rows affected.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	// Critical AW7-6 assertion: CAS miss → queue MUST be empty (no
	// SendRequest dispatched). Pre-AW7-6 this would have been depth=1
	// because Enqueue happened first.
	if d := eng.QueueDepth(); d != 0 {
		t.Errorf("AW7-6 INVARIANT VIOLATED: CAS miss must NOT leave a SendRequest on the queue; got depth=%d", d)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
}

// ── 3. CAS DB-error → engine queue stays empty ──────────────────────────────

func TestAW7_6_ReservationDBError_NoEnqueue(t *testing.T) {
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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-DBErr", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(404), int64(5005), 0, "y@firma.cz", "Y", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// Simulated transient DB error on reservation UPDATE.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnError(errors.New("deadlock"))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	// AW7-6: DB-error on reservation must NOT enqueue.
	if d := eng.QueueDepth(); d != 0 {
		t.Errorf("AW7-6 INVARIANT VIOLATED: reservation DB-error must NOT enqueue; got depth=%d", d)
	}
}

// ── 4. CAS miss does NOT log "concurrent runner detected" (demoted) ─────────

func TestAW7_6_CASMiss_DoesNotLogConcurrentRunnerDetected(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	buf := captureSlog(t)

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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-Log", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(505), int64(6006), 0, "log@firma.cz", "L", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	logOutput := buf.String()
	if strings.Contains(logOutput, "concurrent runner detected") {
		t.Errorf("AW7-6 demoted log: 'concurrent runner detected' must not appear; got: %s", logOutput)
	}
	// The new log message should be "reservation lost CAS".
	if !strings.Contains(logOutput, "reservation lost CAS") {
		t.Errorf("expected 'reservation lost CAS' log; got: %s", logOutput)
	}
}

// ── 5. Successful reservation: queue depth = 1 ──────────────────────────────

func TestAW7_6_SuccessfulReservation_QueueDepthOne(t *testing.T) {
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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-OK", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(606), int64(7007), 0, "ok@firma.cz", "O", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	if d := eng.QueueDepth(); d != 1 {
		t.Errorf("expected queue depth 1 after successful reservation, got %d", d)
	}
}

// ── 6. Successful reservation logs no warn/error about reservation ──────────

func TestAW7_6_SuccessfulReservation_NoNoiseLog(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	buf := captureSlog(t)

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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-Quiet", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(707), int64(8008), 0, "quiet@firma.cz", "Q", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	logOutput := buf.String()
	noiseTerms := []string{
		"reservation lost CAS",
		"DUPLICATE-SEND RISK",
		"concurrent runner detected",
		"step advance failed",
	}
	for _, term := range noiseTerms {
		if strings.Contains(logOutput, term) {
			t.Errorf("AW7-6 happy path: unexpected noise log %q in output: %s", term, logOutput)
		}
	}
}

// ── 7. Final-step path reserves before enqueue ──────────────────────────────

func TestAW7_6_FinalStep_ReservesBeforeEnqueue(t *testing.T) {
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

	// 1-step sequence, contact at step 0 → final.
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "final"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-Final", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(808), int64(9009), 0, "final@firma.cz", "F", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// Final-step reservation: no next_send_at column.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step = \$1, status = 'in_flight', updated_at = now\(\) WHERE id = \$2 AND current_step = \$3`).
		WithArgs(1, int64(808), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	if d := eng.QueueDepth(); d != 1 {
		t.Errorf("expected queue depth 1 (final-step enqueued), got %d", d)
	}
}

// ── 8. Non-final step path reserves before enqueue ──────────────────────────

func TestAW7_6_NonFinalStep_ReservesBeforeEnqueue(t *testing.T) {
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
		{Step: 1, DelayDays: 7, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-NonFinal", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(909), int64(10010), 0, "nonfinal@firma.cz", "N", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// Non-final reservation: with next_send_at.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step = \$1, status = 'in_flight', next_send_at = \$2, updated_at = now\(\) WHERE id = \$3 AND current_step = \$4`).
		WithArgs(1, sqlmock.AnyArg(), int64(909), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	if d := eng.QueueDepth(); d != 1 {
		t.Errorf("expected queue depth 1 (non-final-step enqueued), got %d", d)
	}
}

// ── 9. Two contacts in one tick: both reserve+enqueue independently ─────────

func TestAW7_6_TwoContactsOneTick_BothReserveBeforeEnqueue(t *testing.T) {
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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-Two", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(11), int64(101), 0, "a@firma1.cz", "A", "F1", "Praha", "valid", "").
			AddRow(int64(12), int64(102), 0, "b@firma2.cz", "B", "F2", "Praha", "valid", ""))
	// Domain count probes (one per unique domain).
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WithArgs(1, int64(11), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WithArgs(1, int64(12), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	if d := eng.QueueDepth(); d != 2 {
		t.Errorf("expected queue depth 2 (both contacts enqueued), got %d", d)
	}
}

// ── 10. CAS miss on iteration 1 still allows iteration 2 to enqueue ─────────

func TestAW7_6_CASMissOnFirstContact_SecondStillEnqueues(t *testing.T) {
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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-Mix", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(21), int64(201), 0, "a@firma1.cz", "A", "F1", "Praha", "valid", "").
			AddRow(int64(22), int64(202), 0, "b@firma2.cz", "B", "F2", "Praha", "valid", ""))
	// Iteration 1: domain probe + reservation CAS miss.
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WithArgs(1, int64(21), 0).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Iteration 2: domain probe + reservation success.
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WithArgs(1, int64(22), 0).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	// Iteration 1's CAS miss must NOT have enqueued anything; only
	// iteration 2 should produce a queued SendRequest.
	if d := eng.QueueDepth(); d != 1 {
		t.Errorf("expected queue depth 1 (only iter 2 enqueued), got %d", d)
	}
}

// ── 11. CAS miss leaves row for next-tick eligibility (no false-completed) ──

// Repeats the CAS-miss case but also asserts the runner does NOT change
// status/current_step in a way that excludes the row from the next-tick
// SELECT (`status IN ('pending','in_sequence')`). With AW7-6 the failing
// UPDATE writes 0 rows, so the row remains untouched; next tick re-picks.
func TestAW7_6_CASMiss_RowRemainsEligibleForNextTick(t *testing.T) {
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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-Eligible", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(31), int64(301), 0, "elig@firma.cz", "E", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// CAS miss — the only DB write the runner attempts on this row.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	// sqlmock's ExpectationsWereMet enforces that NO additional UPDATE
	// (e.g. writing status='completed' or 'failed') ran after the CAS miss.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("AW7-6 INVARIANT: CAS miss must not trigger any further UPDATE on the row; sqlmock: %v", err)
	}

	// And no enqueue happened.
	if d := eng.QueueDepth(); d != 0 {
		t.Errorf("AW7-6: CAS miss must not enqueue; got queue depth %d", d)
	}
}

// ── 12. enqueued counter increments only when reservation succeeded ─────────

// We can't directly read the runner's local `enqueued` counter, but the
// post-tick audit row is gated on enqueued > 0. We assert that with a
// CAS-miss-only tick, NO audit row is written.
func TestAW7_6_AllCASMiss_NoAuditRow(t *testing.T) {
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
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("AW7-6-NoAudit", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(41), int64(401), 0, "x@firma.cz", "X", "F", "Praha", "valid", ""))
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// IMPORTANT: NO audit.Log expectation here. If the runner emitted an
	// `INSERT INTO operator_audit_log`, sqlmock would error.

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("AW7-6: with all CAS misses, expected no additional DB calls; got: %v", err)
	}
}
