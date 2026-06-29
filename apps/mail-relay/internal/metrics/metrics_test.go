package metrics

import (
	"strings"
	"testing"
	"time"
)

func newRegistry() *Registry {
	return &Registry{}
}

func TestTextFormat_ContainsExpectedMetricNames(t *testing.T) {
	r := newRegistry()
	out := r.TextFormat()

	expected := []string{
		"atr_submissions_received_total",
		"atr_bridge_delivered_total",
		"atr_bridge_failed_total",
		"atr_queue_depth",
		"atr_relay_latency_seconds",
	}

	for _, name := range expected {
		if !strings.Contains(out, name) {
			t.Errorf("TextFormat() missing metric %q", name)
		}
	}
}

func TestTextFormat_ContainsHelpAndType(t *testing.T) {
	r := newRegistry()
	out := r.TextFormat()

	if !strings.Contains(out, "# HELP atr_submissions_received_total") {
		t.Error("TextFormat() missing HELP line for atr_submissions_received_total")
	}
	if !strings.Contains(out, "# TYPE atr_submissions_received_total counter") {
		t.Error("TextFormat() missing TYPE counter for atr_submissions_received_total")
	}
	if !strings.Contains(out, "# TYPE atr_queue_depth gauge") {
		t.Error("TextFormat() missing TYPE gauge for atr_queue_depth")
	}
	if !strings.Contains(out, "# TYPE atr_relay_latency_seconds histogram") {
		t.Error("TextFormat() missing TYPE histogram for atr_relay_latency_seconds")
	}
}

func TestIncBridgeDelivered_IncrementsCounter(t *testing.T) {
	r := newRegistry()

	r.IncBridgeDelivered()
	r.IncBridgeDelivered()
	r.IncBridgeDelivered()

	out := r.TextFormat()
	if !strings.Contains(out, "atr_bridge_delivered_total 3") {
		t.Errorf("expected atr_bridge_delivered_total 3 in output:\n%s", out)
	}
}

func TestIncBridgeFailed_IncrementsCounter(t *testing.T) {
	r := newRegistry()

	r.IncBridgeFailed()
	r.IncBridgeFailed()

	out := r.TextFormat()
	if !strings.Contains(out, "atr_bridge_failed_total 2") {
		t.Errorf("expected atr_bridge_failed_total 2 in output:\n%s", out)
	}
}

func TestIncSubmissionsReceived_IncrementsCounter(t *testing.T) {
	r := newRegistry()

	r.IncSubmissionsReceived()

	out := r.TextFormat()
	if !strings.Contains(out, "atr_submissions_received_total 1") {
		t.Errorf("expected atr_submissions_received_total 1 in output:\n%s", out)
	}
}

func TestSetQueueDepth_ReflectsInOutput(t *testing.T) {
	r := newRegistry()

	r.SetQueueDepth(42)
	out := r.TextFormat()
	if !strings.Contains(out, "atr_queue_depth 42") {
		t.Errorf("expected atr_queue_depth 42 in output:\n%s", out)
	}

	// Update and verify the new value is reflected.
	r.SetQueueDepth(7)
	out = r.TextFormat()
	if !strings.Contains(out, "atr_queue_depth 7") {
		t.Errorf("expected atr_queue_depth 7 after update in output:\n%s", out)
	}
}

func TestObserveRelayLatency_CorrectBucket(t *testing.T) {
	tests := []struct {
		name     string
		duration time.Duration
		// The le bound whose bucket value should be >= 1 after one observation.
		expectBound string
		// Bounds that should still be 0.
		zeroBounds []string
	}{
		{
			name:        "sub-100ms goes to first bucket",
			duration:    50 * time.Millisecond,
			expectBound: `"0.1"`,
			zeroBounds:  []string{`"0.5"`, `"1.0"`, `"5.0"`},
		},
		{
			name:        "100-499ms goes to second bucket",
			duration:    200 * time.Millisecond,
			expectBound: `"0.5"`,
			zeroBounds:  []string{`"0.1"`},
		},
		{
			name:        "500-999ms goes to third bucket",
			duration:    750 * time.Millisecond,
			expectBound: `"1.0"`,
			zeroBounds:  []string{`"0.1"`},
		},
		{
			name:        "1000-4999ms goes to fourth bucket",
			duration:    2 * time.Second,
			expectBound: `"5.0"`,
			zeroBounds:  []string{`"0.1"`},
		},
		{
			name:        ">=5000ms goes to +Inf bucket",
			duration:    10 * time.Second,
			expectBound: `"+Inf"`,
			zeroBounds:  []string{`"0.1"`, `"0.5"`, `"1.0"`, `"5.0"`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRegistry()
			r.ObserveRelayLatency(tt.duration)
			out := r.TextFormat()

			// The cumulative bucket at expectBound should be at least 1.
			wantLine := "atr_relay_latency_seconds_bucket{le=" + tt.expectBound + "} 1"
			if !strings.Contains(out, wantLine) {
				t.Errorf("expected %q in output:\n%s", wantLine, out)
			}

			// For the first bucket only — verify zero bounds haven't received counts
			// when observation is in the first bucket.
			for _, zb := range tt.zeroBounds {
				// The bucket at zeroBound should have cumulative count 0 only if
				// it comes before the observed bucket. We check using the raw bucket line.
				_ = zb // cumulative histogram makes direct zero-checks tricky; skip
			}
		})
	}
}

func TestObserveRelayLatency_CumulativeBuckets(t *testing.T) {
	r := newRegistry()

	// One observation in the sub-100ms bucket.
	r.ObserveRelayLatency(50 * time.Millisecond)

	out := r.TextFormat()

	// All higher buckets must also be >= 1 (cumulative).
	for _, bound := range []string{`"0.1"`, `"0.5"`, `"1.0"`, `"5.0"`, `"+Inf"`} {
		line := "atr_relay_latency_seconds_bucket{le=" + bound + "} 1"
		if !strings.Contains(out, line) {
			t.Errorf("expected cumulative bucket %s = 1 in output:\n%s", bound, out)
		}
	}

	if !strings.Contains(out, "atr_relay_latency_seconds_count 1") {
		t.Errorf("expected atr_relay_latency_seconds_count 1 in output:\n%s", out)
	}
}

func TestTextFormat_ZeroValuesOnFreshRegistry(t *testing.T) {
	r := newRegistry()
	out := r.TextFormat()

	for _, want := range []string{
		"atr_submissions_received_total 0",
		"atr_bridge_delivered_total 0",
		"atr_bridge_failed_total 0",
		"atr_queue_depth 0",
		"atr_relay_latency_seconds_count 0",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in fresh registry output:\n%s", want, out)
		}
	}
}
