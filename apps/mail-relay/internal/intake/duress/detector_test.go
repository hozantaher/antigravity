package duress

import (
	"relay/internal/amnesic"
	"relay/internal/ephemeral"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/quick"
	"time"
)

func TestNewDetector(t *testing.T) {
	d := NewDetector("https://example.com", nil)
	if d == nil {
		t.Fatal("NewDetector returned nil")
	}
	if d.relayURL != "https://example.com" {
		t.Errorf("relayURL = %q, want https://example.com", d.relayURL)
	}
	if d.onDuress != nil {
		t.Error("onDuress should be nil when passed nil")
	}
}

func TestNewDetectorWithCallback(t *testing.T) {
	called := false
	cb := func() { called = true }
	d := NewDetector("https://r", cb)
	if d.onDuress == nil {
		t.Fatal("onDuress should not be nil")
	}
	d.onDuress()
	if !called {
		t.Error("callback not invoked")
	}
}

func TestCheckSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/healthz" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		// Verify challenge headers present
		if r.Header.Get("X-Auth-Challenge") == "" {
			t.Error("missing X-Auth-Challenge header")
		}
		if r.Header.Get("X-Auth-Signature") == "" {
			t.Error("missing X-Auth-Signature header")
		}
		if r.Header.Get("X-Auth-PublicKey") == "" {
			t.Error("missing X-Auth-PublicKey header")
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	duressCalled := false
	d := NewDetector(srv.URL, func() { duressCalled = true })
	identity := amnesic.Derive([]byte("test passphrase real"))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ok := d.Check(ctx, identity)
	if !ok {
		t.Error("Check returned false on 200 OK response")
	}
	if duressCalled {
		t.Error("duress callback fired on success")
	}
}

func TestCheckServerReject(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	duressCalled := false
	d := NewDetector(srv.URL, func() { duressCalled = true })
	identity := amnesic.Derive([]byte("wrong passphrase"))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ok := d.Check(ctx, identity)
	if ok {
		t.Error("Check returned true on 401")
	}
	if !duressCalled {
		t.Error("duress callback did not fire on server reject")
	}
}

func TestCheckNetworkFailure(t *testing.T) {
	duressCalled := false
	d := NewDetector("http://127.0.0.1:1", func() { duressCalled = true }) // closed port
	identity := amnesic.Derive([]byte("test"))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	ok := d.Check(ctx, identity)
	if ok {
		t.Error("Check returned true on network failure")
	}
	if !duressCalled {
		t.Error("duress callback did not fire on network error")
	}
}

func TestCheckInvalidURL(t *testing.T) {
	duressCalled := false
	// NewRequestWithContext fails on invalid URL (contains control char)
	d := NewDetector("http://\x00invalid", func() { duressCalled = true })
	identity := amnesic.Derive([]byte("test"))

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	ok := d.Check(ctx, identity)
	if ok {
		t.Error("Check returned true on invalid URL")
	}
	if !duressCalled {
		t.Error("duress callback did not fire on invalid URL")
	}
}

func TestCheckNilCallbackSafeOnFailure(t *testing.T) {
	d := NewDetector("http://127.0.0.1:1", nil)
	identity := amnesic.Derive([]byte("test"))

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with nil callback: %v", r)
		}
	}()

	if d.Check(ctx, identity) {
		t.Error("expected false on failure")
	}
}

func TestTriggerDuressZeroesIdentity(t *testing.T) {
	d := NewDetector("http://example.com", nil)
	identity := amnesic.Derive([]byte("some passphrase"))

	// Capture signing key length prior
	if identity.SigningKey.Len() != 64 {
		t.Fatalf("expected 64-byte signing key, got %d", identity.SigningKey.Len())
	}

	d.triggerDuress(identity)

	// After Zero(), the SecureBuffer should be wiped / length 0 or zeroed bytes.
	// We rely on amnesic's Zero() contract; accessing bytes after Zero may
	// return zeroed content or zero-length. Just verify it does not panic.
	bytes := identity.SigningKey.Bytes()
	for _, b := range bytes {
		if b != 0 {
			t.Fatalf("signing key not zeroed: found non-zero byte %x", b)
		}
	}
}

// TestCheck_ShortSigningKey covers the branch: len(signKeyBytes) < ed25519.PrivateKeySize.
// We fabricate a DerivedIdentity whose SigningKey buffer is shorter than 64 bytes
// so that the size-guard fires, triggering duress and returning false.
func TestCheck_ShortSigningKey_ReturnsFalse(t *testing.T) {
	duressCalled := false
	d := NewDetector("http://127.0.0.1:1", func() { duressCalled = true })

	// Build a DerivedIdentity with a 10-byte signing key (shorter than ed25519.PrivateKeySize=64).
	shortKey := ephemeral.Alloc(10)
	identity := &amnesic.DerivedIdentity{
		SigningKey: shortKey,
		PublicKey:  make([]byte, 32),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	ok := d.Check(ctx, identity)
	if ok {
		t.Error("Check must return false when signing key is too short")
	}
	if !duressCalled {
		t.Error("duress callback must fire when signing key is too short")
	}
}

// TestCheck_ShortSigningKey_NilCallback_Safe verifies no panic when onDuress is nil.
func TestCheck_ShortSigningKey_NilCallback_Safe(t *testing.T) {
	d := NewDetector("http://127.0.0.1:1", nil)

	shortKey := ephemeral.Alloc(10)
	identity := &amnesic.DerivedIdentity{
		SigningKey: shortKey,
		PublicKey:  make([]byte, 32),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with short key and nil callback: %v", r)
		}
	}()

	if d.Check(ctx, identity) {
		t.Error("expected false for short signing key")
	}
}

// TestCheck_NeverPanics_Property monkey-tests Check with arbitrary string inputs
// passed through amnesic.Derive to ensure no panic ever occurs.
func TestCheck_NeverPanics_Property(t *testing.T) {
	// Use a fast-returning server so the property test completes quickly.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := NewDetector(srv.URL, nil)

	f := func(passphrase string) bool {
		defer func() { recover() }()
		identity := amnesic.Derive([]byte(passphrase))
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		d.Check(ctx, identity)
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 5}); err != nil {
		t.Errorf("Check panicked: %v", err)
	}
}

// TestCheck_NeverPanics_NetworkFailure_Property monkey-tests Check with a closed port
// so the network error path is exercised with random inputs.
func TestCheck_NeverPanics_NetworkFailure_Property(t *testing.T) {
	d := NewDetector("http://127.0.0.1:1", nil)

	f := func(passphrase string) bool {
		defer func() { recover() }()
		identity := amnesic.Derive([]byte(passphrase))
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		d.Check(ctx, identity)
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 3}); err != nil {
		t.Errorf("Check panicked on network failure: %v", err)
	}
}
