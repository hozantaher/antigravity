package mailbox

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// Extends the existing backpressure_test.go (which covers the core paths)
// with an exhaustive threshold matrix, idempotence guarantees, address
// normalisation, error-surface matrix, ReleaseHold branches, and optional
// WarmupResetter wiring.

// warmupSpy implements WarmupResetter and records calls.
type warmupSpy struct {
	pauseCalls []struct{ addr, reason string }
	resetCalls []string
	pauseErr   error
	resetErr   error
}

func (w *warmupSpy) Pause(_ context.Context, addr, reason string) error {
	w.pauseCalls = append(w.pauseCalls, struct{ addr, reason string }{addr, reason})
	return w.pauseErr
}
func (w *warmupSpy) Reset(_ context.Context, addr string) error {
	w.resetCalls = append(w.resetCalls, addr)
	return w.resetErr
}

// ─── RecordBounce threshold matrix ───────────────────────────────────

func TestBackpressure_RecordBounce_ThresholdMatrix(t *testing.T) {
	for n := 0; n <= BackpressureThreshold+3; n++ {
		t.Run(fmt.Sprintf("consecutive=%d", n), func(t *testing.T) {
			store := mkStub()
			store.incrementResp = Mailbox{
				ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
				ConsecutiveBounces: n,
			}
			bp := NewBackpressure(store)
			held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")

			wantHeld := n >= BackpressureThreshold
			if held != wantHeld {
				t.Errorf("consecutive=%d: held=%v want=%v", n, held, wantHeld)
			}
			if wantHeld && len(store.statusCalls) != 1 {
				t.Errorf("expected 1 UpdateStatus call on threshold, got %d", len(store.statusCalls))
			}
			if !wantHeld && len(store.statusCalls) != 0 {
				t.Errorf("expected 0 UpdateStatus calls below threshold, got %d", len(store.statusCalls))
			}
		})
	}
}

func TestBackpressure_RecordBounce_DoesNotHoldIfAlreadyOnHold(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, FromAddress: "jan@sender.test",
		Status:             StatusBounceHold, // already on hold
		ConsecutiveBounces: BackpressureThreshold + 3,
	}
	bp := NewBackpressure(store)
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if held {
		t.Error("already-on-hold mailbox: held should be false (no double-hold)")
	}
	if len(store.statusCalls) != 0 {
		t.Errorf("no UpdateStatus for already-on-hold, got %d", len(store.statusCalls))
	}
}

func TestBackpressure_RecordBounce_DoesNotHoldIfPaused(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, Status: StatusPaused,
		ConsecutiveBounces: BackpressureThreshold + 10,
	}
	bp := NewBackpressure(store)
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if held {
		t.Error("paused mailbox must not transition to bounce_hold")
	}
}

func TestBackpressure_RecordBounce_DoesNotHoldIfRetired(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, Status: StatusRetired,
		ConsecutiveBounces: 999,
	}
	bp := NewBackpressure(store)
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if held {
		t.Error("retired mailbox must not transition to bounce_hold")
	}
}

// ─── Address normalisation ──────────────────────────────────────────

func TestBackpressure_RecordBounce_NormalisesInput(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
		ConsecutiveBounces: 0,
	}
	bp := NewBackpressure(store)

	bp.RecordBounce(context.Background(), "  JAN@Sender.Test ", "550")

	if len(store.incrementCalls) != 1 || store.incrementCalls[0] != 1 {
		t.Errorf("expected IncrementBounce(id=1) via normalisation, got %v", store.incrementCalls)
	}
}

// ─── Error-surface matrix ───────────────────────────────────────────

func TestBackpressure_RecordSuccess_UnknownErrorLogsAndReturns(t *testing.T) {
	store := mkStub()
	store.getErr = errors.New("connection reset")
	bp := NewBackpressure(store)
	// Must not panic; must not call TouchLastSend since Get failed.
	bp.RecordSuccess(context.Background(), "jan@sender.test", time.Now())
	if len(store.touchCalls) != 0 {
		t.Errorf("Get failure must short-circuit; got touchCalls=%v", store.touchCalls)
	}
}

func TestBackpressure_RecordBounce_GetUnknownErrorIsNoOp(t *testing.T) {
	store := mkStub()
	store.getErr = errors.New("timeout")
	bp := NewBackpressure(store)
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if held {
		t.Error("Get error: held should be false")
	}
	if len(store.incrementCalls) != 0 {
		t.Errorf("Get error must short-circuit; got incrementCalls=%v", store.incrementCalls)
	}
}

func TestBackpressure_RecordBounce_UpdateStatusFailureReportsFalse(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, Status: StatusActive,
		ConsecutiveBounces: BackpressureThreshold,
	}
	store.statusErr = errors.New("db write failed")
	bp := NewBackpressure(store)
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if held {
		t.Error("UpdateStatus failure must report held=false (caller logs and continues)")
	}
}

