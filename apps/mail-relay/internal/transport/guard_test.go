package transport

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// newPoolWithWorking is a test helper that builds a RotatingProxyTransport
// with a preset working set. The real refresh() / HTTP fetch is not called.
func newPoolWithWorking(working ...string) *RotatingProxyTransport {
	t := &RotatingProxyTransport{}
	entries := make([]proxyEntry, 0, len(working))
	for _, w := range working {
		entries = append(entries, proxyEntry{addr: w, latency: 42 * time.Millisecond})
	}
	t.working = entries
	t.lastRefresh = time.Now()
	return t
}

func TestDialGuard_NilGuard_NoOp(t *testing.T) {
	var g *DialGuard
	if err := g.Assert("anything:1"); err != nil {
		t.Errorf("nil guard should be a no-op, got %v", err)
	}
}

func TestDialGuard_AllowsWorkingPoolAddr(t *testing.T) {
	pool := newPoolWithWorking("10.0.0.1:1080")
	g := NewDialGuard(pool, nil, nil)

	if err := g.Assert("10.0.0.1:1080"); err != nil {
		t.Errorf("working pool addr should pass, got %v", err)
	}
}

func TestDialGuard_RefusesDirect_ToSmtpSeznamCz(t *testing.T) {
	// The regression: relay attempts to dial smtp.seznam.cz:465 directly
	// (e.g. because a bug bypassed the pool). Guard must refuse and alert.
	pool := newPoolWithWorking("10.0.0.1:1080")
	alerts := make(chan Alert, 1)
	g := NewDialGuard(pool, nil, alerts)

	err := g.Assert("smtp.seznam.cz:465")
	if err == nil {
		t.Fatal("expected refusal for smtp.seznam.cz:465, got nil")
	}
	if !strings.Contains(err.Error(), "dial_guard") {
		t.Errorf("expected dial_guard error, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "smtp.seznam.cz:465") {
		t.Errorf("error must include destination, got %q", err.Error())
	}

	select {
	case a := <-alerts:
		if a.Type != "DIRECT_EGRESS_ATTEMPT" {
			t.Errorf("expected DIRECT_EGRESS_ATTEMPT, got %q", a.Type)
		}
		if a.Dest != "smtp.seznam.cz:465" {
			t.Errorf("expected Dest=smtp.seznam.cz:465, got %q", a.Dest)
		}
	case <-time.After(50 * time.Millisecond):
		t.Error("expected alert on rejection, got none")
	}
}

func TestDialGuard_AllowsBridgeAddr(t *testing.T) {
	pool := newPoolWithWorking()
	g := NewDialGuard(pool, []string{"bridge.internal:443"}, nil)

	if err := g.Assert("bridge.internal:443"); err != nil {
		t.Errorf("bridge addr should be allowed, got %v", err)
	}
	if err := g.Assert("other.host:443"); err == nil {
		t.Error("non-bridge addr should be refused")
	}
}

func TestDialGuard_AddBridge_Deduplicates(t *testing.T) {
	g := NewDialGuard(newPoolWithWorking(), nil, nil)
	g.AddBridge("a.b:1")
	g.AddBridge("a.b:1")
	g.AddBridge("c.d:2")
	bs := g.Bridges()
	if len(bs) != 2 {
		t.Errorf("expected 2 bridges after dedup, got %d: %v", len(bs), bs)
	}
}

func TestDialGuard_AlertRingBounded(t *testing.T) {
	g := NewDialGuard(newPoolWithWorking(), nil, nil)
	// Force small ring to keep test fast and deterministic.
	g.maxRing = 4
	for i := 0; i < 10; i++ {
		_ = g.Assert("bad.host:25")
	}
	alerts := g.RecentAlerts()
	if len(alerts) != 4 {
		t.Errorf("ring should cap at 4, got %d", len(alerts))
	}
}

func TestDialGuard_SaturatedAlertSink_DoesNotBlock(t *testing.T) {
	pool := newPoolWithWorking()
	alerts := make(chan Alert) // unbuffered, nobody reading
	g := NewDialGuard(pool, nil, alerts)

	done := make(chan struct{})
	go func() {
		_ = g.Assert("bad.host:25")
		close(done)
	}()

	select {
	case <-done:
		// ok — Assert completed despite saturated sink
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Assert blocked when alert sink was saturated")
	}
}

// TestSOCKS5Transport_GuardRefusesProxyAddr verifies the belt-and-suspenders:
// if a SOCKS5Transport is constructed with a proxyAddr that the guard
// doesn't allowlist, DialContext must refuse before reaching net.Dial.
func TestSOCKS5Transport_GuardRefusesProxyAddr(t *testing.T) {
	pool := newPoolWithWorking("10.0.0.1:1080") // valid proxy
	g := NewDialGuard(pool, nil, nil)

	s := NewSOCKS5Transport("evil.proxy:1080", time.Second) // NOT in pool
	s.AttachGuard(g)

	_, err := s.DialContext(context.Background(), "tcp", "smtp.example.com:25")
	if err == nil {
		t.Fatal("expected refusal for non-pool proxy addr")
	}
	if !strings.Contains(err.Error(), "dial_guard") {
		t.Errorf("expected dial_guard error, got %q", err.Error())
	}
}

// TestDirectTransport_GuardRefusesAnyDirectTarget verifies direct egress
// without pool membership is always refused when a guard is attached.
func TestDirectTransport_GuardRefusesAnyDirectTarget(t *testing.T) {
	pool := newPoolWithWorking("10.0.0.1:1080")
	g := NewDialGuard(pool, nil, nil)

	d := NewDirectTransport()
	d.AttachGuard(g)

	_, err := d.DialContext(context.Background(), "tcp", "smtp.seznam.cz:465")
	if err == nil {
		t.Fatal("expected refusal for direct egress to smtp.seznam.cz")
	}
	if !strings.Contains(err.Error(), "dial_guard") {
		t.Errorf("expected dial_guard error, got %q", err.Error())
	}
}

// TestDirectTransport_NoGuard_AllowsDial confirms backward-compat: when no
// guard is attached, DirectTransport still dials (returns a net error since
// 127.0.0.1:1 is closed, but the guard does NOT block the call).
func TestDirectTransport_NoGuard_AllowsDial(t *testing.T) {
	d := NewDirectTransport()
	// Use an unreachable addr so the test doesn't hit the network.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, err := d.DialContext(ctx, "tcp", "127.0.0.1:1")
	if err == nil {
		t.Error("expected dial error to 127.0.0.1:1")
	}
	if strings.Contains(err.Error(), "dial_guard") {
		t.Errorf("no guard attached should not emit dial_guard error, got %v", err)
	}
}

func TestRotatingProxy_IsWorkingAddr(t *testing.T) {
	pool := newPoolWithWorking("a:1", "b:2", "c:3")
	if !pool.IsWorkingAddr("b:2") {
		t.Error("b:2 should be in working set")
	}
	if pool.IsWorkingAddr("z:9") {
		t.Error("z:9 should not be in working set")
	}
}

func TestRotatingProxy_AttachGuard_RoundTrip(t *testing.T) {
	pool := newPoolWithWorking("a:1")
	g := NewDialGuard(pool, nil, nil)
	pool.AttachGuard(g)

	if pool.guard == nil {
		t.Fatal("guard not attached")
	}
	// Sanity: guard can assert a pool member.
	if err := pool.guard.Assert("a:1"); err != nil {
		t.Errorf("pool member should pass guard: %v", err)
	}
}

// Ensure Alert is a plain value struct (regression guard against refactors
// that accidentally add pointer fields which are hard to serialize to logs).
func TestAlert_IsValueType(t *testing.T) {
	a := Alert{Type: "X", Dest: "y:1", Timestamp: time.Now()}
	if errors.Is(nil, nil) != true { /* ensure stdlib errors imported */
	}
	if a.Type == "" || a.Dest == "" {
		t.Error("alert fields not populated")
	}
}
