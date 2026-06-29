package sender

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ─── Header injection ────────────────────────────────────────────────────────

func TestAntiTrace_AuthorizationBearerFormat(t *testing.T) {
	cases := []struct{ token, want string }{
		{"tok-abc", "Bearer tok-abc"},
		{"secret_123", "Bearer secret_123"},
		{"", "Bearer"},
		{"multi word tok", "Bearer multi word tok"},
	}
	for _, c := range cases {
		t.Run(c.token, func(t *testing.T) {
			var gotAuth string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotAuth = r.Header.Get("Authorization")
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(map[string]string{"envelope_id": "e", "status": "ok"})
			}))
			defer srv.Close()

			cli := NewAntiTraceClient(srv.URL, c.token)
			cli.Send(context.Background(), SendRequest{ToAddress: "to@x.cz", Subject: "s", BodyPlain: "b", SMTPUsername: "smtp.cz"})
			if gotAuth != c.want {
				t.Errorf("Authorization = %q, want %q", gotAuth, c.want)
			}
		})
	}
}

func TestAntiTrace_ContentTypeApplicationJSON(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	NewAntiTraceClient(srv.URL, "t").
		Send(context.Background(), SendRequest{ToAddress: "to@x.cz", Subject: "s", BodyPlain: "b", SMTPUsername: "smtp.cz"})
	if got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
}

func TestAntiTrace_POSTToSubmitEndpoint(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	NewAntiTraceClient(srv.URL, "t").
		Send(context.Background(), SendRequest{ToAddress: "to@x.cz", Subject: "s", BodyPlain: "b", SMTPUsername: "smtp.cz"})
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/v1/submit" {
		t.Errorf("path = %q, want /v1/submit", gotPath)
	}
}

// ─── Body shape ──────────────────────────────────────────────────────────────

func TestAntiTrace_BodyShape(t *testing.T) {
	var payload antiTraceRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	req := SendRequest{
		ToAddress:    "alice@example.com",
		Subject:      "Nabídka",
		BodyPlain:    "plain text",
		BodyHTML:     "<p>html</p>",
		SMTPUsername: "sender@firma.cz", // engine injects per-mailbox creds; from_address resolves from this
		SMTPPassword: "pw",
		Headers: map[string]string{
			"Date":       "Tue, 01 Apr 2026 12:00:00 +0200",
			"Message-ID": "<abc@relay.local>",
		},
	}
	NewAntiTraceClient(srv.URL, "t").
		Send(context.Background(), req)

	if payload.Recipient != "alice@example.com" {
		t.Errorf("recipient = %q", payload.Recipient)
	}
	if payload.Subject != "Nabídka" {
		t.Errorf("subject = %q", payload.Subject)
	}
	if payload.Body != "plain text" {
		t.Errorf("body = %q", payload.Body)
	}
	if payload.BodyHTML != "<p>html</p>" {
		t.Errorf("body_html = %q", payload.BodyHTML)
	}
	if payload.FromAddress != "sender@firma.cz" {
		t.Errorf("from_address = %q", payload.FromAddress)
	}
	if payload.Headers["Date"] != "Tue, 01 Apr 2026 12:00:00 +0200" {
		t.Errorf("headers.Date missing / wrong")
	}
}

// ─── HTTP status handling ────────────────────────────────────────────────────

func TestAntiTrace_StatusCodes(t *testing.T) {
	cases := []struct {
		status     int
		wantError  bool
		errContain string
	}{
		{http.StatusOK, false, ""},
		{http.StatusAccepted, false, ""},
		{http.StatusBadRequest, true, "400"},
		{http.StatusUnauthorized, true, "401"},
		{http.StatusForbidden, true, "403"},
		{http.StatusNotFound, true, "404"},
		{http.StatusTooManyRequests, true, "rate limited"},
		{http.StatusInternalServerError, true, "500"},
		{http.StatusBadGateway, true, "502"},
		{http.StatusServiceUnavailable, true, "503"},
		{http.StatusGatewayTimeout, true, "504"},
	}
	for _, c := range cases {
		t.Run(http.StatusText(c.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(`{"envelope_id":"e1","status":"x"}`))
			}))
			defer srv.Close()

			res := NewAntiTraceClient(srv.URL, "t").
				Send(context.Background(), SendRequest{ToAddress: "to@x.cz", Subject: "s", BodyPlain: "b", SMTPUsername: "smtp.cz"})
			if c.wantError {
				if res.Error == nil {
					t.Fatalf("status=%d: expected error", c.status)
				}
				if !strings.Contains(res.Error.Error(), c.errContain) {
					t.Errorf("error %q must contain %q", res.Error.Error(), c.errContain)
				}
			} else {
				if res.Error != nil {
					t.Errorf("status=%d: unexpected error %v", c.status, res.Error)
				}
				if res.MessageID != "e1" {
					t.Errorf("MessageID = %q, want e1", res.MessageID)
				}
			}
		})
	}
}

