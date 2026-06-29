package sender

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Hardening characterization tests — lock the typed-error contract introduced
// for production observability + retry policy decisions in callers.
//
// Discipline: tests below MUST keep using `errors.Is` with the sentinels.
// If the contract changes, update the sentinel name AND every caller that
// pattern-matches on the error.

func TestAntiTrace_RateLimited_TypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	res := c.Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if !errors.Is(res.Error, ErrAntiTraceRateLimited) {
		t.Errorf("want ErrAntiTraceRateLimited, got %v", res.Error)
	}
}

func TestAntiTrace_HTTPStatus_TypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"internal"}`))
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	res := c.Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if !errors.Is(res.Error, ErrAntiTraceHTTPStatus) {
		t.Errorf("want ErrAntiTraceHTTPStatus, got %v", res.Error)
	}
	// Body should be in the error message for debugging
	if !strings.Contains(res.Error.Error(), "internal") {
		t.Errorf("error should include response body, got %v", res.Error)
	}
}

func TestAntiTrace_TransportError_TypedError(t *testing.T) {
	// Connect to closed port → http.Client.Do fails
	c := NewAntiTraceClient("http://127.0.0.1:1", "tok")
	res := c.Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if !errors.Is(res.Error, ErrAntiTraceTransport) {
		t.Errorf("want ErrAntiTraceTransport, got %v", res.Error)
	}
}

func TestAntiTrace_BadURL_RequestError(t *testing.T) {
	// http.NewRequestWithContext fails for control chars in URL
	c := NewAntiTraceClient("http://example.com\x00bad", "tok")
	res := c.Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if !errors.Is(res.Error, ErrAntiTraceRequest) {
		t.Errorf("want ErrAntiTraceRequest, got %v", res.Error)
	}
}

func TestAntiTrace_MailboxUsed_ResolvedFromAddr(t *testing.T) {
	// HARDENING: MailboxUsed must reflect the actual sender address used
	// (req.SMTPUsername wins over c.fromAddr per resolution order in Send).
	// Pre-fix: c.fromAddr was used directly → could be stale if not mutated.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"envelope_id":"env-1","status":"queued"}`))
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	res := c.Send(context.Background(), SendRequest{
		ToAddress:    "to@x.cz",
		SMTPUsername: "actual-mailbox@firma.cz", // wins per resolution order
	})
	if res.Error != nil {
		t.Fatalf("unexpected error: %v", res.Error)
	}
	if res.MailboxUsed != "actual-mailbox@firma.cz" {
		t.Errorf("MailboxUsed = %q, want resolved fromAddr 'actual-mailbox@firma.cz'", res.MailboxUsed)
	}
}

// F3-3: 2xx with non-JSON body now returns ErrAntiTraceEmptyEnvelope so
// the caller can retry. Pre-fix this returned nil error + empty
// MessageID, which then flowed into send_events.message_id="" and broke
// later DSN-bounce dedupe.
func TestAntiTrace_NonJSONResponse_ReturnsEmptyEnvelopeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`not-json-at-all`))
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	res := c.Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if res.Error == nil {
		t.Fatal("expected ErrAntiTraceEmptyEnvelope on non-JSON 2xx, got nil")
	}
	if !errors.Is(res.Error, ErrAntiTraceEmptyEnvelope) {
		t.Errorf("expected ErrAntiTraceEmptyEnvelope, got %v", res.Error)
	}
	if res.MessageID != "" {
		t.Errorf("MessageID must be empty on error, got %q", res.MessageID)
	}
}

func TestDomainOf(t *testing.T) {
	cases := []struct {
		email, want string
	}{
		{"jan@firma.cz", "firma.cz"},
		{"info@sub.firma.cz", "sub.firma.cz"},
		{"plain", ""},
		{"", ""},
		{"@", ""},
		{"user@", ""},
		{"x@y@z", "z"}, // last @ wins (defensive)
	}
	for _, tc := range cases {
		got := domainOf(tc.email)
		if got != tc.want {
			t.Errorf("domainOf(%q) = %q, want %q", tc.email, got, tc.want)
		}
	}
}
