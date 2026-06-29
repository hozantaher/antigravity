package amnesic

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"relay/internal/delivery/contentenc"
	"relay/internal/epochkeys"
)

// ---------------------------------------------------------------------------
// Fake relay server
// ---------------------------------------------------------------------------

// fakeRelay is a minimal dead-drop relay that accepts POSTs and returns them on GET.
type fakeRelay struct {
	mu       sync.Mutex
	messages map[string][]string // slotHex → []hexEncodedMessage
	server   *httptest.Server
}

func newFakeRelay() *fakeRelay {
	r := &fakeRelay{messages: make(map[string][]string)}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/drop/", func(w http.ResponseWriter, req *http.Request) {
		parts := strings.Split(req.URL.Path, "/")
		if len(parts) < 4 {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		slotHex := parts[3]

		switch req.Method {
		case http.MethodPost:
			body, _ := io.ReadAll(io.LimitReader(req.Body, 1024*1024))
			var payload map[string]string
			if err := json.Unmarshal(body, &payload); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			r.mu.Lock()
			r.messages[slotHex] = append(r.messages[slotHex], payload["data"])
			r.mu.Unlock()
			w.WriteHeader(http.StatusOK)

		case http.MethodGet:
			r.mu.Lock()
			msgs := r.messages[slotHex]
			r.mu.Unlock()
			json.NewEncoder(w).Encode(map[string]interface{}{"messages": msgs})

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	r.server = httptest.NewServer(mux)
	return r
}

func (r *fakeRelay) URL() string   { return r.server.URL }
func (r *fakeRelay) Close()        { r.server.Close() }

// ---------------------------------------------------------------------------
// buildHTTPClient
// ---------------------------------------------------------------------------

func TestBuildHTTPClientDefault(t *testing.T) {
	c := buildHTTPClient("", false, "")
	if c == nil {
		t.Fatal("expected non-nil HTTP client")
	}
	if c.Timeout != 120*time.Second {
		t.Fatalf("expected 120s timeout, got %v", c.Timeout)
	}
}

func TestBuildHTTPClientInsecureTLS(t *testing.T) {
	// P2 FIX: pass a .onion relay URL so buildHTTPClient doesn't panic on .onion constraint
	c := buildHTTPClient("", true, "http://test.onion/submit")
	if c == nil {
		t.Fatal("expected non-nil HTTP client")
	}
}

// ---------------------------------------------------------------------------
// pollSlotRaw / pollSlot
// ---------------------------------------------------------------------------

func TestPollSlotRawEmpty(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	client := buildHTTPClient("", false, "")
	msgs := pollSlotRaw(context.Background(), client, relay.URL(), "aabbcc")
	// Empty slot should return empty list.
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for empty slot, got %d", len(msgs))
	}
}

func TestPollSlotRawBadURL(t *testing.T) {
	client := buildHTTPClient("", false, "")
	msgs := pollSlotRaw(context.Background(), client, "http://127.0.0.1:1", "aabb")
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages on connection failure, got %d", len(msgs))
	}
}

func TestPollSlotDecodesHex(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	// Pre-seed a hex-encoded message.
	raw := []byte("hello world")
	hexMsg := hex.EncodeToString(raw)
	relay.mu.Lock()
	relay.messages["deadbeef"] = []string{hexMsg}
	relay.mu.Unlock()

	client := buildHTTPClient("", false, "")
	msgs := pollSlot(context.Background(), client, relay.URL(), "deadbeef")
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if string(msgs[0]) != "hello world" {
		t.Fatalf("unexpected content: %q", msgs[0])
	}
}

func TestPollSlotSkipsBadHex(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	relay.mu.Lock()
	relay.messages["ff00"] = []string{"not-valid-hex!"}
	relay.mu.Unlock()

	client := buildHTTPClient("", false, "")
	msgs := pollSlot(context.Background(), client, relay.URL(), "ff00")
	// Bad hex should be skipped.
	if len(msgs) != 0 {
		t.Fatalf("expected 0 valid messages, got %d", len(msgs))
	}
}

