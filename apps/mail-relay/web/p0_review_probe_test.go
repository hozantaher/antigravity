package web

// Post-AR/AS code review bundle — P0/P1 fixes (Fix 6).
//
// Fix 6 (P1): ErrPoolExhausted must surface as HTTP 503 {error:"pool_exhausted"}
// from handleProbe instead of HTTP 200 with an opaque error string embedded
// inside the probe result JSON.

import (
	"relay/internal/transport/wgpool"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// exhaustedPinStore is a PinReader/PinWriter where every label is already
// pinned to a different mailbox — simulates a fully-allocated pool.
type exhaustedPinStore struct {
	mu    sync.Mutex
	taken map[string]string // label → ownerMailboxID
}

func newExhaustedPinStore(labels []string) *exhaustedPinStore {
	taken := make(map[string]string, len(labels))
	for i, l := range labels {
		// Pin each endpoint to a different fictitious mailbox.
		taken[l] = "owner-mb-" + string(rune('a'+i))
	}
	return &exhaustedPinStore{taken: taken}
}

func (s *exhaustedPinStore) GetMailboxPinnedEndpoint(mailboxID string) (string, error) {
	// New mailbox has no pin yet.
	return "", nil
}

func (s *exhaustedPinStore) GetAllPinnedLabels() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.taken))
	for l := range s.taken {
		out = append(out, l)
	}
	return out, nil
}

func (s *exhaustedPinStore) SetMailboxPin(_, _, _ string) error {
	// Simulate race/conflict: pool is already full so any set attempt
	// returns a unique violation, triggering infinite recursive retry
	// protection. In practice pickAllocate sees all candidates taken
	// in step 4 and returns ErrPoolExhausted before reaching SetMailboxPin.
	return errors.New("23505 unique constraint violated")
}

// TP6-1: handleProbe returns HTTP 503 + {"error":"pool_exhausted"} when
// wgPool has mailbox_id set and all endpoints are already pinned (ErrPoolExhausted).
func TestHandleProbe_PoolExhausted_Returns503(t *testing.T) {
	srv, token := testServer(t)

	eps := []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1", Country: "CZ"},
	}
	pool, err := wgpool.New(eps, wgpool.Config{})
	if err != nil {
		t.Fatal(err)
	}
	store := newExhaustedPinStore([]string{"cz1"})
	pool.WithPinReader(store).WithPinWriter(store)
	srv.WithWGPool(pool)

	body, _ := json.Marshal(map[string]any{
		"smtp_host":         "smtp.seznam.cz",
		"smtp_port":         465,
		"smtp_username":     "mb@garaaage.cz",
		"password":          "secret",
		"mailbox_id":        "new-mailbox-no-pin",
		"preferred_country": "CZ",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/probe", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d (body: %s)", w.Code, w.Body.String())
	}
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid JSON: %v (body: %s)", err, w.Body.String())
	}
	if result["error"] != "pool_exhausted" {
		t.Fatalf("want error=pool_exhausted, got %q", result["error"])
	}
	if result["detail"] == "" {
		t.Fatal("want non-empty detail in pool_exhausted response")
	}
}

// TP6-2: handleProbe returns HTTP 200 when wgPool picks successfully (non-exhausted pool).
// Verifies that Fix 6 does not break the happy path.
func TestHandleProbe_NonExhausted_Returns200(t *testing.T) {
	srv, token := testServer(t)

	// Single endpoint, no pin wired → hash routing, not pickAllocate.
	// socks_addr points to a closed port so the probe fails auth, but
	// the handler must still return 200 (probe ran, just SMTP refused).
	eps := []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1", Country: "CZ"},
	}
	pool, _ := wgpool.New(eps, wgpool.Config{})
	srv.WithWGPool(pool)

	body, _ := json.Marshal(map[string]any{
		"smtp_host":         "smtp.seznam.cz",
		"smtp_port":         465,
		"smtp_username":     "mb@garaaage.cz",
		"password":          "secret",
		// No mailbox_id → hash routing, no pickAllocate.
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/probe", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// TP6-3: smtpAuthProbe sets PoolExhausted=true when ErrPoolExhausted is returned.
func TestSmtpAuthProbe_PoolExhausted_FlagSet(t *testing.T) {
	srv, _ := testServer(t)

	eps := []wgpool.Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1", Country: "CZ"},
	}
	pool, _ := wgpool.New(eps, wgpool.Config{})
	store := newExhaustedPinStore([]string{"cz1"})
	pool.WithPinReader(store).WithPinWriter(store)
	srv.WithWGPool(pool)

	req := authCheckRequest{
		SMTPHost:         "smtp.seznam.cz",
		SMTPPort:         465,
		SMTPUsername:     "mb@garaaage.cz",
		Password:         "secret",
		MailboxID:        "new-mailbox-exhausted",
		PreferredCountry: "CZ",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := srv.smtpAuthProbe(ctx, req)
	if !result.PoolExhausted {
		t.Fatalf("want PoolExhausted=true, got false (error=%q)", result.Error)
	}
	if result.OK {
		t.Fatal("want OK=false when pool exhausted")
	}
}
