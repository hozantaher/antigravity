package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// Tests for the four metric helpers that were 0 % covered prior to
// this file: Counter.Add, Gauge.Value, LabeledGauge.Delete, and
// Reset. Each has a specific failure mode that the existing test
// suite did not exercise.

func TestCounter_Add_AcceptsPositive(t *testing.T) {
	c := NewCounter("test_counter_add_pos", "for test")
	before := c.Value()
	c.Add(5)
	c.Add(7)
	if got := c.Value(); got != before+12 {
		t.Errorf("Counter.Add(5)+Add(7) produced delta %d, want 12", got-before)
	}
}

func TestCounter_Add_IgnoresZero(t *testing.T) {
	c := NewCounter("test_counter_add_zero", "for test")
	before := c.Value()
	c.Add(0)
	if got := c.Value(); got != before {
		t.Errorf("Counter.Add(0) changed value by %d, should be a no-op", got-before)
	}
}

func TestCounter_Add_IgnoresNegative_Regression(t *testing.T) {
	// The `n <= 0` short-circuit is load-bearing: Prometheus counters
	// MUST be monotonic. A future refactor that drops this guard and
	// blindly does `c.v.Add(n)` would allow negative deltas, which
	// breaks the counter contract and causes rate() queries to
	// produce garbage (NaN, gaps, or negative rates interpreted as
	// counter resets).
	c := NewCounter("test_counter_add_neg", "for test")
	c.Add(100)
	baseline := c.Value()
	c.Add(-50)
	c.Add(-1)
	if got := c.Value(); got != baseline {
		t.Errorf("Counter.Add with negative args changed value from %d to %d — monotonicity broken", baseline, got)
	}
}

func TestGauge_Value_ReadsWrittenValue(t *testing.T) {
	g := NewGauge("test_gauge_value", "for test")
	g.Set(3.14)
	if got := g.Value(); got != 3.14 {
		t.Errorf("Gauge.Value after Set(3.14) = %v, want 3.14", got)
	}
	g.Set(-0.5)
	if got := g.Value(); got != -0.5 {
		t.Errorf("Gauge.Value after Set(-0.5) = %v, want -0.5", got)
	}
}

func TestLabeledGauge_Delete_RemovesSingleLabelSet(t *testing.T) {
	// The motivating use case: a per-domain circuit breaker that
	// flips to open, gets exported, recloses, and the operator wants
	// the metric row to disappear (not hang at 0) so dashboards do
	// not show stale domains forever. Delete is the API for that.
	lg := NewLabeledGauge("test_circuit_open", "per-domain circuit", "domain")
	lg.Set(1, "a.test")
	lg.Set(1, "b.test")
	lg.Set(1, "c.test")

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	before := rec.Body.String()
	for _, d := range []string{"a.test", "b.test", "c.test"} {
		if !strings.Contains(before, d) {
			t.Fatalf("expected domain %q in exposition before Delete, got:\n%s", d, before)
		}
	}

	lg.Delete("b.test")

	rec = httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	after := rec.Body.String()
	if strings.Contains(after, `domain="b.test"`) {
		t.Errorf("after Delete(b.test), exposition still contains b.test:\n%s", after)
	}
	if !strings.Contains(after, `domain="a.test"`) || !strings.Contains(after, `domain="c.test"`) {
		t.Errorf("Delete leaked — removed siblings too:\n%s", after)
	}
}

func TestLabeledGauge_Delete_IgnoresWrongArity(t *testing.T) {
	// Delete silently ignores a call with the wrong number of label
	// values (same contract as Set). Locks in the guard.
	lg := NewLabeledGauge("test_delete_arity", "for test", "a", "b")
	lg.Set(1, "x", "y")
	lg.Delete("x") // 1 arg for 2 labels — should be no-op
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(rec.Body.String(), `a="x"`) {
		t.Errorf("Delete with wrong arity deleted anyway; {x,y} should still be present")
	}
}

func TestReset_ClearsRegistryAndRestoresCleanly(t *testing.T) {
	// Reset is marked "tests only". It resizes the four global
	// registry slices to length 0. This test:
	//   1. Snapshots current registry state.
	//   2. Adds a throwaway counter.
	//   3. Calls Reset and verifies the registry is empty.
	//   4. Restores the snapshot so other tests that rely on the
	//      outreach.go globals (SendTotal, QueueDepth, …) still pass.
	//
	// Without the restore step, TestCounter_IncAndExpose and friends
	// would fail depending on test ordering.

	regMu.Lock()
	savedCounters := append([]*Counter(nil), counters...)
	savedGauges := append([]*Gauge(nil), gauges...)
	savedLabCounts := append([]*LabeledCounter(nil), labCounts...)
	savedLabGauges := append([]*LabeledGauge(nil), labGauges...)
	regMu.Unlock()

	_ = NewCounter("test_reset_throwaway", "deleted by Reset")

	regMu.RLock()
	hadCountersBefore := len(counters) > 0
	regMu.RUnlock()
	if !hadCountersBefore {
		t.Fatal("precondition: registry should have at least one counter before Reset")
	}

	Reset()

	regMu.RLock()
	cN, gN, lcN, lgN := len(counters), len(gauges), len(labCounts), len(labGauges)
	regMu.RUnlock()
	if cN != 0 || gN != 0 || lcN != 0 || lgN != 0 {
		t.Errorf("after Reset, registry lengths = (%d,%d,%d,%d), want all zero", cN, gN, lcN, lgN)
	}

	// Restore so dependent tests keep working regardless of run order.
	regMu.Lock()
	counters = savedCounters
	gauges = savedGauges
	labCounts = savedLabCounts
	labGauges = savedLabGauges
	regMu.Unlock()

	// Sanity: a known global must be exposable again after restore.
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(rec.Body.String(), "outreach_send_total") {
		t.Error("registry restore failed — SendTotal no longer exported; other tests in this package will fail depending on run order")
	}
}
