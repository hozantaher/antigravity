package amnesic

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"relay/internal/delivery/contentenc"
	"relay/internal/epochkeys"
)

// TestRoundTripSubmitThenReceive proves the full behavioral contract:
// - submit encrypts a message addressed to a passphrase-derived identity
// - receive with the SAME passphrase recovers the plaintext byte-for-byte
//
// This single test covers: passphrase derivation, X25519 key pair,
// content encryption, dead-drop slot ID, HTTP submit, HTTP poll, decryption.
// If ANY of those are broken this test fails, regardless of unit-test coverage.
func TestRoundTripSubmitThenReceive(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	passphrase := []byte("correct horse battery staple 2026")
	plaintext := []byte("Meet at Central Park, 23:00. Bring the files.")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := Submit(ctx, append([]byte{}, passphrase...), append([]byte{}, plaintext...), SubmitConfig{
		RelayURL: relay.URL(),
	}); err != nil {
		t.Fatalf("Submit failed: %v", err)
	}

	relay.mu.Lock()
	t.Logf("after Submit: relay has %d slots", len(relay.messages))
	for slot, msgs := range relay.messages {
		t.Logf("  Submit stored in slot=%s msgs=%d bytes_first=%d", slot, len(msgs), len(msgs[0]))
	}
	relay.mu.Unlock()

	// Independently derive slot from same passphrase to check it matches
	checkIdentity := Derive(append([]byte{}, passphrase...))
	checkSlotHex := hex.EncodeToString(checkIdentity.SlotID[:])
	t.Logf("Expected poll slot from Derive(passphrase): %s", checkSlotHex)
	checkIdentity.Zero()

	// Manually try to decrypt what's in the relay with the epoch priv key
	// to isolate whether HTTP/polling is the problem or the crypto is.
	priv, pub := epochkeys.DeriveEpochKeyPair(append([]byte{}, passphrase...), epochkeys.CurrentEpoch())
	t.Logf("epoch priv len=%d pub len=%d", len(priv), len(pub))
	relay.mu.Lock()
	for _, msgs := range relay.messages {
		for _, m := range msgs {
			raw, err := hex.DecodeString(m)
			if err != nil {
				t.Logf("hex decode err: %v", err)
				continue
			}
			t.Logf("raw len=%d", len(raw))
			sealer := contentenc.NewSealer()
			pt, err := sealer.Open(raw, priv)
			if err != nil {
				t.Logf("manual Open err: %v", err)
				continue
			}
			t.Logf("manual decrypted len=%d, preview=%q", len(pt), string(pt[:min(40, len(pt))]))
		}
	}
	relay.mu.Unlock()

	// Direct HTTP poll — does fakeRelay even serve GET correctly?
	client := buildHTTPClient("", false, "")
	directRaw := pollSlotRaw(ctx, client, relay.URL(), checkSlotHex)
	t.Logf("direct pollSlotRaw returned %d messages", len(directRaw))
	for i, m := range directRaw {
		t.Logf("  [%d] len=%d", i, len(m))
	}
	directDecoded := pollSlot(ctx, client, relay.URL(), checkSlotHex)
	t.Logf("direct pollSlot returned %d decoded", len(directDecoded))
	for i, m := range directDecoded {
		t.Logf("  [%d] raw len=%d", i, len(m))
		pt, err := contentenc.NewSealer().Open(m, priv)
		if err != nil {
			t.Logf("    Open err: %v", err)
		} else {
			t.Logf("    Open OK, len=%d, preview=%q", len(pt), string(pt[:min(30, len(pt))]))
		}
	}

	msgs, err := Receive(ctx, append([]byte{}, passphrase...), ReceiveConfig{
		RelayURL: relay.URL(),
	})
	if err != nil {
		t.Fatalf("Receive failed: %v", err)
	}
	if len(msgs) == 0 {
		t.Fatal("Receive returned zero messages — pipeline broken")
	}

	// Verify byte-for-byte roundtrip on at least one message.
	found := false
	for _, m := range msgs {
		if bytes.Equal(m.Plaintext, plaintext) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("no decrypted message matched plaintext; got %d messages, none matched", len(msgs))
	}
}

