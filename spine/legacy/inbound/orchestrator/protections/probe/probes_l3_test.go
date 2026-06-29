package probe

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --------------------------------------------------------------------
// AntiTrace L3
// --------------------------------------------------------------------

func TestAntiTraceL3_SkipWhenNotConfigured(t *testing.T) {
	p := NewAntiTraceL3("", "", 0)
	if p.Run(context.Background()).Status != StatusSkip {
		t.Fatal("expected skip")
	}
}

func TestAntiTraceL3_OKWhenBridgeOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	res := NewAntiTraceL3(srv.URL, "tok", 0).Run(context.Background())
	if res.Status != StatusOK {
		t.Fatalf("expected ok, got %q (%s)", res.Status, res.Detail)
	}
	if res.Latency <= 0 {
		t.Error("expected non-zero latency")
	}
}

func TestAntiTraceL3_ErrWhenBridgeUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"status":"unreachable"}`))
	}))
	defer srv.Close()

	res := NewAntiTraceL3(srv.URL, "tok", 0).Run(context.Background())
	if res.Status != StatusErr {
		t.Fatalf("expected err, got %q", res.Status)
	}
	if !strings.Contains(res.Detail, "unreachable") {
		t.Errorf("expected unreachable in detail, got %q", res.Detail)
	}
}

func TestAntiTraceL3_Interval(t *testing.T) {
	if NewAntiTraceL3("http://x", "", 0).Interval() != 5*time.Minute {
		t.Error("default should be 5m")
	}
	if NewAntiTraceL3("http://x", "", 45*time.Second).Interval() != 45*time.Second {
		t.Error("explicit cadence should be honored")
	}
}

// --------------------------------------------------------------------
// ProxyPool L3
// --------------------------------------------------------------------

func TestProxyPoolL3_SkipWhenNotConfigured(t *testing.T) {
	if NewProxyPoolL3("", "", 0).Run(context.Background()).Status != StatusSkip {
		t.Fatal("expected skip")
	}
}

func TestProxyPoolL3_ErrWhenPoolEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"working":[]}`))
	}))
	defer srv.Close()

	res := NewProxyPoolL3(srv.URL, "", 0).Run(context.Background())
	if res.Status != StatusErr {
		t.Fatalf("expected err, got %q", res.Status)
	}
	if !strings.Contains(res.Detail, "empty") {
		t.Errorf("expected 'empty' in detail, got %q", res.Detail)
	}
}

func TestProxyPoolL3_Interval(t *testing.T) {
	if NewProxyPoolL3("http://x", "", 0).Interval() != 10*time.Minute {
		t.Error("default should be 10m")
	}
}

// --------------------------------------------------------------------
// HeaderGate L3
// --------------------------------------------------------------------

// safeBuilder strips CR/LF from keys (reject) and from values — models
// the fixed buildMessage after migration to per-key rejection.
func safeBuilder(from, to, subject, bodyPlain, _ string, headers map[string]string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	for k, v := range headers {
		if strings.ContainsAny(k, "\r\n") {
			continue // rejected
		}
		cleanV := strings.ReplaceAll(strings.ReplaceAll(v, "\r", ""), "\n", "")
		b.WriteString(k + ": " + cleanV + "\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString(bodyPlain)
	return []byte(b.String())
}

// brokenBuilder simulates the OLD behavior: strip CR/LF from keys.
// This collapses "B\r\ncc" → "Bcc" and successfully smuggles.
func brokenBuilder(from, to, subject, bodyPlain, _ string, headers map[string]string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	for k, v := range headers {
		cleanK := strings.ReplaceAll(strings.ReplaceAll(k, "\r", ""), "\n", "")
		cleanV := strings.ReplaceAll(strings.ReplaceAll(v, "\r", ""), "\n", "")
		b.WriteString(cleanK + ": " + cleanV + "\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString(bodyPlain)
	return []byte(b.String())
}

func TestHeaderGateL3_SkipWhenNoBuilder(t *testing.T) {
	if NewHeaderGateL3(nil, 0).Run(context.Background()).Status != StatusSkip {
		t.Fatal("expected skip")
	}
}

func TestHeaderGateL3_OKWithHardenedBuilder(t *testing.T) {
	res := NewHeaderGateL3(safeBuilder, 0).Run(context.Background())
	if res.Status != StatusOK {
		t.Fatalf("expected ok, got %q: %s", res.Status, res.Detail)
	}
}

func TestHeaderGateL3_ErrWithBrokenBuilder(t *testing.T) {
	res := NewHeaderGateL3(brokenBuilder, 0).Run(context.Background())
	if res.Status != StatusErr {
		t.Fatalf("broken builder should trip probe; got %q: %s", res.Status, res.Detail)
	}
	if !strings.Contains(res.Detail, "smuggl") {
		t.Errorf("expected smuggling detail, got %q", res.Detail)
	}
}

func TestHeaderGateL3_Interval(t *testing.T) {
	if NewHeaderGateL3(safeBuilder, 0).Interval() != 15*time.Minute {
		t.Error("default should be 15m")
	}
}

func TestDetectHeaderSmuggling(t *testing.T) {
	tests := []struct {
		name     string
		msg      string
		wantHits bool
	}{
		{
			name:     "clean message",
			msg:      "From: a@b\r\nTo: c@d\r\nSubject: hi\r\n\r\nbody",
			wantHits: false,
		},
		{
			name:     "injected Bcc",
			msg:      "From: a@b\r\nBcc: x@e\r\n\r\nbody",
			wantHits: true,
		},
		{
			name:     "X-Smuggler leaked",
			msg:      "From: a@b\r\nX-Smugger: val\r\n\r\nbody",
			wantHits: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hits := detectHeaderSmuggling(tt.msg)
			if tt.wantHits && len(hits) == 0 {
				t.Error("expected violations, got none")
			}
			if !tt.wantHits && len(hits) > 0 {
				t.Errorf("expected no violations, got %v", hits)
			}
		})
	}
}

// Sanity: the scheduler carries a mixed L2+L3 fleet without layer
// collision in LastRun.
func TestScheduler_L2AndL3DoNotCollide(t *testing.T) {
	l2 := &fakeProber{layer: "anti_trace", level: LevelAlive, interval: 15 * time.Millisecond, status: StatusOK}
	l3 := &fakeProber{layer: "anti_trace", level: LevelCorrect, interval: 15 * time.Millisecond, status: StatusOK}
	sink := &memorySink{}
	s := NewScheduler(sink, l2, l3)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	s.Run(ctx)

	if s.LastRun("anti_trace", LevelAlive).IsZero() {
		t.Fatal("L2 LastRun empty")
	}
	if s.LastRun("anti_trace", LevelCorrect).IsZero() {
		t.Fatal("L3 LastRun empty")
	}

	rows := sink.snapshot()
	got2, got3 := 0, 0
	for _, r := range rows {
		if r.Level == LevelAlive {
			got2++
		}
		if r.Level == LevelCorrect {
			got3++
		}
	}
	if got2 == 0 || got3 == 0 {
		t.Fatalf("expected both L2 and L3 rows; got L2=%d L3=%d", got2, got3)
	}
	// Sanity for test output stability.
	_ = fmt.Sprintf("%d/%d", got2, got3)
}
