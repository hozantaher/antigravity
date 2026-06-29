package probe

// probes_stub_test.go — covers StubProbe which was at 0% coverage.
// StubProbe is used to populate dashboard cells for layers/levels that have
// no meaningful check (returns a fixed status+detail).

import (
	"context"
	"testing"
	"time"
)

// ── NewStubProbe constructor ──────────────────────────────────────────────────

func TestNewStubProbe_FieldsSet(t *testing.T) {
	p := NewStubProbe("header_gate", LevelAlive, StatusSkip, "not applicable at L2", 5*time.Minute)
	if p.LayerName != "header_gate" {
		t.Errorf("LayerName = %q, want 'header_gate'", p.LayerName)
	}
	if p.LevelVal != LevelAlive {
		t.Errorf("LevelVal = %v, want LevelAlive", p.LevelVal)
	}
	if p.Fixed != StatusSkip {
		t.Errorf("Fixed = %v, want StatusSkip", p.Fixed)
	}
	if p.DetailMsg != "not applicable at L2" {
		t.Errorf("DetailMsg = %q, want 'not applicable at L2'", p.DetailMsg)
	}
	if p.Cadence != 5*time.Minute {
		t.Errorf("Cadence = %v, want 5m", p.Cadence)
	}
}

func TestNewStubProbe_ReturnsNonNil(t *testing.T) {
	p := NewStubProbe("layer", LevelCorrect, StatusOK, "", 0)
	if p == nil {
		t.Fatal("NewStubProbe returned nil")
	}
}

// ── Layer / Level / Interval ──────────────────────────────────────────────────

func TestStubProbe_Layer(t *testing.T) {
	p := NewStubProbe("spf_dmarc", LevelCorrect, StatusSkip, "", time.Minute)
	if p.Layer() != "spf_dmarc" {
		t.Errorf("Layer() = %q, want 'spf_dmarc'", p.Layer())
	}
}

func TestStubProbe_Level(t *testing.T) {
	p := NewStubProbe("canary", LevelAlive, StatusSkip, "", time.Minute)
	if p.Level() != LevelAlive {
		t.Errorf("Level() = %v, want LevelAlive", p.Level())
	}
}

func TestStubProbe_Interval_CustomCadence(t *testing.T) {
	p := NewStubProbe("x", LevelAlive, StatusSkip, "", 7*time.Minute)
	if p.Interval() != 7*time.Minute {
		t.Errorf("Interval() = %v, want 7m", p.Interval())
	}
}

func TestStubProbe_Interval_ZeroCadenceFallsBackTo5m(t *testing.T) {
	p := NewStubProbe("x", LevelAlive, StatusSkip, "", 0)
	if p.Interval() != 5*time.Minute {
		t.Errorf("Interval() with 0 cadence = %v, want 5m (default)", p.Interval())
	}
}

func TestStubProbe_Interval_NegativeCadenceFallsBackTo5m(t *testing.T) {
	p := NewStubProbe("x", LevelAlive, StatusSkip, "", -1*time.Second)
	if p.Interval() != 5*time.Minute {
		t.Errorf("Interval() with negative cadence = %v, want 5m (default)", p.Interval())
	}
}

// ── Run ───────────────────────────────────────────────────────────────────────

func TestStubProbe_Run_ReturnsFixedStatus(t *testing.T) {
	for _, status := range []Status{StatusOK, StatusWarn, StatusErr, StatusSkip} {
		p := NewStubProbe("layer", LevelAlive, status, "detail", time.Minute)
		result := p.Run(context.Background())
		if result.Status != status {
			t.Errorf("Run() status = %v, want %v", result.Status, status)
		}
	}
}

func TestStubProbe_Run_ReturnsFixedDetail(t *testing.T) {
	p := NewStubProbe("layer", LevelAlive, StatusSkip, "not applicable at L2 for this layer", time.Minute)
	result := p.Run(context.Background())
	if result.Detail != "not applicable at L2 for this layer" {
		t.Errorf("Run() detail = %q, want 'not applicable at L2 for this layer'", result.Detail)
	}
}

func TestStubProbe_Run_EmptyDetail(t *testing.T) {
	p := NewStubProbe("layer", LevelAlive, StatusSkip, "", time.Minute)
	result := p.Run(context.Background())
	if result.Detail != "" {
		t.Errorf("Run() detail = %q, want empty", result.Detail)
	}
}

func TestStubProbe_Run_ContextCancelledNoEffect(t *testing.T) {
	// StubProbe does not use the context — cancellation must not panic.
	p := NewStubProbe("layer", LevelAlive, StatusOK, "ok", time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := p.Run(ctx)
	if result.Status != StatusOK {
		t.Errorf("Run() with cancelled ctx = %v, want StatusOK", result.Status)
	}
}

// ── Interface satisfaction ────────────────────────────────────────────────────

// Compile-time check: *StubProbe must satisfy the Probe interface.
var _ interface {
	Layer() string
	Level() Level
	Interval() time.Duration
	Run(context.Context) Result
} = (*StubProbe)(nil)

// ── Use-case coverage: 9 typical stub cells ───────────────────────────────────

func TestStubProbe_TypicalUseCases(t *testing.T) {
	cases := []struct {
		layer  string
		level  Level
		status Status
		detail string
	}{
		{"header_gate", LevelAlive, StatusSkip, "L2 alive check not applicable for header_gate"},
		{"warmup", LevelAlive, StatusSkip, "L2 alive check not applicable for warmup"},
		{"bounce_guard", LevelAlive, StatusSkip, "L2 alive check not applicable for bounce_guard"},
		{"circuit_breaker", LevelAlive, StatusSkip, "L2 alive check not applicable for circuit_breaker"},
		{"send_rate", LevelAlive, StatusSkip, "L2 alive check not applicable for send_rate"},
		{"spf_dmarc", LevelAlive, StatusSkip, "L2 alive check not applicable for spf_dmarc"},
		{"canary", LevelAlive, StatusSkip, "L2 alive check not applicable for canary"},
		{"db_pool", LevelCorrect, StatusSkip, "L3 correctness not applicable for db_pool"},
		{"sender_engine", LevelCorrect, StatusSkip, "L3 correctness not applicable for sender_engine"},
	}

	for _, tc := range cases {
		p := NewStubProbe(tc.layer, tc.level, tc.status, tc.detail, 5*time.Minute)
		r := p.Run(context.Background())
		if r.Status != tc.status {
			t.Errorf("[%s] Run().Status = %v, want %v", tc.layer, r.Status, tc.status)
		}
		if r.Detail != tc.detail {
			t.Errorf("[%s] Run().Detail = %q, want %q", tc.layer, r.Detail, tc.detail)
		}
		if p.Layer() != tc.layer {
			t.Errorf("[%s] Layer() = %q", tc.layer, p.Layer())
		}
		if p.Level() != tc.level {
			t.Errorf("[%s] Level() = %v", tc.layer, p.Level())
		}
	}
}