func TestBackpressure_RecordSuccess_TouchErrorIsSwallowed(t *testing.T) {
	store := mkStub()
	store.touchErr = errors.New("db boom")
	bp := NewBackpressure(store)
	// Must not panic, must not log.Fatal. No return value to inspect.
	bp.RecordSuccess(context.Background(), "jan@sender.test", time.Now())
}

// ─── WarmupResetter integration ─────────────────────────────────────

func TestBackpressure_RecordBounce_PausesWarmupOnHold(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, Status: StatusActive,
		ConsecutiveBounces: BackpressureThreshold,
	}
	wspy := &warmupSpy{}
	bp := &StoreBackpressure{Store: store, Warmup: wspy}
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if !held {
		t.Fatal("expected hold")
	}
	if len(wspy.pauseCalls) != 1 {
		t.Fatalf("expected 1 Pause call, got %d", len(wspy.pauseCalls))
	}
	if wspy.pauseCalls[0].reason != "bounce_hold" {
		t.Errorf("Pause reason = %q, want bounce_hold", wspy.pauseCalls[0].reason)
	}
	if wspy.pauseCalls[0].addr != "jan@sender.test" {
		t.Errorf("Pause addr = %q, want jan@sender.test", wspy.pauseCalls[0].addr)
	}
}

func TestBackpressure_RecordBounce_WarmupPauseErrorIsSwallowed(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, Status: StatusActive,
		ConsecutiveBounces: BackpressureThreshold,
	}
	wspy := &warmupSpy{pauseErr: errors.New("warmup down")}
	bp := &StoreBackpressure{Store: store, Warmup: wspy}
	// Must not panic, must still report held=true because the mailbox WAS held.
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if !held {
		t.Error("held must remain true even if Warmup.Pause errors")
	}
}

func TestBackpressure_RecordBounce_NoWarmupConfiguredIsOK(t *testing.T) {
	store := mkStub()
	store.incrementResp = Mailbox{
		ID: 1, Status: StatusActive,
		ConsecutiveBounces: BackpressureThreshold,
	}
	bp := &StoreBackpressure{Store: store, Warmup: nil}
	held := bp.RecordBounce(context.Background(), "jan@sender.test", "550")
	if !held {
		t.Error("expected hold with no Warmup configured")
	}
}

// ─── ReleaseHold branches ───────────────────────────────────────────

func TestBackpressure_ReleaseHold_NilStoreIsNoOp(t *testing.T) {
	var bp *StoreBackpressure
	if err := bp.ReleaseHold(context.Background(), "x"); err != nil {
		t.Errorf("nil receiver: want nil err, got %v", err)
	}
	bp2 := NewBackpressure(nil)
	if err := bp2.ReleaseHold(context.Background(), "x"); err != nil {
		t.Errorf("nil store: want nil err, got %v", err)
	}
}

func TestBackpressure_ReleaseHold_GetErrorPropagates(t *testing.T) {
	store := mkStub()
	store.getErr = errors.New("db boom")
	bp := NewBackpressure(store)
	err := bp.ReleaseHold(context.Background(), "jan@sender.test")
	if err == nil {
		t.Error("Get error: want wrapped error, got nil")
	}
	if !errors.Is(err, store.getErr) {
		t.Errorf("error chain broken; got %v", err)
	}
}

func TestBackpressure_ReleaseHold_NotFoundPropagates(t *testing.T) {
	store := &stubStore{byAddress: map[string]Mailbox{}} // empty
	bp := NewBackpressure(store)
	err := bp.ReleaseHold(context.Background(), "nobody@sender.test")
	if err == nil {
		t.Error("unknown mailbox: want error, got nil")
	}
	if !errors.Is(err, ErrMailboxNotFound) {
		t.Errorf("want ErrMailboxNotFound in chain, got %v", err)
	}
}

func TestBackpressure_ReleaseHold_IdempotentForNonHeldMailbox(t *testing.T) {
	store := &stubStore{
		byAddress: map[string]Mailbox{
			"jan@sender.test": {ID: 1, FromAddress: "jan@sender.test", Status: StatusActive},
		},
	}
	bp := NewBackpressure(store)
	err := bp.ReleaseHold(context.Background(), "jan@sender.test")
	if err != nil {
		t.Errorf("release of already-active should no-op, got err %v", err)
	}
	if len(store.statusCalls) != 0 {
		t.Errorf("must not call UpdateStatus on already-active: %v", store.statusCalls)
	}
}

