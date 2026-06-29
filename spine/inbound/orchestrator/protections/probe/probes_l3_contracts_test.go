package probe

import (
	"testing"
	"time"
)

// Layer/Level/Interval contracts for L3 probes not yet covered.

func TestAntiTraceL3_Contracts(t *testing.T) {
	p := NewAntiTraceL3("http://relay", "tok", 5*time.Minute)
	if p.Layer() != "anti_trace" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 5*time.Minute {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestAntiTraceL3_DefaultInterval(t *testing.T) {
	p := NewAntiTraceL3("http://relay", "", 0)
	if p.Interval() != 5*time.Minute {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestProxyPoolL3_Contracts(t *testing.T) {
	p := NewProxyPoolL3("http://bff", "key", 10*time.Minute)
	if p.Layer() != "proxy_pool" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 10*time.Minute {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestProxyPoolL3_DefaultInterval(t *testing.T) {
	p := NewProxyPoolL3("", "", 0)
	if p.Interval() != 10*time.Minute {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestProxyPoolL3_EmptyBFF_Skip(t *testing.T) {
	p := NewProxyPoolL3("", "", 10*time.Minute)
	r := p.Run(t.Context())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

func TestHeaderGateL3_Contracts(t *testing.T) {
	p := NewHeaderGateL3(nil, 15*time.Minute)
	if p.Layer() != "header_gate" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelCorrect {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 15*time.Minute {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestHeaderGateL3_DefaultInterval(t *testing.T) {
	p := NewHeaderGateL3(nil, 0)
	if p.Interval() != 15*time.Minute {
		t.Fatalf("default interval: %s", p.Interval())
	}
}