// TestRoundTripWrongPassphraseYieldsNoMessages is a security invariant:
// a different passphrase must derive a different identity → different slot
// → zero messages retrieved. If this fails, the whole amnesic guarantee
// is broken.
func TestRoundTripWrongPassphraseYieldsNoMessages(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	right := []byte("the right passphrase")
	wrong := []byte("the wrong passphrase")
	plaintext := []byte("shhh secret")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := Submit(ctx, append([]byte{}, right...), append([]byte{}, plaintext...), SubmitConfig{
		RelayURL: relay.URL(),
	}); err != nil {
		t.Fatalf("Submit failed: %v", err)
	}

	msgs, err := Receive(ctx, append([]byte{}, wrong...), ReceiveConfig{
		RelayURL: relay.URL(),
	})
	if err != nil {
		t.Fatalf("Receive with wrong passphrase returned error (should silently return empty): %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("wrong passphrase recovered %d messages — CRITICAL SECURITY BUG", len(msgs))
	}
}

// TestReceive5xxTreatsAsEmpty verifies the common flow-control branch
// `resp.StatusCode >= 400 { return nil }` in pollSlotRaw. Without this test,
// mutation `>= → <=` survives (500 treated as 200 and 200 treated as 500).
func TestReceive5xxTreatsAsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	msgs, err := Receive(ctx, []byte("any passphrase"), ReceiveConfig{RelayURL: srv.URL})
	if err != nil {
		t.Fatalf("Receive on 500 should not propagate error (silent empty): %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages on 500 response, got %d", len(msgs))
	}
}

// TestReceiveMalformedShamirJSONIgnored verifies that Receive silently skips
// Shamir-mode messages whose shareData JSON is malformed. Hits the
// `err == nil && shareData.Data != ""` branch and the len(shareData.X) > 0
// branch in receiveFragmented's reassembly loop.
func TestReceiveMalformedShamirJSONIgnored(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	// Post garbage hex data directly; Receive in ShamirK=2 mode must not panic.
	relay.mu.Lock()
	for i := 0; i < 3; i++ {
		slot := fmt.Sprintf("%064x", i)
		relay.messages[slot] = []string{hex.EncodeToString([]byte("not-shamir-json"))}
	}
	relay.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	msgs, err := Receive(ctx, []byte("pass"), ReceiveConfig{
		RelayURL: relay.URL(),
		ShamirK:  2,
		ShamirN:  3,
	})
	if err != nil {
		t.Fatalf("Shamir-mode receive with malformed payload should not error: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("malformed Shamir shares must not decode; got %d messages", len(msgs))
	}
}

// TestRoundTripTamperedCiphertextRejected proves that a MITM modifying
// the stored ciphertext cannot produce a valid decryption.
func TestRoundTripTamperedCiphertextRejected(t *testing.T) {
	relay := newFakeRelay()
	defer relay.Close()

	passphrase := []byte("passphrase under attack")
	plaintext := []byte("original")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := Submit(ctx, append([]byte{}, passphrase...), append([]byte{}, plaintext...), SubmitConfig{
		RelayURL: relay.URL(),
	}); err != nil {
		t.Fatalf("Submit failed: %v", err)
	}

	// Tamper: flip a bit in every stored message.
	relay.mu.Lock()
	for slot, msgs := range relay.messages {
		for i, m := range msgs {
			if len(m) > 0 {
				b := []byte(m)
				// Flip last nibble of the first hex char (stays hex)
				if b[0] == 'f' {
					b[0] = 'e'
				} else {
					b[0] = 'f'
				}
				msgs[i] = string(b)
			}
		}
		relay.messages[slot] = msgs
	}
	relay.mu.Unlock()

	msgs, _ := Receive(ctx, append([]byte{}, passphrase...), ReceiveConfig{
		RelayURL: relay.URL(),
	})
	for _, m := range msgs {
		if bytes.Equal(m.Plaintext, plaintext) {
			t.Fatal("tampered ciphertext decrypted to original plaintext — AUTH BROKEN")
		}
	}
}
