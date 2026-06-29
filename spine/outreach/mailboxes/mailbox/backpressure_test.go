package mailbox

import (
	"context"
	"errors"
	"testing"
	"time"
)

// stubStore is a scriptable in-memory Store for backpressure tests.
type stubStore struct {
	byAddress map[string]Mailbox
	getErr    error

	touchCalls     []int64
	touchErr       error
	incrementCalls []int64
	incrementResp  Mailbox // returned from IncrementBounce
	incrementErr   error
	statusCalls    []statusCall
	statusErr      error
	listResp       []Mailbox
	listErr        error
}

type statusCall struct {
	ID     int64
	Status Status
	Reason string
}

func (s *stubStore) List(_ context.Context, _ Filter) ([]Mailbox, error) {
	return s.listResp, s.listErr
}
func (s *stubStore) Get(_ context.Context, _ int64) (Mailbox, error) {
	return Mailbox{}, ErrMailboxNotFound
}
func (s *stubStore) GetByAddress(_ context.Context, addr string) (Mailbox, error) {
	if s.getErr != nil {
		return Mailbox{}, s.getErr
	}
	m, ok := s.byAddress[addr]
	if !ok {
		return Mailbox{}, ErrMailboxNotFound
	}
	return m, nil
}
func (s *stubStore) UpsertFromConfig(_ context.Context, m Mailbox) (Mailbox, error) { return m, nil }
func (s *stubStore) UpdateStatus(_ context.Context, id int64, status Status, reason string) (Mailbox, error) {
	s.statusCalls = append(s.statusCalls, statusCall{id, status, reason})
	if s.statusErr != nil {
		return Mailbox{}, s.statusErr
	}
	m := s.incrementResp
	m.Status = status
	m.StatusReason = reason
	return m, nil
}
func (s *stubStore) TouchLastSend(_ context.Context, id int64, _ time.Time) error {
	s.touchCalls = append(s.touchCalls, id)
	return s.touchErr
}
func (s *stubStore) IncrementBounce(_ context.Context, id int64) (Mailbox, error) {
	s.incrementCalls = append(s.incrementCalls, id)
	if s.incrementErr != nil {
		return Mailbox{}, s.incrementErr
	}
	return s.incrementResp, nil
}
func (s *stubStore) ResetBounce(_ context.Context, _ int64) error { return nil }
func (s *stubStore) Create(_ context.Context, m Mailbox) (Mailbox, error) { return m, nil }
func (s *stubStore) Update(_ context.Context, _ int64, m Mailbox) (Mailbox, error) {
	return m, nil
}
func (s *stubStore) Delete(_ context.Context, _ int64) error { return nil }

func mkStub() *stubStore {
	return &stubStore{
		byAddress: map[string]Mailbox{
			"jan@sender.test": {
				ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
				DisplayName: "Jan", SMTPHost: "smtp.sender.test", SMTPPort: 587,
				TZ: "Europe/Prague", Locale: "cs-CZ",
			},
		},
	}
}

func TestBackpressure_RecordSuccess_NormalisesAndTouches(t *testing.T) {
	store := mkStub()
	bp := NewBackpressure(store)

	bp.RecordSuccess(context.Background(), "  JAN@Sender.Test ", time.Now())

	if len(store.touchCalls) != 1 || store.touchCalls[0] != 1 {
		t.Errorf("expected TouchLastSend(id=1), got %v", store.touchCalls)
	}
}

func TestBackpressure_RecordSuccess_NoOpOnUnknownMailbox(t *testing.T) {
	store := mkStub()
	bp := NewBackpressure(store)

	// Address not in registry — GetByAddress returns ErrMailboxNotFound.
	// Backpressure must silently no-op (not panic, not log loudly).
	bp.RecordSuccess(context.Background(), "unknown@sender.test", time.Now())

	if len(store.touchCalls) != 0 {
		t.Errorf("unknown mailbox must not trigger TouchLastSend, got %v", store.touchCalls)
	}
}

func TestBackpressure_RecordSuccess_NilStoreIsNoOp(t *testing.T) {
	var bp *StoreBackpressure // nil receiver path
	bp.RecordSuccess(context.Background(), "jan@sender.test", time.Now())

	bp2 := NewBackpressure(nil)
	bp2.RecordSuccess(context.Background(), "jan@sender.test", time.Now())
	// No panic = pass.
}

func TestBackpressure_RecordBounce_BelowThresholdDoesNotHold(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
		ConsecutiveBounces: BackpressureThreshold - 1, // just below
	}
	bp := NewBackpressure(store)

	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550 user unknown")

	if held {
		t.Error("below threshold must not report held=true")
	}
	if len(store.statusCalls) != 0 {
		t.Errorf("below threshold must not call UpdateStatus, got %v", store.statusCalls)
	}
	if len(store.incrementCalls) != 1 {
		t.Errorf("IncrementBounce must be called exactly once, got %v", store.incrementCalls)
	}
}

func TestBackpressure_RecordBounce_AtThresholdHolds(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
		ConsecutiveBounces: BackpressureThreshold, // exactly at threshold
	}
	bp := NewBackpressure(store)

	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550 user unknown")

	if !held {
		t.Error("at threshold must report held=true")
	}
	if len(store.statusCalls) != 1 {
		t.Fatalf("expected exactly 1 UpdateStatus call, got %v", store.statusCalls)
	}
	call := store.statusCalls[0]
	if call.Status != StatusBounceHold {
		t.Errorf("expected Status=bounce_hold, got %q", call.Status)
	}
	if call.Reason == "" {
		t.Error("expected non-empty reason")
	}
}

func TestBackpressure_RecordBounce_UnknownMailboxNoOp(t *testing.T) {
	store := mkStub()
	bp := NewBackpressure(store)

	held := bp.RecordBounce(context.Background(), "unknown@sender.test", "550")

	if held {
		t.Error("unknown mailbox must not report held=true")
	}
	if len(store.incrementCalls) != 0 {
		t.Errorf("unknown mailbox must not increment, got %v", store.incrementCalls)
	}
}

func TestBackpressure_RecordBounce_PropagatesIncrementError(t *testing.T) {
	// Increment failure must NOT cause UpdateStatus to fire —
	// we must not auto-hold a mailbox based on stale counter state.
	store := mkStub()
	store.incrementErr = errors.New("db boom")
	bp := NewBackpressure(store)

	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")

	if held {
		t.Error("increment error must report held=false")
	}
	if len(store.statusCalls) != 0 {
		t.Errorf("increment error must not trigger UpdateStatus, got %v", store.statusCalls)
	}
}

func TestBackpressure_ActiveAddresses_ReturnsNormalisedSet(t *testing.T) {
	store := mkStub()
	store.listResp = []Mailbox{
		{ID: 1, FromAddress: "jan@sender.test", Status: StatusActive},
		{ID: 2, FromAddress: "OPS@sender.test", Status: StatusActive}, // not-yet-normalised
	}
	bp := NewBackpressure(store)

	set, err := bp.ActiveAddresses(context.Background())
	if err != nil {
		t.Fatalf("ActiveAddresses: %v", err)
	}
	if _, ok := set["jan@sender.test"]; !ok {
		t.Error("expected jan@sender.test in set")
	}
	if _, ok := set["ops@sender.test"]; !ok {
		t.Error("addresses must be NormaliseAddress()-keyed")
	}
}

func TestBackpressure_ActiveAddresses_NilStoreErrors(t *testing.T) {
	bp := NewBackpressure(nil)
	_, err := bp.ActiveAddresses(context.Background())
	if err == nil {
		t.Error("nil store must error instead of returning empty set (caller needs to distinguish)")
	}
}
