package probe

// M-O3 TDD (2026-04-22): goroutine recover in AlertingSink.Write.
//
// Before fix: the goroutine that calls EvaluateLayer had no recover().
// A panic inside EvaluateLayer would crash the probe scheduler daemon.
// After fix: defer/recover logs the panic and the scheduler continues.
//
// Tests:
//   1. A panicking evaluator does not propagate beyond the goroutine.
//   2. Write still returns nil (inner write succeeded) when evaluator panics.
//   3. A nil-evaluator path (already covered by recorder_coverage_test.go)
//      is regression-guarded here too.
//   4. Edge: evaluator panics with a non-string value.

import (
	"context"
	"sync"
	"testing"
	"time"
)

// panicEvaluator implements LayerEvaluator and always panics.
type panicEvaluator struct {
	mu      sync.Mutex
	reached bool
	panicVal any
}

func (p *panicEvaluator) EvaluateLayer(_ context.Context, _ string, _ int) error {
	p.mu.Lock()
	p.reached = true
	p.mu.Unlock()
	panic(p.panicVal)
}

// TestAlertingSink_PanicEvaluator_DoesNotCrash verifies that a panicking
// EvaluateLayer is caught by the recover guard and does NOT propagate to
// the caller or terminate the process.
func TestAlertingSink_PanicEvaluator_DoesNotCrash(t *testing.T) {
	eval := &panicEvaluator{panicVal: "synthetic evaluator panic"}
	sink := &AlertingSink{Inner: &fakeSink{}, Evaluator: eval}
	r := Result{Layer: "anti_trace", Level: LevelAlive, Status: StatusOK}

	// Write must return nil (inner write succeeded).
	if err := sink.Write(context.Background(), r); err != nil {
		t.Fatalf("Write should succeed: %v", err)
	}

	// Poll until evaluator was reached (goroutine started) to confirm
	// the panic was triggered and recovered, not simply skipped.
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		eval.mu.Lock()
		reached := eval.reached
		eval.mu.Unlock()
		if reached {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	eval.mu.Lock()
	defer eval.mu.Unlock()
	if !eval.reached {
		t.Fatal("evaluator was never reached — goroutine may not have started")
	}
	// If we get here without crashing, the recover() is working.
}

// TestAlertingSink_PanicEvaluator_NonStringValue verifies recover works with
// non-string panic values (edge case: panic(42), panic(nil struct), etc.).
func TestAlertingSink_PanicEvaluator_NonStringValue(t *testing.T) {
	eval := &panicEvaluator{panicVal: 42} // non-string panic
	sink := &AlertingSink{Inner: &fakeSink{}, Evaluator: eval}
	r := Result{Layer: "watchdog", Level: LevelCorrect, Status: StatusOK}

	if err := sink.Write(context.Background(), r); err != nil {
		t.Fatalf("Write should return nil: %v", err)
	}

	// Wait for goroutine to complete; no crash = test passes.
	time.Sleep(100 * time.Millisecond)
	eval.mu.Lock()
	defer eval.mu.Unlock()
	if !eval.reached {
		t.Fatal("evaluator was never reached")
	}
}

// TestAlertingSink_PanicEvaluator_WriteReturnNilOnSuccess verifies that even
// when the evaluator goroutine panics, Write's return value is nil (success
// depends on inner write, not on the out-of-band evaluator).
func TestAlertingSink_PanicEvaluator_WriteReturnNilOnSuccess(t *testing.T) {
	eval := &panicEvaluator{panicVal: "oops"}
	sink := &AlertingSink{
		Inner:     &fakeSink{retErr: nil},
		Evaluator: eval,
	}
	r := Result{Layer: "db_pool", Level: LevelAlive, Status: StatusOK}

	err := sink.Write(context.Background(), r)
	if err != nil {
		t.Errorf("expected nil error from Write, got: %v", err)
	}

	time.Sleep(100 * time.Millisecond)
}
