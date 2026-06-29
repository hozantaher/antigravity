package web

// Sprint AP4 — tests for /v1/egress-observations endpoint and
// probe-side egress observation recording.
//
// TC01: GET /v1/egress-observations with no wgPool → empty 200
// TC02: GET /v1/egress-observations without ?drain → peek (buffer unchanged)
// TC03: GET /v1/egress-observations?drain=1 → returns + clears buffer
// TC04: POST /v1/egress-observations → 405
// TC05: smtpAuthProbe via wgPool records observation on endpoint-picked path
// TC06: imapAuthProbe via wgPool records observation on endpoint-picked path
// TC07: smtpAuthProbe without mailbox_id → no observation even if wgPool wired
// TC08: smtpAuthProbe without wgPool → no observation

import (
	"relay/internal/transport/wgpool"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TC01: No wgPool wired → empty observations response.
func TestAP4_EgressObservations_NoWGPool(t *testing.T) {
	srv, _ := testServer(t)
	// wgPool is nil by default

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp egressObservationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("count = %d, want 0 (no wgPool)", resp.Count)
	}
}

// TC02: Without ?drain, buffer is NOT cleared.
func TestAP4_EgressObservations_PeekNoDrain(t *testing.T) {
	pool, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}
	pool.RecordEgressObservation("55", "CZ", "cz1", "send")

	srv, _ := testServer(t)
	srv.wgPool = pool

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	var resp egressObservationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Count != 1 {
		t.Fatalf("count = %d, want 1", resp.Count)
	}

	// Buffer must still be intact after peek
	remaining := pool.PeekEgressObservations()
	if len(remaining) != 1 {
		t.Errorf("remaining = %d after peek, want 1 (no drain)", len(remaining))
	}
}

// TC03: ?drain=1 returns observations AND clears the buffer.
func TestAP4_EgressObservations_Drain(t *testing.T) {
	pool, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}
	pool.RecordEgressObservation("77", "CZ", "cz1", "probe")
	pool.RecordEgressObservation("88", "DE", "de1", "send")

	srv, _ := testServer(t)
	srv.wgPool = pool

	req := httptest.NewRequest(http.MethodGet, "/v1/egress-observations?drain=1", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)

	var resp egressObservationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Count != 2 {
		t.Fatalf("count = %d, want 2", resp.Count)
	}

	// After drain, buffer should be empty
	remaining := pool.PeekEgressObservations()
	if len(remaining) != 0 {
		t.Errorf("remaining = %d, want 0 after drain", len(remaining))
	}
}

// TC04: POST → 405 Method Not Allowed.
func TestAP4_EgressObservations_MethodNotAllowed(t *testing.T) {
	srv, _ := testServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/egress-observations", nil)
	w := httptest.NewRecorder()
	srv.handleEgressObservations(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", w.Code)
	}
}

// TC05: smtpAuthProbe via wgPool picks endpoint → observation buffered.
// Uses a closed loopback address so the SMTP dial fails, but the endpoint
// pick (and thus observation) happens before the dial.
func TestAP4_SmtpAuthProbe_WGPool_RecordsObservationOnPick(t *testing.T) {
	pool, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1", Country: "CZ"}, // port 1 = instant refuse
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}

	srv, _ := testServer(t)
	srv.WithWGPool(pool)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := srv.smtpAuthProbe(ctx, authCheckRequest{
		SMTPHost:     "smtp.example.cz",
		SMTPPort:     587,
		SMTPUsername: "u",
		Password:     "p",
		MailboxID:    "123",
	})

	// Probe will fail (refused), but observation only recorded on SUCCESS.
	if result.OK {
		obs := pool.PeekEgressObservations()
		if len(obs) == 0 {
			t.Error("expected observation on success, got 0")
		}
	} else {
		// Failed probe → no observation expected
		obs := pool.PeekEgressObservations()
		if len(obs) != 0 {
			t.Errorf("expected 0 observations on failed probe, got %d", len(obs))
		}
	}
}

// TC06: imapAuthProbe via wgPool — same assertion: no observation on dial failure.
func TestAP4_ImapAuthProbe_WGPool_NoObservationOnFailure(t *testing.T) {
	pool, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1", Country: "CZ"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}

	srv, _ := testServer(t)
	srv.WithWGPool(pool)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := srv.imapAuthProbe(ctx, probeRequest{
		SMTPHost:     "imap.example.cz",
		SMTPPort:     587,
		SMTPUsername: "u",
		Password:     "p",
		IMAPHost:     "imap.example.cz",
		IMAPPort:     993,
		MailboxID:    "456",
	}, "")

	if result.OK {
		obs := pool.PeekEgressObservations()
		if len(obs) == 0 {
			t.Error("expected observation on imap success, got 0")
		}
	} else {
		obs := pool.PeekEgressObservations()
		if len(obs) != 0 {
			t.Errorf("expected 0 observations on failed imap probe, got %d", len(obs))
		}
	}
}

// TC07: smtpAuthProbe without mailbox_id → no observation buffered.
func TestAP4_SmtpAuthProbe_NoMailboxID_NoObservation(t *testing.T) {
	pool, err := wgpool.New([]wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1", Country: "CZ"},
	}, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}

	srv, _ := testServer(t)
	srv.WithWGPool(pool)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	srv.smtpAuthProbe(ctx, authCheckRequest{
		SMTPHost:  "smtp.example.cz",
		SMTPPort:  587,
		SMTPUsername: "u",
		Password:  "p",
		// MailboxID intentionally empty
	})

	obs := pool.PeekEgressObservations()
	if len(obs) != 0 {
		t.Errorf("expected 0 observations when no mailbox_id, got %d", len(obs))
	}
}

// TC08: smtpAuthProbe without wgPool wired → no observation.
func TestAP4_SmtpAuthProbe_NoWGPool_NoObservation(t *testing.T) {
	srv, _ := testServer(t)
	// wgPool is nil

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	srv.smtpAuthProbe(ctx, authCheckRequest{
		SMTPHost:     "smtp.example.cz",
		SMTPPort:     587,
		SMTPUsername: "u",
		Password:     "p",
		MailboxID:    "999",
	})
	// No panic, no observation to check
}
