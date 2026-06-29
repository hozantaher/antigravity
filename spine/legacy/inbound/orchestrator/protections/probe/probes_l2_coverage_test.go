package probe

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---- AntiTraceL2 ----

func TestAntiTraceL2_Contracts(t *testing.T) {
	p := NewAntiTraceL2("http://example.com", 15*time.Second)
	if p.Layer() != "anti_trace" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelAlive {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 15*time.Second {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestAntiTraceL2_DefaultInterval(t *testing.T) {
	p := NewAntiTraceL2("http://example.com", 0)
	if p.Interval() != 30*time.Second {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestAntiTraceL2_EmptyBaseURL_Skip(t *testing.T) {
	p := NewAntiTraceL2("", 30*time.Second)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

func TestAntiTraceL2_HTTP200_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := &AntiTraceL2{BaseURL: srv.URL, Cadence: 30 * time.Second, layer: "anti_trace"}
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("expected ok, got %s: %s", r.Status, r.Detail)
	}
	if r.Latency <= 0 {
		t.Fatal("expected non-zero latency")
	}
}

func TestAntiTraceL2_HTTP500_Err(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := &AntiTraceL2{BaseURL: srv.URL, Cadence: 30 * time.Second, layer: "anti_trace"}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err, got %s", r.Status)
	}
}

func TestAntiTraceL2_NetworkErr(t *testing.T) {
	p := &AntiTraceL2{BaseURL: "http://127.0.0.1:1", Cadence: 5 * time.Second, layer: "anti_trace"}
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err on refused connection, got %s", r.Status)
	}
}

// ---- ProxyPoolL2 ----

func TestProxyPoolL2_Contracts(t *testing.T) {
	p := NewProxyPoolL2("http://bff", "key", 45*time.Second)
	if p.Layer() != "proxy_pool" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelAlive {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 45*time.Second {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestProxyPoolL2_DefaultInterval(t *testing.T) {
	p := NewProxyPoolL2("http://bff", "", 0)
	if p.Interval() != 30*time.Second {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestProxyPoolL2_EmptyBFF_Skip(t *testing.T) {
	p := NewProxyPoolL2("", "", 30*time.Second)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

// ---- WatchdogL2 ----

func TestWatchdogL2_Contracts(t *testing.T) {
	p := NewWatchdogL2(nil, 60*time.Second, 15*time.Minute)
	if p.Layer() != "watchdog" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelAlive {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 60*time.Second {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestWatchdogL2_DefaultInterval(t *testing.T) {
	p := NewWatchdogL2(nil, 0, 0)
	if p.Interval() != 60*time.Second {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestWatchdogL2_NilDB_Skip(t *testing.T) {
	p := NewWatchdogL2(nil, 0, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

// ---- DBPoolL2 ----

func TestDBPoolL2_Contracts(t *testing.T) {
	p := NewDBPoolL2(nil, 30*time.Second)
	if p.Layer() != "db_pool" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelAlive {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 30*time.Second {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestDBPoolL2_DefaultInterval(t *testing.T) {
	p := NewDBPoolL2(nil, 0)
	if p.Interval() != 30*time.Second {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestDBPoolL2_NilDB_Skip(t *testing.T) {
	p := NewDBPoolL2(nil, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

// ---- SenderEngineL2 ----

func TestSenderEngineL2_Contracts(t *testing.T) {
	p := NewSenderEngineL2(nil, 60*time.Second, 30*time.Minute)
	if p.Layer() != "sender_engine" {
		t.Fatalf("layer: %s", p.Layer())
	}
	if p.Level() != LevelAlive {
		t.Fatalf("level: %d", p.Level())
	}
	if p.Interval() != 60*time.Second {
		t.Fatalf("interval: %s", p.Interval())
	}
}

func TestSenderEngineL2_DefaultInterval(t *testing.T) {
	p := NewSenderEngineL2(nil, 0, 0)
	if p.Interval() != 60*time.Second {
		t.Fatalf("default interval: %s", p.Interval())
	}
}

func TestSenderEngineL2_NilDB_Skip(t *testing.T) {
	p := NewSenderEngineL2(nil, 0, 0)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}