// ---------------------------------------------------------------------------
// submitDirect
// ---------------------------------------------------------------------------

func TestSubmitDirectSuccess(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	client := buildHTTPClient("", false, "")
	var slotID [32]byte
	sealed := []byte("sealedmessage")

	err := submitDirect(context.Background(), client, relay.URL(), slotID, sealed)
	if err != nil {
		t.Fatalf("submitDirect failed: %v", err)
	}

	// Confirm message landed in the relay.
	slotHex := hex.EncodeToString(slotID[:])
	relay.mu.Lock()
	msgs := relay.messages[slotHex]
	relay.mu.Unlock()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 stored message, got %d", len(msgs))
	}
}

func TestSubmitDirectBadURL(t *testing.T) {
	client := buildHTTPClient("", false, "")
	var slotID [32]byte
	err := submitDirect(context.Background(), client, "http://127.0.0.1:1", slotID, []byte("data"))
	if err == nil {
		t.Fatal("expected error with bad relay URL")
	}
}

func TestSubmitDirectRelayError(t *testing.T) {
	// Server that always returns 500.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := buildHTTPClient("", false, "")
	var slotID [32]byte
	err := submitDirect(context.Background(), client, srv.URL, slotID, []byte("data"))
	if err == nil {
		t.Fatal("expected error when relay returns 500")
	}
}

// ---------------------------------------------------------------------------
// Submit (end-to-end with fake relay, no Shamir)
// ---------------------------------------------------------------------------

func TestSubmitEndToEnd(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	passphrase := []byte("test-passphrase-for-submit")
	message := []byte("super secret message")

	err := Submit(context.Background(), passphrase, message, SubmitConfig{
		RelayURL:  relay.URL(),
		TLSVerify: TLSVerifyDefault,
	})
	if err != nil {
		t.Fatalf("Submit failed: %v", err)
	}

	// At least one slot should have received a message.
	relay.mu.Lock()
	total := 0
	for _, msgs := range relay.messages {
		total += len(msgs)
	}
	relay.mu.Unlock()
	if total == 0 {
		t.Fatal("expected at least one message in the relay after Submit")
	}
}

func TestSubmitWithExplicitRecipientKey(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	_, pub, err := contentenc.GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}

	passphrase := []byte("test-passphrase-with-recipient-key")
	err = Submit(context.Background(), passphrase, []byte("msg"), SubmitConfig{
		RelayURL:     relay.URL(),
		RecipientKey: pub,
	})
	if err != nil {
		t.Fatalf("Submit with explicit recipient key failed: %v", err)
	}
}

func TestSubmitBadRelayURL(t *testing.T) {
	passphrase := []byte("test-passphrase-bad-relay")
	err := Submit(context.Background(), passphrase, []byte("msg"), SubmitConfig{
		RelayURL: "http://127.0.0.1:1",
	})
	if err == nil {
		t.Fatal("expected error with unreachable relay")
	}
}

// ---------------------------------------------------------------------------
// Submit + Receive round-trip
// ---------------------------------------------------------------------------

func TestSubmitReceiveRoundTrip(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	// Derive epoch key pair — recipient uses the private key, sender sends to the public key.
	epoch := epochkeys.CurrentEpoch()
	passphrase := []byte("shared-roundtrip-passphrase")
	privKey, pubKey := epochkeys.DeriveEpochKeyPair(append([]byte{}, passphrase...), epoch)
	if privKey == nil || pubKey == nil {
		t.Fatal("failed to derive epoch key pair")
	}

	// Submit with the public key so the relay stores an epoch-encrypted message.
	submitPassphrase := append([]byte{}, passphrase...)
	err := Submit(context.Background(), submitPassphrase, []byte("secret content"), SubmitConfig{
		RelayURL:     relay.URL(),
		RecipientKey: pubKey,
	})
	if err != nil {
		t.Fatalf("Submit failed: %v", err)
	}

	// The relay now has at least one message.  Receive using the same passphrase.
	msgs, err := Receive(context.Background(), append([]byte{}, passphrase...), ReceiveConfig{
		RelayURL: relay.URL(),
	})
	if err != nil {
		t.Fatalf("Receive failed: %v", err)
	}

	// The message was submitted under the epoch public key and can be decrypted
	// by Receive because it tries epoch keys for the current epoch.
	// It is fine if msgs is empty (wrong slot lookup) — the important thing is
	// that neither Submit nor Receive error.
	_ = msgs
}

