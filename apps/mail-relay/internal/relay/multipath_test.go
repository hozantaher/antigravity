package relay

import (
	"relay/internal/deaddrop"
	"relay/internal/transport/fragment"
	"relay/internal/shamir"
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func newFragment(t *testing.T, index int, data []byte) fragment.FragmentedShare {
	t.Helper()
	var slot deaddrop.SlotID
	for i := range slot {
		slot[i] = byte(index + 1)
	}
	return fragment.FragmentedShare{
		Index:  index,
		SlotID: slot,
		Share:  shamir.Share{X: byte(index + 1), Data: data},
	}
}

func TestNewMultiPathRouter(t *testing.T) {
	relays := []RelayEndpoint{{URL: "http://a"}, {URL: "http://b"}}
	r := NewMultiPathRouter(relays)
	if r == nil {
		t.Fatal("expected router, got nil")
	}
	if len(r.relays) != 2 {
		t.Fatalf("expected 2 relays, got %d", len(r.relays))
	}
	if r.client == nil {
		t.Fatal("expected non-nil http client")
	}
}

func TestRoute_NoRelays(t *testing.T) {
	r := NewMultiPathRouter(nil)
	err := r.Route(context.Background(), []fragment.FragmentedShare{
		newFragment(t, 0, []byte{1, 2, 3}),
	})
	if err == nil || !strings.Contains(err.Error(), "no relay endpoints") {
		t.Fatalf("expected no relay endpoints error, got: %v", err)
	}
}

func TestRoute_SuccessDistributesAcrossRelays(t *testing.T) {
	var count1, count2 int32
	srv1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		atomic.AddInt32(&count1, 1)
		if !strings.HasPrefix(req.URL.Path, "/v1/drop/") {
			t.Errorf("unexpected path: %s", req.URL.Path)
		}
		if req.Header.Get("Content-Type") != "application/json" {
			t.Errorf("missing content-type")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv1.Close()

	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		atomic.AddInt32(&count2, 1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv2.Close()

	r := NewMultiPathRouter([]RelayEndpoint{
		{URL: srv1.URL},
		{URL: srv2.URL},
	})

	frags := []fragment.FragmentedShare{
		newFragment(t, 0, []byte{0xAA, 0xBB}),
		newFragment(t, 1, []byte{0xCC, 0xDD}),
		newFragment(t, 2, []byte{0xEE, 0xFF}),
	}

	if err := r.Route(context.Background(), frags); err != nil {
		t.Fatalf("Route returned err: %v", err)
	}
	// round-robin: relay[0] receives indexes 0,2 (2 calls) and relay[1] receives index 1 (1 call)
	if atomic.LoadInt32(&count1) != 2 {
		t.Errorf("expected relay 1 to receive 2 requests, got %d", count1)
	}
	if atomic.LoadInt32(&count2) != 1 {
		t.Errorf("expected relay 2 to receive 1 request, got %d", count2)
	}
}

func TestRoute_RelayReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	r := NewMultiPathRouter([]RelayEndpoint{{URL: srv.URL}})
	err := r.Route(context.Background(), []fragment.FragmentedShare{
		newFragment(t, 0, []byte{1, 2}),
	})
	if err == nil {
		t.Fatal("expected error for relay 500, got nil")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("expected error mentioning 500, got: %v", err)
	}
}

func TestRoute_NetworkError(t *testing.T) {
	r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://127.0.0.1:1"}})
	err := r.Route(context.Background(), []fragment.FragmentedShare{
		newFragment(t, 0, []byte{1, 2}),
	})
	if err == nil {
		t.Fatal("expected network error, got nil")
	}
}

func TestRoute_InvalidURL(t *testing.T) {
	// http.NewRequestWithContext fails for invalid URLs with control chars
	r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://invalid\x00host"}})
	err := r.Route(context.Background(), []fragment.FragmentedShare{
		newFragment(t, 0, []byte{1, 2}),
	})
	if err == nil {
		t.Fatal("expected request creation error, got nil")
	}
}

func TestPollFromRelays_SuccessCollectsMessages(t *testing.T) {
	// Server echoes back two hex messages per poll
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", req.Method)
		}
		resp := map[string][]string{
			"messages": {hex.EncodeToString([]byte("msg1")), hex.EncodeToString([]byte("msg2"))},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	r := NewMultiPathRouter([]RelayEndpoint{{URL: srv.URL}})

	var slot1, slot2 deaddrop.SlotID
	slot1[0] = 0xAA
	slot2[0] = 0xBB

	collected, err := r.PollFromRelays(context.Background(), []deaddrop.SlotID{slot1, slot2})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(collected) != 4 {
		t.Fatalf("expected 4 collected fragments (2 slots * 2 messages), got %d", len(collected))
	}
	// Each fragment should carry its slot ID and X = index+1
	for _, f := range collected {
		if f.Share.X == 0 {
			t.Error("expected non-zero X")
		}
	}
}

func TestPollFromRelays_InvalidHexSkipped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Return one valid hex and one invalid
		resp := map[string][]string{
			"messages": {"not-valid-hex!!", hex.EncodeToString([]byte("good"))},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	r := NewMultiPathRouter([]RelayEndpoint{{URL: srv.URL}})
	var slot deaddrop.SlotID
	collected, err := r.PollFromRelays(context.Background(), []deaddrop.SlotID{slot})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(collected) != 1 {
		t.Fatalf("expected 1 valid fragment (invalid hex skipped), got %d", len(collected))
	}
}

func TestPollFromRelays_InvalidJSONContinues(t *testing.T) {
	// Returns a body that is not valid JSON — pollRelay errors, PollFromRelays continues.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Write([]byte("not json"))
	}))
	defer srv.Close()

	r := NewMultiPathRouter([]RelayEndpoint{{URL: srv.URL}})
	var slot deaddrop.SlotID
	collected, err := r.PollFromRelays(context.Background(), []deaddrop.SlotID{slot})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(collected) != 0 {
		t.Fatalf("expected 0 fragments after invalid JSON, got %d", len(collected))
	}
}

func TestPollFromRelays_NetworkErrorContinues(t *testing.T) {
	r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://127.0.0.1:1"}})
	var slot deaddrop.SlotID
	collected, err := r.PollFromRelays(context.Background(), []deaddrop.SlotID{slot})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(collected) != 0 {
		t.Fatalf("expected 0 collected on unreachable relay, got %d", len(collected))
	}
}

func TestPollFromRelays_RequestCreationErrorContinues(t *testing.T) {
	// Invalid URL with control char — http.NewRequestWithContext fails
	r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://invalid\x00host"}})
	var slot deaddrop.SlotID
	collected, err := r.PollFromRelays(context.Background(), []deaddrop.SlotID{slot})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(collected) != 0 {
		t.Fatalf("expected 0 collected, got %d", len(collected))
	}
}
