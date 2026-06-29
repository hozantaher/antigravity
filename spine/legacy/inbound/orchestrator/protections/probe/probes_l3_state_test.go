package probe

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// --------------------------------------------------------------------
// nil-db → StatusSkip for all DB-backed state probes
// --------------------------------------------------------------------

func TestCircuitBreakerL3_NilDB(t *testing.T) {
	p := NewCircuitBreakerL3(nil, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s: %s", r.Status, r.Detail)
	}
}

func TestCanaryL3_NilDB(t *testing.T) {
	p := NewCanaryL3(nil, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s: %s", r.Status, r.Detail)
	}
}

func TestBounceGuardL3_NilDB(t *testing.T) {
	p := NewBounceGuardL3(nil, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// SendRateL3 is always skip
// --------------------------------------------------------------------

func TestSendRateL3_AlwaysSkip(t *testing.T) {
	p := NewSendRateL3(0)
	if p.Layer() != "send_rate" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 30*time.Minute {
		t.Fatalf("interval: %v", p.Interval())
	}
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s", r.Status)
	}
}

// --------------------------------------------------------------------
// WarmupRespectL3 — pure plan monotonicity check
// --------------------------------------------------------------------

func writeTestWarmupYAML(t *testing.T, content string) string {
	t.Helper()
	f := filepath.Join(t.TempDir(), "warmup.yaml")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

const goodWarmupYAML = `
plans:
  test_plan:
    description: monotonic plan
    schedule:
      - { day: 1,  daily_limit: 10 }
      - { day: 5,  daily_limit: 25 }
      - { day: 10, daily_limit: 50 }
      - { day: 20, daily_limit: 80 }
`

const brokenWarmupYAML = `
plans:
  test_plan:
    description: plan with zero limit — invalid
    schedule:
      - { day: 1,  daily_limit: 0 }
      - { day: 10, daily_limit: 80 }
`

const flatWarmupYAML = `
plans:
  test_plan:
    description: flat plan that never ramps
    schedule:
      - { day: 1,  daily_limit: 10 }
      - { day: 10, daily_limit: 10 }
`

func TestWarmupRespectL3_GoodPlan_OK(t *testing.T) {
	path := writeTestWarmupYAML(t, goodWarmupYAML)
	p := &WarmupRespectL3{PlanPath: path, PlanName: "test_plan", MaxDay: 20}
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s: %s", r.Status, r.Detail)
	}
}

func TestWarmupRespectL3_InvalidYAML_Skip(t *testing.T) {
	// Parser rejects zero daily_limit entries — results in StatusSkip (load error).
	path := writeTestWarmupYAML(t, brokenWarmupYAML)
	p := &WarmupRespectL3{PlanPath: path, PlanName: "test_plan", MaxDay: 10}
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip (invalid yaml), got %s: %s", r.Status, r.Detail)
	}
}

func TestWarmupRespectL3_FlatPlan_Warn(t *testing.T) {
	path := writeTestWarmupYAML(t, flatWarmupYAML)
	p := &WarmupRespectL3{PlanPath: path, PlanName: "test_plan", MaxDay: 10}
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("want warn (flat plan), got %s: %s", r.Status, r.Detail)
	}
}

func TestWarmupRespectL3_MissingPlan_Skip(t *testing.T) {
	path := writeTestWarmupYAML(t, goodWarmupYAML)
	p := &WarmupRespectL3{PlanPath: path, PlanName: "nonexistent", MaxDay: 20}
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip on missing plan, got %s: %s", r.Status, r.Detail)
	}
}

func TestWarmupRespectL3_MissingFile_Skip(t *testing.T) {
	p := &WarmupRespectL3{PlanPath: "/tmp/does-not-exist-probe.yaml", PlanName: "x", MaxDay: 5}
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip on missing file, got %s: %s", r.Status, r.Detail)
	}
}

func TestWarmupRespectL3_DefaultInterval(t *testing.T) {
	p := NewWarmupRespectL3("", 0)
	if p.Interval() != 15*time.Minute {
		t.Fatalf("interval: %v", p.Interval())
	}
	if p.Layer() != "warmup" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
}

// --------------------------------------------------------------------
// Layer/Level/Interval contract for all state probes
// --------------------------------------------------------------------

func TestStateProbes_LayerLevelInterval(t *testing.T) {
	cases := []struct {
		p       Prober
		layer   string
		wantMin time.Duration
	}{
		{NewCircuitBreakerL3(nil, 0), "circuit_breaker", time.Minute},
		{NewCanaryL3(nil, 0), "canary", time.Minute},
		{NewBounceGuardL3(nil, 0), "bounce_guard", time.Minute},
		{NewSendRateL3(0), "send_rate", time.Minute},
		{NewWarmupRespectL3("", 0), "warmup", time.Minute},
	}
	for _, c := range cases {
		if c.p.Layer() != c.layer {
			t.Errorf("%s: layer=%s", c.layer, c.p.Layer())
		}
		if c.p.Level() != LevelCorrect {
			t.Errorf("%s: level=%d", c.layer, c.p.Level())
		}
		if c.p.Interval() < c.wantMin {
			t.Errorf("%s: interval %v < %v", c.layer, c.p.Interval(), c.wantMin)
		}
	}
}
