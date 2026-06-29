package alert

import (
	"context"
	"testing"
)

func TestEvaluator_NilDB(t *testing.T) {
	e := New(nil)
	if err := e.EvaluateLayer(context.Background(), "watchdog", 2); err != nil {
		t.Fatalf("nil db should be no-op, got: %v", err)
	}
}

func TestEscalateToCritical_Constant(t *testing.T) {
	if escalateToCritical.Hours() < 1 {
		t.Fatalf("escalateToCritical too small: %v", escalateToCritical)
	}
}

func TestThresholds(t *testing.T) {
	if l2AlertThreshold != 1 {
		t.Fatalf("L2 threshold should be 1 (immediate), got %d", l2AlertThreshold)
	}
	if l3AlertThreshold < 2 {
		t.Fatalf("L3 threshold should be ≥2, got %d", l3AlertThreshold)
	}
	if resolveAfterOK < 2 {
		t.Fatalf("resolveAfterOK should be ≥2, got %d", resolveAfterOK)
	}
}
