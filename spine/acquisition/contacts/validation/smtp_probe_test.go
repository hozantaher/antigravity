package validation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// relayStub mimics anti-trace-relay /v1/verify with a scripted response.
type relayStub struct {
	status     string
	reason     string
	httpStatus int // if non-zero, overrides 200
	delay      time.Duration
	wantToken  string
	calls      int
	lastEmail  string
}

func (s *relayStub) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.calls++
		if s.wantToken != "" {
			auth := r.Header.Get("Authorization")
			if auth != "Bearer "+s.wantToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
		var req verifyRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.lastEmail = req.Email

		if s.delay > 0 {
			time.Sleep(s.delay)
		}

		if s.httpStatus != 0 {
			w.WriteHeader(s.httpStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(verifyResponse{
			Status: s.status,
			Reason: s.reason,
		})
	}
}

func newRelay(t *testing.T, stub *relayStub) *httptest.Server {
	t.Helper()
	return httptest.NewServer(stub.handler())
}

// ── SMTPProbeValidator ────────────────────────────────────────────────────────

func TestSMTPProbe_NoDomain(t *testing.T) {
	v := &SMTPProbeValidator{RelayURL: "http://x"}
	ok, detail, err := v.Validate(context.Background(), "nodomain")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || detail != "no domain" {
		t.Errorf("ok=%v detail=%q", ok, detail)
	}
}

func TestSMTPProbe_NoRelayURL_ReturnsDisabled(t *testing.T) {
	v := &SMTPProbeValidator{}
	ok, detail, err := v.Validate(context.Background(), "user@example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || detail != "verify_disabled" {
		t.Errorf("expected (false, verify_disabled), got ok=%v detail=%q", ok, detail)
	}
}

func TestSMTPProbe_WhitespaceRelayURL_ReturnsDisabled(t *testing.T) {
	v := &SMTPProbeValidator{RelayURL: "   "}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok || detail != "verify_disabled" {
		t.Errorf("expected disabled for whitespace-only URL, got %v %q", ok, detail)
	}
}

func TestSMTPProbe_Valid(t *testing.T) {
	stub := &relayStub{status: "valid", reason: "mailbox accepted"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL, Timeout: 2 * time.Second}
	ok, detail, err := v.Validate(context.Background(), "user@example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Errorf("expected ok=true for valid status")
	}
	if detail != "mailbox accepted" {
		t.Errorf("expected reason passthrough, got %q", detail)
	}
	if stub.lastEmail != "user@example.com" {
		t.Errorf("relay did not receive email: %q", stub.lastEmail)
	}
}

func TestSMTPProbe_Invalid(t *testing.T) {
	stub := &relayStub{status: "invalid", reason: "rcpt rejected"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok {
		t.Error("expected ok=false for invalid status")
	}
	if detail != "rcpt rejected" {
		t.Errorf("expected reason passthrough, got %q", detail)
	}
}

func TestSMTPProbe_Unknown(t *testing.T) {
	stub := &relayStub{status: "unknown", reason: "verify disabled upstream"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok {
		t.Error("expected ok=false for unknown status")
	}
	if !strings.Contains(detail, "verify disabled") {
		t.Errorf("expected reason passthrough, got %q", detail)
	}
}

func TestSMTPProbe_UnknownStatusValue(t *testing.T) {
	stub := &relayStub{status: "weird"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok {
		t.Error("expected ok=false for unrecognized status")
	}
	if !strings.HasPrefix(detail, "unknown status") {
		t.Errorf("expected 'unknown status' prefix, got %q", detail)
	}
}

func TestSMTPProbe_Http500(t *testing.T) {
	stub := &relayStub{httpStatus: http.StatusInternalServerError}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok {
		t.Error("expected ok=false on 500")
	}
	if !strings.HasPrefix(detail, "relay http 500") {
		t.Errorf("expected 'relay http 500' prefix, got %q", detail)
	}
}

func TestSMTPProbe_BearerTokenPropagated(t *testing.T) {
	stub := &relayStub{status: "valid", wantToken: "secret-xyz"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL, RelayToken: "secret-xyz"}
	ok, _, _ := v.Validate(context.Background(), "user@example.com")
	if !ok {
		t.Error("expected ok=true when token matches")
	}
}

func TestSMTPProbe_BearerTokenMismatch_Http401(t *testing.T) {
	stub := &relayStub{wantToken: "correct"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL, RelayToken: "wrong"}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok {
		t.Error("expected ok=false on 401")
	}
	if !strings.Contains(detail, "401") {
		t.Errorf("expected 401 in detail, got %q", detail)
	}
}

func TestSMTPProbe_DecodeFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "not-json")
	}))
	defer srv.Close()

	v := &SMTPProbeValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok || detail != "decode failed" {
		t.Errorf("expected decode failed, got ok=%v detail=%q", ok, detail)
	}
}