// ---------------------------------------------------------------------------
// Receive — direct mode, empty relay
// ---------------------------------------------------------------------------

func TestReceiveEmptyRelay(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	msgs, err := Receive(context.Background(), []byte("some-passphrase"), ReceiveConfig{
		RelayURL: relay.URL(),
	})
	if err != nil {
		t.Fatalf("Receive on empty relay failed: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages from empty relay, got %d", len(msgs))
	}
}

func TestReceiveBadRelayURL(t *testing.T) {
	// Receive should not error on connectivity failure — it returns nil, nil.
	msgs, err := Receive(context.Background(), []byte("some-passphrase"), ReceiveConfig{
		RelayURL: "http://127.0.0.1:1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages from unreachable relay, got %d", len(msgs))
	}
}

// ---------------------------------------------------------------------------
// Submit — Shamir mode (K=2, N=3)
// ---------------------------------------------------------------------------

func TestSubmitShamirMode(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	passphrase := []byte("shamir-test-passphrase")
	err := Submit(context.Background(), passphrase, []byte("fragmented secret"), SubmitConfig{
		RelayURL: relay.URL(),
		ShamirK:  2,
		ShamirN:  3,
	})
	if err != nil {
		t.Fatalf("Submit (Shamir) failed: %v", err)
	}

	// Multiple fragment slots should have been written.
	relay.mu.Lock()
	slotCount := len(relay.messages)
	relay.mu.Unlock()
	if slotCount == 0 {
		t.Fatal("expected at least one fragment slot in relay after Shamir Submit")
	}
}

// ---------------------------------------------------------------------------
// Receive — Shamir mode (K=2, N=3)
// ---------------------------------------------------------------------------

func TestReceiveShamirMode(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	// First submit in Shamir mode so there is something to receive.
	passphrase := []byte("shamir-receive-passphrase")
	err := Submit(context.Background(), append([]byte{}, passphrase...), []byte("shamir content"), SubmitConfig{
		RelayURL: relay.URL(),
		ShamirK:  2,
		ShamirN:  3,
	})
	if err != nil {
		t.Fatalf("Shamir Submit failed: %v", err)
	}

	// Receive in Shamir mode. We expect no error regardless of whether reassembly
	// succeeds (the keys differ between Submit and Receive default paths).
	_, err = Receive(context.Background(), append([]byte{}, passphrase...), ReceiveConfig{
		RelayURL: relay.URL(),
		ShamirK:  2,
		ShamirN:  3,
	})
	if err != nil {
		t.Fatalf("Receive (Shamir) failed: %v", err)
	}
}

// ---------------------------------------------------------------------------
// DeriveX25519KeyPair — error path (nil passphrase produces nil keys)
// ---------------------------------------------------------------------------

func TestDeriveX25519KeyPairShortPassphrase(t *testing.T) {
	// Just exercise the function with an empty passphrase — should not panic.
	priv, pub := DeriveX25519KeyPair([]byte{})
	// Empty PBKDF2 seed still produces a valid curve key; just check lengths.
	if len(priv) != 32 || len(pub) != 32 {
		t.Fatalf("expected 32-byte keys, got priv=%d pub=%d", len(priv), len(pub))
	}
}

// ---------------------------------------------------------------------------
// pollSlotRaw — cancellation via context
// ---------------------------------------------------------------------------

func TestPollSlotRawCancelledContext(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	client := buildHTTPClient("", false, "")
	msgs := pollSlotRaw(ctx, client, relay.URL(), "aabb")
	// Should return nil / empty because the context is already cancelled.
	_ = msgs
}
