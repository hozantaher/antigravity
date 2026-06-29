package watchdog

// circuit_breaker_branches_test.go — covers the error-path branches of
// runCircuitBreaker that were uncovered (line 143 at 64 %):
//
//   - GetState returns error → return false, false (lines 148-151)
//   - TripCircuit returns error → return false, false (lines 156-159)
//   - UpdateStatus after trip returns error → log and continue (line 160-162)
//   - CloseCircuit returns error → return false, false (lines 174-177)
//   - UpdateStatus after close returns error → log and continue (lines 181-183)
//   - CircuitNone branch → return false, false (line 194)
//   - Circuit nil → no-op (already covered in daemon_gaps_test.go but
//     we include a parallel test here for completeness in this file)
//
// PGCircuitBreakerStore error paths (GetState/TripCircuit/CloseCircuit with
// a failing DB) are also added here (lines 101, 118, 132).

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"mailboxes/mailbox"
)

// ─── error-returning fakes ────────────────────────────────────────────────────

// errCircuitStore wraps fakeCircuitStore and lets individual methods fail.
type errCircuitStore struct {
	inner         *fakeCircuitStore
	getStateErr   error
	tripErr       error
	closeErr      error
}

func (s *errCircuitStore) GetState(ctx context.Context, id int64) (CircuitBreakerState, error) {
	if s.getStateErr != nil {
		return CircuitBreakerState{}, s.getStateErr
	}
	return s.inner.GetState(ctx, id)
}

func (s *errCircuitStore) TripCircuit(ctx context.Context, id int64, at time.Time) error {
	if s.tripErr != nil {
		return s.tripErr
	}
	return s.inner.TripCircuit(ctx, id, at)
}

func (s *errCircuitStore) CloseCircuit(ctx context.Context, id int64) error {
	if s.closeErr != nil {
		return s.closeErr
	}
	return s.inner.CloseCircuit(ctx, id)
}

// errStore wraps fakeStore and makes UpdateStatus fail on demand.
type errStore struct {
	fakeStore
	mu               sync.Mutex
	updateStatusErr  error
}

func (s *errStore) UpdateStatus(ctx context.Context, id int64, st mailbox.Status, reason string) (mailbox.Mailbox, error) {
	s.mu.Lock()
	err := s.updateStatusErr
	s.mu.Unlock()
	if err != nil {
		return mailbox.Mailbox{}, err
	}
	return s.fakeStore.UpdateStatus(ctx, id, st, reason)
}

// ─── runCircuitBreaker: GetState error ────────────────────────────────────────

// TestRunCircuitBreaker_GetStateError verifies that a GetState failure returns
// (false, false) without panicking (lines 148-151).
func TestRunCircuitBreaker_GetStateError(t *testing.T) {
	cs := &errCircuitStore{
		inner:       newFakeCircuitStore(),
		getStateErr: errors.New("db: connection reset"),
	}
	d := NewDaemon(DaemonConfig{
		Store:  &fakeStore{rows: []mailbox.Mailbox{{ID: 1, Status: mailbox.StatusActive}}},
		Events: &fakeEventSink{},
		Circuit: cs,
	})
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{ID: 1}, 10)
	if tripped || closed {
		t.Error("GetState error must return (false, false)")
	}
}

// ─── runCircuitBreaker: TripCircuit error ─────────────────────────────────────

// TestRunCircuitBreaker_TripCircuitError verifies that a TripCircuit failure
// returns (false, false) without modifying mailbox status (lines 156-159).
func TestRunCircuitBreaker_TripCircuitError(t *testing.T) {
	cs := &errCircuitStore{
		inner:   newFakeCircuitStore(),
		tripErr: errors.New("db: deadlock"),
	}
	store := &fakeStore{rows: []mailbox.Mailbox{{ID: 1, Status: mailbox.StatusActive}}}
	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     &fakeEventSink{},
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5},
	})
	// failsInWindow >= threshold → wants to trip, but TripCircuit fails.
	// Mailbox is active so the trip path is actually reached (paused mailboxes
	// never trip — see EvaluateCircuit/runCircuitBreaker status guard).
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{ID: 1, Status: mailbox.StatusActive}, 5)
	if tripped || closed {
		t.Error("TripCircuit error must return (false, false)")
	}
	// Mailbox status must not have changed.
	if store.rows[0].Status != mailbox.StatusActive {
		t.Error("mailbox status should remain active when trip fails")
	}
}

