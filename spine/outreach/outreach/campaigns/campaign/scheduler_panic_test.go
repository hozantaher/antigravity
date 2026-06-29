package campaign

import (
	"context"
	"sync"
	"testing"
)

// panickingRunner panics on RunCampaign for IDs in panicIDs.
// Other IDs return nil normally — used to verify a single panicking
// campaign doesn't abort sibling campaigns in the same tick.
type panickingRunner struct {
	mu       sync.Mutex
	calls    []int64
	panicIDs map[int64]bool
}

func (p *panickingRunner) RunCampaign(_ context.Context, id int64) error {
	p.mu.Lock()
	p.calls = append(p.calls, id)
	p.mu.Unlock()
	if p.panicIDs[id] {
		panic("simulated render nil deref")
	}
	return nil
}

// TestScheduler_RunOne_PanicRecovered verifies that a panic inside
// RunCampaign is contained — runOne returns normally and the lock is
// released so the next tick can re-attempt.
func TestScheduler_RunOne_PanicRecovered(t *testing.T) {
	runner := &panickingRunner{panicIDs: map[int64]bool{42: true}}
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: []schedulerCampaign{{ID: 42, Status: "running"}}}

	s := NewScheduler(db, runner, locker)

	// Must not panic
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("scheduler tick should recover panic, but it propagated: %v", r)
		}
	}()
	s.tick(context.Background())

	// Panic recovered means runOne returned normally → lock released.
	locker.mu.Lock()
	defer locker.mu.Unlock()
	if locker.held[42] {
		t.Error("lock should be released even after panic — defer fires before recover bubbles up")
	}
}

// TestScheduler_PanicDoesNotSkipSiblings: when one campaign panics, the
// rest in the same tick MUST still run.
func TestScheduler_PanicDoesNotSkipSiblings(t *testing.T) {
	runner := &panickingRunner{panicIDs: map[int64]bool{2: true}}
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: []schedulerCampaign{
		{ID: 1, Status: "running"},
		{ID: 2, Status: "running"}, // panics
		{ID: 3, Status: "running"},
	}}

	s := NewScheduler(db, runner, locker)
	s.tick(context.Background())

	// All three campaigns must have RunCampaign called, even though #2 panicked.
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.calls) != 3 {
		t.Errorf("got %d calls, want 3 (panic should NOT skip siblings) — calls: %v",
			len(runner.calls), runner.calls)
	}
}
