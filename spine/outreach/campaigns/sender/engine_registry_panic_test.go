package sender

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestGoRegistryCall_RecoversPanic locks the contract that a panicking
// registry call does not crash the engine. Without recover, a panic
// inside Record{Success,Bounce} (e.g. nil deref on a malformed mailbox
// row, schema drift after a migration) would terminate the goroutine
// without surfacing — bounce counters would silently stop updating
// while the send loop kept running.
func TestGoRegistryCall_RecoversPanic(t *testing.T) {
	var done sync.WaitGroup
	done.Add(1)
	var ran atomic.Bool

	goRegistryCall("RecordSuccess", "a@t.cz", func() {
		defer done.Done()
		ran.Store(true)
		panic("simulated registry panic")
	})

	// If the panic propagates, the test process crashes and we never get
	// here. WaitGroup.Done in the deferred call confirms the goroutine
	// ran past the panic point. A timeout guards against the goroutine
	// hanging on some other failure mode.
	wait := make(chan struct{})
	go func() { done.Wait(); close(wait) }()
	select {
	case <-wait:
	case <-time.After(2 * time.Second):
		t.Fatal("goroutine did not return — recover may not be wrapping the call")
	}
	if !ran.Load() {
		t.Error("goroutine body never ran")
	}
}

// TestGoRegistryCall_RunsNormalPath verifies the helper does not interfere
// with the no-panic case. Catches a refactor that accidentally swallows
// the function call entirely (e.g. wrong order of defer/fn).
func TestGoRegistryCall_RunsNormalPath(t *testing.T) {
	done := make(chan struct{})

	goRegistryCall("RecordBounce", "b@t.cz", func() {
		close(done)
	})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("normal-path call never executed")
	}
}

// TestGoRegistryCall_MultipleConcurrent — the engine fires N
// Record{Success,Bounce} goroutines per send burst. Verify they all run
// and panic-recovery is per-goroutine (a panic in one does not block
// others).
func TestGoRegistryCall_MultipleConcurrent(t *testing.T) {
	const N = 50
	var done sync.WaitGroup
	done.Add(N)
	var success atomic.Int32
	var paniced atomic.Int32

	for i := 0; i < N; i++ {
		i := i
		goRegistryCall("RecordTest", "x@t.cz", func() {
			defer done.Done()
			if i%3 == 0 {
				paniced.Add(1)
				panic("simulated")
			}
			success.Add(1)
		})
	}

	wait := make(chan struct{})
	go func() { done.Wait(); close(wait) }()
	select {
	case <-wait:
	case <-time.After(5 * time.Second):
		t.Fatal("not all goroutines completed within timeout")
	}

	if int(success.Load()+paniced.Load()) != N {
		t.Errorf("expected %d goroutines to run; got success=%d panic=%d",
			N, success.Load(), paniced.Load())
	}
}