// ─── runCircuitBreaker: UpdateStatus error after trip ─────────────────────────

// TestRunCircuitBreaker_UpdateStatusAfterTripError verifies that a failure in
// UpdateStatus (setting mailbox to paused) after a successful TripCircuit is
// only logged, not surfaced — tripped=true is still returned (line 160-162).
func TestRunCircuitBreaker_UpdateStatusAfterTripError(t *testing.T) {
	cs := newFakeCircuitStore()
	store := &errStore{
		fakeStore:       fakeStore{rows: []mailbox.Mailbox{{ID: 3, Status: mailbox.StatusActive}}},
		updateStatusErr: errors.New("db: table locked"),
	}
	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     &fakeEventSink{},
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5},
	})
	// Trip succeeds (circuit store), but UpdateStatus fails (errStore).
	// Mailbox is active so the trip path is reached.
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{ID: 3, Status: mailbox.StatusActive}, 5)
	if !tripped {
		t.Error("trip should be reported even when UpdateStatus fails")
	}
	if closed {
		t.Error("should not be closed when tripped")
	}
}

// ─── runCircuitBreaker: paused mailbox must not trip ──────────────────────────

// TestRunCircuitBreaker_SkipsTripForPausedMailbox verifies that a paused
// mailbox with auth-fails at/over the trip threshold is NOT tripped. A paused
// mailbox isn't sending, so its recent auth-fails are stale; tripping it would
// overwrite the operator's status_reason with "circuit_breaker:..." and let the
// auto-close 15 min later flip it back to active — reversing the pause. The
// circuit store stays untouched and (false, false) is returned.
func TestRunCircuitBreaker_SkipsTripForPausedMailbox(t *testing.T) {
	cs := newFakeCircuitStore()
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 1, Status: mailbox.StatusPaused, StatusReason: "operator_paused",
	}}}
	events := &fakeEventSink{}
	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, Circuit: cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5},
	})
	// 5 fails >= threshold would trip an active mailbox; this one is paused.
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{
		ID: 1, Status: mailbox.StatusPaused, StatusReason: "operator_paused",
	}, 5)
	if tripped || closed {
		t.Errorf("paused mailbox must not trip or close, got tripped=%v closed=%v", tripped, closed)
	}
	state, _ := cs.GetState(context.Background(), 1)
	if state.CircuitOpenedAt != nil {
		t.Error("paused mailbox should not have its circuit opened")
	}
	if state.CircuitTripCount != 0 {
		t.Errorf("trip count should stay 0, got %d", state.CircuitTripCount)
	}
	if store.rows[0].StatusReason != "operator_paused" {
		t.Errorf("operator pause reason must be preserved, got %q", store.rows[0].StatusReason)
	}
	if len(events.events) != 0 {
		t.Errorf("no circuit event should be recorded for a skipped paused mailbox, got %d", len(events.events))
	}
}

// ─── runCircuitBreaker: CloseCircuit error ────────────────────────────────────

// TestRunCircuitBreaker_CloseCircuitError verifies that a CloseCircuit failure
// returns (false, false) (lines 174-177).
func TestRunCircuitBreaker_CloseCircuitError(t *testing.T) {
	cs := &errCircuitStore{
		inner:    newFakeCircuitStore(),
		closeErr: errors.New("db: timeout"),
	}
	// Pre-seed open state so EvaluateCircuit returns CircuitClose.
	openedAt := time.Now().Add(-30 * time.Minute)
	cs.inner.states[5] = CircuitBreakerState{MailboxID: 5, CircuitOpenedAt: &openedAt}

	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 5, Status: mailbox.StatusPaused, StatusReason: "circuit_breaker:reason",
	}}}
	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     &fakeEventSink{},
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{PauseDuration: 15 * time.Minute},
	})
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{
		ID: 5, Status: mailbox.StatusPaused, StatusReason: "circuit_breaker:reason",
	}, 0)
	if tripped || closed {
		t.Error("CloseCircuit error must return (false, false)")
	}
}

// ─── runCircuitBreaker: UpdateStatus error after close ────────────────────────

