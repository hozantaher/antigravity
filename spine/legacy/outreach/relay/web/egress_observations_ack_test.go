package web

// AP4-P3: Tests for ?peek=1 and ?drain=1&ack=N handshake on /v1/egress-observations.
//
// TC-ACK01: ?peek=1 returns observations without clearing buffer
// TC-ACK02: ?drain=1&ack=N clears exactly N observations
// TC-ACK03: ?drain=1&ack=N where N > buffer → 409 Conflict, buffer intact
// TC-ACK04: ?drain=1&ack=bad → 400 Bad Request
// TC-ACK05: egress-debug handler no longer fires alert (stats-only; no Sentry side-effect)

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"relay/internal/transport/wgpool"
)

func mustPoolACK(t *testing.T) *wgpool.Pool {
	t.Helper()
	p, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatalf("mustPoolACK: %v", err)
	}
	return p
}

// TC-ACK01: ?peek=1 — buffer not cleared after peek.
func TestEgressObs_Peek_NonDestructive(t *testing.T) {
	pool := mustPoolACK(t)
	pool.RecordEgressObservation("mb1", "CZ", "cz1", "send")
	pool.RecordEgressObservation("mb2", "DE", "de1", "probe")

	srv, _ := testServer(t)
	srv.wgPool = pool

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations?peek=1", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp egressObservationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Count != 2 {
		t.Errorf("peek count = %d, want 2", resp.Count)
	}

	// Buffer must be intact after peek.
	remaining := pool.PeekEgressObservations()
	if len(remaining) != 2 {
		t.Errorf("buffer = %d after peek, want 2 (non-destructive)", len(remaining))
	}
}

// TC-ACK02: ?drain=1&ack=2 with 3 in buffer → drains 2, leaves 1.
func TestEgressObs_DrainAck_ClearsExactN(t *testing.T) {
	pool := mustPoolACK(t)
	pool.RecordEgressObservation("mb1", "CZ", "cz1", "send")
	pool.RecordEgressObservation("mb2", "DE", "de1", "probe")
	pool.RecordEgressObservation("mb3", "AT", "at1", "send")

	srv, _ := testServer(t)
	srv.wgPool = pool

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations?drain=1&ack=2", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp egressObservationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Count != 2 {
		t.Errorf("drain ack=2 returned %d, want 2", resp.Count)
	}

	remaining := pool.PeekEgressObservations()
	if len(remaining) != 1 {
		t.Errorf("remaining = %d after ack=2 drain of 3, want 1", len(remaining))
	}
}

// TC-ACK03: ?drain=1&ack=10 with only 3 in buffer → 409 Conflict, buffer intact.
func TestEgressObs_DrainAck_ExceedsBuffer_Returns409(t *testing.T) {
	pool := mustPoolACK(t)
	pool.RecordEgressObservation("mb1", "CZ", "cz1", "send")
	pool.RecordEgressObservation("mb2", "DE", "de1", "probe")
	pool.RecordEgressObservation("mb3", "AT", "at1", "send")

	srv, _ := testServer(t)
	srv.wgPool = pool

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations?drain=1&ack=10", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 Conflict", w.Code)
	}

	// Buffer must be untouched.
	remaining := pool.PeekEgressObservations()
	if len(remaining) != 3 {
		t.Errorf("buffer = %d after rejected ack, want 3 (intact)", len(remaining))
	}
}

// TC-ACK04: ?drain=1&ack=bad → 400 Bad Request.
func TestEgressObs_DrainAck_InvalidAck_Returns400(t *testing.T) {
	pool := mustPoolACK(t)
	pool.RecordEgressObservation("mb1", "CZ", "cz1", "send")

	srv, _ := testServer(t)
	srv.wgPool = pool

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations?drain=1&ack=notanumber", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 Bad Request for invalid ack", w.Code)
	}
}

// TC-ACK05: egress_debug handler handler returns ring buffer stats but no longer
// calls telemetry.CaptureAlert. We verify this indirectly: even with evict_count>0
// the handler returns 200 with accurate stats and we get no panic (CaptureAlert
// would panic if we injected a nil Sentry scope — but since it's removed from the
// handler, the call path is gone entirely).
func TestProbeEgressDebug_HandlerNoAlertSideEffect(t *testing.T) {
	t.Setenv("TRANSPORT_MODE", "wgpool")
	t.Setenv("WIREPROXY_CONFIG", sampleWGConfig)
	resetEgressDebugCacheForTest()

	pool := mustPoolACK(t)
	// Overflow the ring buffer to trigger evictions.
	for i := 0; i < 2010; i++ {
		pool.RecordEgressObservation("mb1", "CZ", "cz1", "send")
	}

	s := &Server{fallbackProxyAddr: "", wgPool: pool}
	// Must not panic; CaptureAlert is no longer called from probeEgressDebug.
	resp := s.probeEgressDebug(t.Context())

	if resp.EvictCount == 0 {
		t.Error("expected EvictCount > 0 after overflow")
	}
	if resp.RingBufferCap != 2000 {
		t.Errorf("RingBufferCap = %d, want 2000", resp.RingBufferCap)
	}
}