func TestBackpressure_ReleaseHold_HeldMailboxTransitionsToActive(t *testing.T) {
	store := &stubStore{
		byAddress: map[string]Mailbox{
			"jan@sender.test": {ID: 1, FromAddress: "jan@sender.test", Status: StatusBounceHold},
		},
	}
	bp := NewBackpressure(store)
	if err := bp.ReleaseHold(context.Background(), "jan@sender.test"); err != nil {
		t.Fatalf("ReleaseHold: %v", err)
	}
	if len(store.statusCalls) != 1 {
		t.Fatalf("expected 1 UpdateStatus call, got %d", len(store.statusCalls))
	}
	call := store.statusCalls[0]
	if call.Status != StatusActive {
		t.Errorf("transitioned to %q, want active", call.Status)
	}
	if call.Reason == "" {
		t.Error("ReleaseHold should stamp a reason for audit")
	}
}

func TestBackpressure_ReleaseHold_NormalisesAddress(t *testing.T) {
	store := &stubStore{
		byAddress: map[string]Mailbox{
			"jan@sender.test": {ID: 1, FromAddress: "jan@sender.test", Status: StatusBounceHold},
		},
	}
	bp := NewBackpressure(store)
	if err := bp.ReleaseHold(context.Background(), "  JAN@Sender.Test "); err != nil {
		t.Errorf("normalised lookup failed: %v", err)
	}
}

func TestBackpressure_ReleaseHold_ResetsWarmup(t *testing.T) {
	store := &stubStore{
		byAddress: map[string]Mailbox{
			"jan@sender.test": {ID: 1, FromAddress: "jan@sender.test", Status: StatusBounceHold},
		},
	}
	wspy := &warmupSpy{}
	bp := &StoreBackpressure{Store: store, Warmup: wspy}
	if err := bp.ReleaseHold(context.Background(), "jan@sender.test"); err != nil {
		t.Fatal(err)
	}
	if len(wspy.resetCalls) != 1 {
		t.Errorf("expected 1 Warmup.Reset call, got %d", len(wspy.resetCalls))
	}
	if wspy.resetCalls[0] != "jan@sender.test" {
		t.Errorf("Reset addr = %q, want normalised jan@sender.test", wspy.resetCalls[0])
	}
}

func TestBackpressure_ReleaseHold_WarmupResetErrorIsSwallowed(t *testing.T) {
	store := &stubStore{
		byAddress: map[string]Mailbox{
			"jan@sender.test": {ID: 1, FromAddress: "jan@sender.test", Status: StatusBounceHold},
		},
	}
	wspy := &warmupSpy{resetErr: errors.New("warmup down")}
	bp := &StoreBackpressure{Store: store, Warmup: wspy}
	if err := bp.ReleaseHold(context.Background(), "jan@sender.test"); err != nil {
		t.Errorf("warmup reset error must be swallowed, got %v", err)
	}
}

// ─── ActiveAddresses branches ────────────────────────────────────────

func TestBackpressure_ActiveAddresses_ListErrorPropagates(t *testing.T) {
	store := mkStub()
	store.listErr = errors.New("query failed")
	bp := NewBackpressure(store)
	_, err := bp.ActiveAddresses(context.Background())
	if err == nil {
		t.Error("list error must surface to caller")
	}
}

func TestBackpressure_ActiveAddresses_EmptyListReturnsEmptySet(t *testing.T) {
	store := mkStub()
	store.listResp = []Mailbox{}
	bp := NewBackpressure(store)
	set, err := bp.ActiveAddresses(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 0 {
		t.Errorf("empty list should produce empty set, got %d entries", len(set))
	}
}

func TestBackpressure_ActiveAddresses_Large24MailboxPool(t *testing.T) {
	store := mkStub()
	store.listResp = make([]Mailbox, 24)
	for i := range store.listResp {
		store.listResp[i] = Mailbox{
			ID:          int64(i + 1),
			FromAddress: fmt.Sprintf("m%d@sender.test", i+1),
			Status:      StatusActive,
		}
	}
	bp := NewBackpressure(store)
	set, err := bp.ActiveAddresses(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 24 {
		t.Errorf("expected 24 entries, got %d", len(set))
	}
	for i := 1; i <= 24; i++ {
		addr := fmt.Sprintf("m%d@sender.test", i)
		if _, ok := set[addr]; !ok {
			t.Errorf("missing %s from set", addr)
		}
	}
}

// ─── Interface assertions ─────────────────────────────────────────────

func TestBackpressure_ImplementsContract(t *testing.T) {
	// Guard against accidental interface drift.
	var _ Backpressure = (*StoreBackpressure)(nil)
	var _ HoldReleaser = (*StoreBackpressure)(nil)
}

// ─── Nil-receiver safety ──────────────────────────────────────────────

func TestBackpressure_NilReceiver_AllMethodsSafe(t *testing.T) {
	var bp *StoreBackpressure
	ctx := context.Background()
	// None of these should panic.
	bp.RecordSuccess(ctx, "x", time.Now())
	if got := bp.RecordBounce(ctx, "x", "reason"); got {
		t.Error("nil receiver RecordBounce: must return false")
	}
	if err := bp.ReleaseHold(ctx, "x"); err != nil {
		t.Errorf("nil receiver ReleaseHold: want nil, got %v", err)
	}
}
