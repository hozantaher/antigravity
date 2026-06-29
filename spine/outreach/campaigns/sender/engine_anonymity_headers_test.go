package sender

// Engine-level integration test for the anti-trace anonymity bundle.
//
// Wires up sender.Engine with a fake antiTrace.Send target that captures
// the SendRequest passed to it, runs one queue cycle, and asserts that
// req.Headers carries Message-ID + From + Date as written by
// applyAnonymityHeaders. This is the closest unit-test equivalent of
// the actual production path — short of live SMTP.
//
// Two scenarios:
//   - With HMAC key wired:    HMAC-format Message-ID
//   - Without HMAC key:        legacy generateMessageID fallback (defence
//                              in depth — operator misconfig must not drop
//                              sends, but Message-ID must still appear)

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"common/config"
)

// fakeRelayServer returns a minimal valid /v1/submit response. Captures
// the inbound JSON body so the test can assert on the headers map the
// engine sent.
func fakeRelayServer(t *testing.T, capture *string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/submit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "wrong method", http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		*capture = string(body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"env-test-1","status":"queued"}`))
	})
	return httptest.NewServer(mux)
}

func TestEngine_AnonymityHeaders_WiredWithHMACKey(t *testing.T) {
	var captured string
	srv := fakeRelayServer(t, &captured)
	defer srv.Close()

	mailboxes := []config.MailboxConfig{
		{
			Address:     "alice.novak@alias.cz",
			SMTPHost:    "smtp.example.cz",
			SMTPPort:    587,
			Username:    "alice.novak@alias.cz",
			Password:    "p",
			DailyLimit:  10,
			DisplayName: "Alice Nováková",
			Timezone:    "America/New_York",
		},
	}

	e := NewEngine(mailboxes,
		config.SendingConfig{
			WindowStart: 0, WindowEnd: 24, // any-hour run for tests
			MaxPerDomainHour: 100,
			MinDelaySeconds:  1, MaxDelaySeconds: 1,
		},
		config.SafetyConfig{MaxBounceRate: 1.0},
	).
		// engine-bypass-allowed: test wiring — client passed to Engine.WithAntiTrace
		WithAntiTrace(NewAntiTraceClient(srv.URL, "test-token")).
		WithMessageIDHMACKey([]byte("0123456789abcdef0123456789abcdef"))

	e.Enqueue(SendRequest{
		CampaignID: 1,
		ContactID:  42,
		Step:       0,
		ToAddress:  "target@firma.cz",
		Subject:    "Poptávka",
		BodyPlain:  "Dobrý den, ...",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		_ = e.Run(ctx, func(_ SendRequest, _ SendResult) {
			close(done)
		})
	}()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for engine dispatch; captured=%q", captured)
	}

	cancel()

	if captured == "" {
		t.Fatal("relay never received the request body")
	}

	// All three headers must appear in the captured JSON. encoding/json
	// escapes "<" and ">" to "<" / ">" by default (HTMLEscape
	// XSS guard), so the substring assertions use the escaped form —
	// this is the JSON-on-the-wire shape the relay actually receives.
	for _, want := range []string{
		"\"Message-ID\":\"\\u003c",
		"\"From\":\"Alice Nováková \\u003calice.novak@alias.cz\\u003e\"",
		"\"Date\":\"",
	} {
		if !strings.Contains(captured, want) {
			t.Errorf("relay payload missing %q\npayload=%s", want, captured)
		}
	}

	// Date must reflect America/New_York timezone (-0400 EDT in May 2026,
	// or -0500 EST any time the test runs in winter).
	if !strings.Contains(captured, `-0400`) && !strings.Contains(captured, `-0500`) {
		t.Errorf("Date header must reflect America/New_York offset (-0400/-0500); payload=%s", captured)
	}
}

func TestEngine_AnonymityHeaders_NoHMACKeyFallsBackButStillEmitsMessageID(t *testing.T) {
	var captured string
	srv := fakeRelayServer(t, &captured)
	defer srv.Close()

	mailboxes := []config.MailboxConfig{
		{
			Address:    "info@alias.cz",
			SMTPHost:   "smtp.example.cz",
			SMTPPort:   587,
			DailyLimit: 10,
			// No DisplayName, no Timezone — exercises the fallback paths.
		},
	}

	e := NewEngine(mailboxes,
		config.SendingConfig{
			WindowStart: 0, WindowEnd: 24,
			MaxPerDomainHour: 100,
			MinDelaySeconds:  1, MaxDelaySeconds: 1,
		},
		config.SafetyConfig{MaxBounceRate: 1.0},
	).
		// engine-bypass-allowed: test wiring — client passed to Engine.WithAntiTrace
		WithAntiTrace(NewAntiTraceClient(srv.URL, "test-token"))
		// NOTE: WithMessageIDHMACKey intentionally NOT called.

	e.Enqueue(SendRequest{
		CampaignID: 1,
		ContactID:  43,
		ToAddress:  "target@firma.cz",
		Subject:    "S",
		BodyPlain:  "B",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = e.Run(ctx, func(_ SendRequest, _ SendResult) {
			close(done)
		})
	}()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatalf("timed out; captured=%q", captured)
	}
	cancel()

	// JSON encoding escapes "<" / ">" to < / > — match the
	// on-the-wire shape, not the source-form value.
	if !strings.Contains(captured, "\"Message-ID\":\"\\u003c") {
		t.Errorf("legacy fallback must still emit Message-ID; payload=%s", captured)
	}
	// "info" → titlecased "Info" — fallback still produces a display name.
	if !strings.Contains(captured, "\"From\":\"Info \\u003cinfo@alias.cz\\u003e\"") {
		t.Errorf("From fallback must title-case local part; payload=%s", captured)
	}
	// Empty Timezone falls back to Europe/Prague (+0200 in May, +0100 in winter).
	if !strings.Contains(captured, `+0200`) && !strings.Contains(captured, `+0100`) {
		t.Errorf("Date fallback must use Europe/Prague offset; payload=%s", captured)
	}
}