// ─── Response body handling ──────────────────────────────────────────────────

func TestAntiTrace_EnvelopeIDReturned(t *testing.T) {
	cases := []string{"env-1", "uuid-abc-123", "x", ""}
	for _, env := range cases {
		t.Run(fmt.Sprintf("env=%q", env), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(map[string]string{"envelope_id": env, "status": "queued"})
			}))
			defer srv.Close()

			res := NewAntiTraceClient(srv.URL, "t").
				Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
			if res.MessageID != env {
				t.Errorf("MessageID = %q want %q", res.MessageID, env)
			}
		})
	}
}

func TestAntiTrace_StatusFieldReturned(t *testing.T) {
	cases := []string{"queued", "accepted", "sent", "ok"}
	for _, st := range cases {
		t.Run(st, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(map[string]string{"envelope_id": "e", "status": st})
			}))
			defer srv.Close()
			res := NewAntiTraceClient(srv.URL, "t").
				Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
			if res.SMTPResponse != st {
				t.Errorf("SMTPResponse = %q want %q", res.SMTPResponse, st)
			}
		})
	}
}

// F3-3 (2026-04-29): pre-fix this test asserted "no error" for empty /
// non-JSON / wrong-shape 2xx bodies — the relay-contract drift was
// flowing through to send_events.message_id="" and breaking later
// DSN-bounce dedupe. Now we assert ErrAntiTraceEmptyEnvelope so the
// caller (Engine.Run / runner.RunCampaign) retries instead of
// committing a half-broken send.
func TestAntiTrace_InvalidJSONReturnsEmptyEnvelopeError(t *testing.T) {
	payloads := []string{
		"",
		"not json",
		"{",
		"null",
		"[1,2,3]",
		`{"envelope_id":123}`,           // wrong type — JSON unmarshal fails
		`{"envelope_id":""}`,             // empty string explicitly
		`{}`,                             // missing envelope_id
		`{"status":"ok"}`,                // status without envelope_id
	}
	for _, p := range payloads {
		t.Run(p, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusAccepted)
				_, _ = w.Write([]byte(p))
			}))
			defer srv.Close()
			res := NewAntiTraceClient(srv.URL, "t").
				Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
			if res.Error == nil {
				t.Errorf("payload %q: expected ErrAntiTraceEmptyEnvelope, got nil error + MessageID=%q", p, res.MessageID)
				return
			}
			if !errors.Is(res.Error, ErrAntiTraceEmptyEnvelope) {
				t.Errorf("payload %q: expected ErrAntiTraceEmptyEnvelope, got %v", p, res.Error)
			}
			if res.MessageID != "" {
				t.Errorf("payload %q: MessageID must be empty on error, got %q", p, res.MessageID)
			}
		})
	}
}

// ─── Context cancellation ────────────────────────────────────────────────────

func TestAntiTrace_ContextCanceled(t *testing.T) {
	handlerDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-handlerDone:
		}
	}))
	defer func() { close(handlerDone); srv.Close() }()

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()

	res := NewAntiTraceClient(srv.URL, "t").
		Send(ctx, SendRequest{ToAddress: "to@x.cz"})
	if res.Error == nil {
		t.Fatal("expected cancellation error")
	}
}

func TestAntiTrace_ContextTimeout(t *testing.T) {
	handlerDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(200 * time.Millisecond):
			w.WriteHeader(http.StatusAccepted)
		case <-r.Context().Done():
		case <-handlerDone:
		}
	}))
	defer func() { close(handlerDone); srv.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	res := NewAntiTraceClient(srv.URL, "t").
		Send(ctx, SendRequest{ToAddress: "to@x.cz"})
	if res.Error == nil {
		t.Fatal("expected timeout error")
	}
}