// TestRunCircuitBreaker_UpdateStatusAfterCloseError verifies that a failure in
// UpdateStatus (resuming to active) after a successful CloseCircuit is only
// logged — closed=true is still returned (lines 181-183).
func TestRunCircuitBreaker_UpdateStatusAfterCloseError(t *testing.T) {
	cs := newFakeCircuitStore()
	// Pre-seed open state.
	openedAt := time.Now().Add(-30 * time.Minute)
	cs.states[7] = CircuitBreakerState{MailboxID: 7, CircuitOpenedAt: &openedAt}

	store := &errStore{
		fakeStore: fakeStore{rows: []mailbox.Mailbox{{
			ID: 7, Status: mailbox.StatusPaused, StatusReason: "circuit_breaker:spike",
		}}},
		updateStatusErr: errors.New("db: table locked"),
	}
	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     &fakeEventSink{},
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{PauseDuration: 15 * time.Minute},
	})
	_, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{
		ID: 7, Status: mailbox.StatusPaused, StatusReason: "circuit_breaker:spike",
	}, 0)
	if !closed {
		t.Error("close should be reported even when UpdateStatus fails")
	}
}

// ─── runCircuitBreaker: CircuitNone (no action) ───────────────────────────────

// TestRunCircuitBreaker_CircuitNone verifies that when EvaluateCircuit returns
// CircuitNone (circuit closed, fails below threshold), runCircuitBreaker
// returns (false, false) (line 194).
func TestRunCircuitBreaker_CircuitNone(t *testing.T) {
	cs := newFakeCircuitStore()
	// Circuit state: closed, fails well below threshold.
	cs.states[9] = CircuitBreakerState{MailboxID: 9, CircuitOpenedAt: nil}

	store := &fakeStore{rows: []mailbox.Mailbox{{ID: 9, Status: mailbox.StatusActive}}}
	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     &fakeEventSink{},
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5},
	})
	// 2 fails < 5 threshold → CircuitNone
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{ID: 9}, 2)
	if tripped || closed {
		t.Errorf("CircuitNone must return (false, false), got tripped=%v closed=%v", tripped, closed)
	}
}

// ─── runCircuitBreaker: close but mailbox not paused-by-circuit ───────────────

// TestRunCircuitBreaker_CloseSkipsResumeForOperatorPause verifies that when
// the circuit closes but the mailbox status reason is NOT "circuit_breaker:",
// UpdateStatus is NOT called (operator-paused mailbox must stay paused).
func TestRunCircuitBreaker_CloseSkipsResumeForOperatorPause(t *testing.T) {
	cs := newFakeCircuitStore()
	openedAt := time.Now().Add(-30 * time.Minute)
	cs.states[11] = CircuitBreakerState{MailboxID: 11, CircuitOpenedAt: &openedAt}

	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 11, Status: mailbox.StatusPaused, StatusReason: "operator_paused",
	}}}
	events := &fakeEventSink{}
	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     events,
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{PauseDuration: 15 * time.Minute},
	})
	_, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{
		ID: 11, Status: mailbox.StatusPaused, StatusReason: "operator_paused",
	}, 0)
	if !closed {
		t.Error("circuit should be reported as closed")
	}
	// The mailbox must not have been resumed — operator pause takes precedence.
	if store.rows[0].Status != mailbox.StatusPaused {
		t.Error("operator-paused mailbox must not be resumed by circuit close")
	}
}

// ─── PGCircuitBreakerStore error paths ───────────────────────────────────────

// TestPGCBStore_GetState_QueryError covers the Scan-error branch (line 101-103).
func TestPGCBStore_GetState_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT circuit_opened_at`).
		WillReturnError(errors.New("db: connection reset"))

	s := &PGCircuitBreakerStore{DB: db}
	_, err = s.GetState(context.Background(), 1)
	if err == nil {
		t.Fatal("expected error from GetState when query fails")
	}
}

// TestPGCBStore_TripCircuit_ExecError covers the Exec-error branch (lines 118-120).
func TestPGCBStore_TripCircuit_ExecError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(errors.New("db: deadlock"))

	s := &PGCircuitBreakerStore{DB: db}
	err = s.TripCircuit(context.Background(), 42, time.Now())
	if err == nil {
		t.Fatal("expected error from TripCircuit when exec fails")
	}
}

// TestPGCBStore_CloseCircuit_ExecError covers the Exec-error branch (lines 132-134).
func TestPGCBStore_CloseCircuit_ExecError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(errors.New("db: timeout"))

	s := &PGCircuitBreakerStore{DB: db}
	err = s.CloseCircuit(context.Background(), 42)
	if err == nil {
		t.Fatal("expected error from CloseCircuit when exec fails")
	}
}