func TestSMTPProbe_ContextCancelled(t *testing.T) {
	stub := &relayStub{status: "valid", delay: 500 * time.Millisecond}
	srv := newRelay(t, stub)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before call

	v := &SMTPProbeValidator{RelayURL: srv.URL, Timeout: 2 * time.Second}
	ok, detail, _ := v.Validate(ctx, "user@example.com")
	if ok {
		t.Error("expected ok=false with cancelled context")
	}
	if !strings.HasPrefix(detail, "relay error") {
		t.Errorf("expected 'relay error' prefix, got %q", detail)
	}
}

func TestSMTPProbe_TrailingSlashInURL(t *testing.T) {
	stub := &relayStub{status: "valid"}
	srv := newRelay(t, stub)
	defer srv.Close()

	// URL with trailing slash must still resolve to /v1/verify correctly.
	v := &SMTPProbeValidator{RelayURL: srv.URL + "/"}
	ok, _, _ := v.Validate(context.Background(), "user@example.com")
	if !ok {
		t.Error("expected trailing slash URL to be handled")
	}
}

func TestSMTPProbe_DefaultTimeoutApplied(t *testing.T) {
	stub := &relayStub{status: "valid"}
	srv := newRelay(t, stub)
	defer srv.Close()

	// Timeout=0 → default 10s applied internally; call should succeed.
	v := &SMTPProbeValidator{RelayURL: srv.URL}
	ok, _, _ := v.Validate(context.Background(), "user@example.com")
	if !ok {
		t.Error("expected ok=true with default timeout")
	}
}

func TestSMTPProbe_Name(t *testing.T) {
	v := &SMTPProbeValidator{}
	if v.Name() != "smtp_probe" {
		t.Errorf("unexpected name: %q", v.Name())
	}
}

// ── CatchAllValidator ─────────────────────────────────────────────────────────

func TestCatchAll_NoDomain(t *testing.T) {
	v := &CatchAllValidator{}
	ok, _, _ := v.Validate(context.Background(), "nodomain")
	if !ok {
		t.Error("no-domain input should return true (assume not catch-all)")
	}
}

func TestCatchAll_RelayRejectsFakeAddr_NotCatchAll(t *testing.T) {
	// Relay returns 'invalid' for the fake address → domain is NOT catch-all.
	stub := &relayStub{status: "invalid", reason: "rcpt rejected"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &CatchAllValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if !ok {
		t.Errorf("expected ok=true (not catch-all) when relay rejects fake, got ok=%v detail=%q", ok, detail)
	}
	if detail != "not catch-all" {
		t.Errorf("expected detail='not catch-all', got %q", detail)
	}
}

func TestCatchAll_RelayAcceptsFakeAddr_IsCatchAll(t *testing.T) {
	// Relay returns 'valid' for the fake address → domain is catch-all.
	stub := &relayStub{status: "valid"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &CatchAllValidator{RelayURL: srv.URL}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if ok {
		t.Errorf("expected ok=false (catch-all) when relay accepts fake, got detail=%q", detail)
	}
	if detail != "catch-all domain detected" {
		t.Errorf("expected detail='catch-all domain detected', got %q", detail)
	}
}

func TestCatchAll_NoRelayURL_NotCatchAll(t *testing.T) {
	// No relay configured → inner probe returns "verify_disabled" (ok=false)
	// → CatchAllValidator treats that as "not catch-all".
	v := &CatchAllValidator{}
	ok, detail, _ := v.Validate(context.Background(), "user@example.com")
	if !ok {
		t.Errorf("expected ok=true when relay disabled, got detail=%q", detail)
	}
}

func TestCatchAll_PropagatesTokenAndURL(t *testing.T) {
	stub := &relayStub{status: "invalid", wantToken: "cat-token"}
	srv := newRelay(t, stub)
	defer srv.Close()

	v := &CatchAllValidator{RelayURL: srv.URL, RelayToken: "cat-token"}
	ok, _, _ := v.Validate(context.Background(), "user@example.com")
	if !ok {
		t.Error("expected ok=true (not catch-all) when token + URL propagate correctly")
	}
	if stub.calls != 1 {
		t.Errorf("expected exactly 1 relay call, got %d", stub.calls)
	}
	// Fake address uses xq7zk9m3p2w@<domain> prefix.
	if !strings.HasPrefix(stub.lastEmail, "xq7zk9m3p2w@") {
		t.Errorf("expected fake-address prefix, got %q", stub.lastEmail)
	}
}

func TestCatchAll_Name(t *testing.T) {
	v := &CatchAllValidator{}
	if v.Name() != "catchall" {
		t.Errorf("unexpected name: %q", v.Name())
	}
}