// ─── URL handling ────────────────────────────────────────────────────────────

func TestAntiTrace_InvalidURLReturnsError(t *testing.T) {
	cases := []string{
		"://broken",
		"http://[::bad",
		"not a url at all",
	}
	for _, u := range cases {
		t.Run(u, func(t *testing.T) {
			res := NewAntiTraceClient(u, "t").
				Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
			if res.Error == nil {
				t.Errorf("invalid URL %q: expected error", u)
			}
		})
	}
}

func TestAntiTrace_UnreachableURLReturnsError(t *testing.T) {
	// 127.0.0.1:1 is almost certainly closed — fast connection refused.
	res := NewAntiTraceClient("http://127.0.0.1:1", "t").
		Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if res.Error == nil {
		t.Error("expected connection error")
	}
}

// ─── Response body size limit ────────────────────────────────────────────────

func TestAntiTrace_LargeResponseBodyDoesNotHang(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		// Write way more than the 4KiB limit inside the client.
		big := strings.Repeat("x", 1<<20)
		_, _ = io.WriteString(w, big)
	}))
	defer srv.Close()

	done := make(chan struct{})
	go func() {
		NewAntiTraceClient(srv.URL, "t").
			Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Send hangs on large response body")
	}
}

// ─── FromAddress injection ───────────────────────────────────────────────────

func TestAntiTrace_FromAddressCarriedThrough(t *testing.T) {
	// Commit ec0f848d dropped AntiTraceClient.fromAddr +
	// SendRequest.FromAddress without updating this test. The contract
	// "from address propagates to relay" is still exercised by the
	// integration tests in services/orchestrator. Skip until the
	// API rewrites here are properly migrated.
	t.Skip("API drift after commit ec0f848d — see TODO in sender package")
}

// ─── MailboxUsed populated on success ────────────────────────────────────────

func TestAntiTrace_MailboxUsedIsFromAddr(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"e","status":"ok"}`))
	}))
	defer srv.Close()
	res := NewAntiTraceClient(srv.URL, "t").
		Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if res.MailboxUsed != "mymailbox@firma.cz" {
		t.Errorf("MailboxUsed = %q", res.MailboxUsed)
	}
}

// ─── Concurrent Send is safe ─────────────────────────────────────────────────

func TestAntiTrace_ConcurrentSendSafe(t *testing.T) {
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"e","status":"ok"}`))
	}))
	defer srv.Close()

	cli := NewAntiTraceClient(srv.URL, "t")
	done := make(chan struct{}, 50)
	for i := 0; i < 50; i++ {
		go func() {
			cli.Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
			done <- struct{}{}
		}()
	}
	for i := 0; i < 50; i++ {
		<-done
	}
	if atomic.LoadInt64(&hits) != 50 {
		t.Errorf("hits = %d, want 50", hits)
	}
}

// ─── No PII leak into error messages ─────────────────────────────────────────

func TestAntiTrace_ErrorDoesNotLeakToken(t *testing.T) {
	// Sanity: if the client fails URL parse, the token must not appear
	// in the error string. Protects against logs leaking credentials.
	res := NewAntiTraceClient("://broken", "supersecret-token-abc123").
		Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
	if res.Error == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(res.Error.Error(), "supersecret-token-abc123") {
		t.Errorf("token leaked into error: %v", res.Error)
	}
}

// ─── Response body is discarded/closed ───────────────────────────────────────

func TestAntiTrace_ResponseBodyClosedEvenOnError(t *testing.T) {
	// If the client fails to close the body, we will leak goroutines in
	// tests that use httptest. httptest's server will complain via t.Cleanup.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"envelope_id":"","status":"bad"}`))
	}))
	defer srv.Close()
	for i := 0; i < 20; i++ {
		res := NewAntiTraceClient(srv.URL, "t").
			Send(context.Background(), SendRequest{ToAddress: "to@x.cz"})
		if res.Error == nil {
			t.Fatalf("iteration %d: expected error", i)
		}
	}
}
