package alert

import (
	"context"
	"testing"
)

// ChaosContract verifies the alert-engine invariants that the S8 SLO
// requires to hold. These are pure logic tests (nil DB → short-circuit)
// combined with threshold boundary assertions; they catch regressions in
// the escalation policy without needing a live database.

// Rule: L2 fires immediately on first err.
func TestChaos_L2_AlertsOnFirstErr(t *testing.T) {
	if l2AlertThreshold != 1 {
		t.Fatalf("SLO breach: L2 alert threshold changed to %d, must be 1 (immediate)", l2AlertThreshold)
	}
}

// Rule: L3 requires at least 3 consecutive errors before alerting.
func TestChaos_L3_AlertsAfterThreeConsecutiveErr(t *testing.T) {
	if l3AlertThreshold < 3 {
		t.Fatalf("SLO breach: L3 threshold %d < 3 — too sensitive, operators will ignore alerts", l3AlertThreshold)
	}
	if l3AlertThreshold > 5 {
		t.Fatalf("SLO breach: L3 threshold %d > 5 — too slow to fire on real failures", l3AlertThreshold)
	}
}

// Rule: auto-resolve after resolveAfterOK consecutive green results.
func TestChaos_AutoResolve_AfterConsecutiveOK(t *testing.T) {
	if resolveAfterOK < 2 {
		t.Fatalf("SLO breach: resolveAfterOK %d < 2 — single flaky ok could resolve a real alert", resolveAfterOK)
	}
	if resolveAfterOK > 5 {
		t.Fatalf("SLO breach: resolveAfterOK %d > 5 — recovery too slow after real fix", resolveAfterOK)
	}
}

// Rule: escalation to critical must happen within a bounded window.
func TestChaos_EscalationWindow_BoundedUnder4h(t *testing.T) {
	if escalateToCritical.Hours() > 4 {
		t.Fatalf("SLO breach: escalateToCritical %.1fh > 4h — critical signal arrives too late for on-call", escalateToCritical.Hours())
	}
	if escalateToCritical.Hours() < 0.5 {
		t.Fatalf("SLO breach: escalateToCritical %.1fh < 30min — too aggressive, will page on transient blips", escalateToCritical.Hours())
	}
}

// Rule: nil DB evaluator must not panic or error.
func TestChaos_NilDB_NoPanic(t *testing.T) {
	e := New(nil)
	for _, layer := range []string{"anti_trace", "watchdog", "db_pool", "header_gate"} {
		for _, level := range []int{2, 3} {
			if err := e.EvaluateLayer(context.Background(), layer, level); err != nil {
				t.Fatalf("EvaluateLayer(%s, %d) with nil DB returned error: %v", layer, level, err)
			}
		}
	}
}

// Rule: evaluator must implement LayerEvaluator interface (compile-time check).
func TestChaos_EvaluatorInterface(t *testing.T) {
	var _ LayerEvaluatorInterface = New(nil)
}

// LayerEvaluatorInterface mirrors probe.LayerEvaluator — defined locally to
// avoid circular import while still giving a compile-time guarantee.
type LayerEvaluatorInterface interface {
	EvaluateLayer(ctx context.Context, layer string, level int) error
}
