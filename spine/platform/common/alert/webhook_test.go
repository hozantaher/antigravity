package alert

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestEnabledReflectsWebhookURL(t *testing.T) {
	c := &Client{}
	if c.Enabled() {
		t.Fatal("expected disabled client without webhook URL")
	}

	c.webhookURL = "https://example.com/hook"
	if !c.Enabled() {
		t.Fatal("expected enabled client with webhook URL")
	}
}

func TestSendNoOpWhenDisabled(t *testing.T) {
	c := &Client{}
	c.Send(context.Background(), "hello")
}

func TestSendPostsJSONPayload(t *testing.T) {
	var gotMethod, gotContentType, gotText string

	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			gotMethod = r.Method
			gotContentType = r.Header.Get("Content-Type")
			defer r.Body.Close()
			var payload map[string]string
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			gotText = payload["text"]
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	}

	c := &Client{webhookURL: "http://alerts.local/hook", http: client}
	c.Send(context.Background(), "test message")

	if gotMethod != http.MethodPost {
		t.Fatalf("method = %q, want POST", gotMethod)
	}
	if gotContentType != "application/json" {
		t.Fatalf("content-type = %q, want application/json", gotContentType)
	}
	if gotText != "test message" {
		t.Fatalf("text = %q, want %q", gotText, "test message")
	}
}

func TestSendAddsHMACSignatureWhenSecretConfigured(t *testing.T) {
	const secret = "test-secret"
	var gotSig string
	var capturedPayload []byte

	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			gotSig = r.Header.Get("X-Hub-Signature-256")
			defer r.Body.Close()
			capturedPayload, _ = io.ReadAll(r.Body)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	}

	c := &Client{webhookURL: "http://alerts.local/hook", secret: []byte(secret), http: client}
	c.Send(context.Background(), "signed message")

	if gotSig == "" {
		t.Fatal("expected X-Hub-Signature-256 header, got empty")
	}
	if !strings.HasPrefix(gotSig, "sha256=") {
		t.Fatalf("signature header should start with sha256=, got %q", gotSig)
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(capturedPayload)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if gotSig != want {
		t.Fatalf("HMAC mismatch: got %q, want %q", gotSig, want)
	}
}

func TestSendOmitsHMACHeaderWhenNoSecret(t *testing.T) {
	var gotSig string

	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			gotSig = r.Header.Get("X-Hub-Signature-256")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	}

	c := &Client{webhookURL: "http://alerts.local/hook", http: client}
	c.Send(context.Background(), "unsigned message")

	if gotSig != "" {
		t.Fatalf("expected no X-Hub-Signature-256 header, got %q", gotSig)
	}
}

func TestSendLogsOnNonOKStatus(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusTooManyRequests,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("")),
			}, nil
		}),
	}
	// Should not panic — just logs a warning
	c := &Client{webhookURL: "http://alerts.local/hook", http: client}
	c.Send(context.Background(), "should warn")
}

func TestSendLogsOnTransportError(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return nil, io.ErrUnexpectedEOF
		}),
	}
	// Should not panic — just logs a warning
	c := &Client{webhookURL: "http://alerts.local/hook", http: client}
	c.Send(context.Background(), "transport error")
}

func TestHelperMessagesSendFormattedText(t *testing.T) {
	var texts []string

	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			defer r.Body.Close()
			var payload map[string]string
			_ = json.NewDecoder(r.Body).Decode(&payload)
			texts = append(texts, payload["text"])
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	}

	c := &Client{webhookURL: "http://alerts.local/hook", http: client}
	ctx := context.Background()

	c.DomainsFlagged(ctx, 2)
	c.AutoSuppressed(ctx, 3)
	c.InterestedReply(ctx, "person@example.com", 11)
	c.DaemonError(ctx, "imap", "connection lost")
	c.BounceRateHigh(ctx, "mail.example.com", 0.152)

	if len(texts) != 5 {
		t.Fatalf("got %d helper payloads, want 5", len(texts))
	}
	if !strings.Contains(texts[0], "2 domain(s) flagged") {
		t.Fatalf("unexpected DomainsFlagged text: %q", texts[0])
	}
	if !strings.Contains(texts[1], "3 contact(s)") {
		t.Fatalf("unexpected AutoSuppressed text: %q", texts[1])
	}
	if !strings.Contains(texts[2], "person@example.com") || !strings.Contains(texts[2], "thread #11") {
		t.Fatalf("unexpected InterestedReply text: %q", texts[2])
	}
	if !strings.Contains(texts[3], "Daemon error") || !strings.Contains(texts[3], "imap") {
		t.Fatalf("unexpected DaemonError text: %q", texts[3])
	}
	if !strings.Contains(texts[4], "15.2%") {
		t.Fatalf("unexpected BounceRateHigh text: %q", texts[4])
	}
}

// ── New() — env-based constructor ──

func TestNew_ReadsEnv(t *testing.T) {
	t.Setenv("ALERT_WEBHOOK_URL", "http://webhook.test/hook")
	t.Setenv("ALERT_WEBHOOK_SECRET", "mysecret")
	c := New()
	if c.webhookURL != "http://webhook.test/hook" {
		t.Errorf("webhookURL: %q", c.webhookURL)
	}
	if string(c.secret) != "mysecret" {
		t.Errorf("secret: %q", c.secret)
	}
	if !c.Enabled() { t.Error("should be enabled") }
}

func TestNew_Empty(t *testing.T) {
	os.Unsetenv("ALERT_WEBHOOK_URL")
	c := New()
	if c.Enabled() { t.Error("should not be enabled without URL") }
}

// ── Send branches: HMAC secret + non-2xx response + invalid URL ──

func TestSend_WithHMAC(t *testing.T) {
	var gotSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Hub-Signature-256")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &Client{
		webhookURL: srv.URL,
		secret:     []byte("test-secret"),
		http:       &http.Client{},
	}
	c.Send(context.Background(), "test message")
	if !strings.HasPrefix(gotSig, "sha256=") {
		t.Errorf("expected X-Hub-Signature-256, got %q", gotSig)
	}
	// Verify HMAC correctness
	payload, _ := json.Marshal(map[string]string{"text": "test message"})
	mac := hmac.New(sha256.New, []byte("test-secret"))
	mac.Write(payload)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if gotSig != expected {
		t.Errorf("HMAC mismatch: got %q, want %q", gotSig, expected)
	}
}

func TestSend_Non2xxResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	c := &Client{webhookURL: srv.URL, http: &http.Client{}}
	// Should not panic — logs warning internally
	c.Send(context.Background(), "message")
}

func TestSend_InvalidURL(t *testing.T) {
	c := &Client{
		webhookURL: "://invalid-url",
		http:       &http.Client{},
	}
	// Should not panic — NewRequestWithContext error → logs warn → returns
	c.Send(context.Background(), "message")
}

func TestDaemonPanic_SendsFormattedText(t *testing.T) {
	var gotText string

	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			defer r.Body.Close()
			var payload map[string]string
			_ = json.NewDecoder(r.Body).Decode(&payload)
			gotText = payload["text"]
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	}

	c := &Client{webhookURL: "http://alerts.local/hook", http: client}
	c.DaemonPanic(context.Background(), "imap", "runtime error: index out of range")

	if !strings.Contains(gotText, "Daemon panic recovered") {
		t.Errorf("unexpected DaemonPanic text: %q", gotText)
	}
	if !strings.Contains(gotText, "imap") {
		t.Errorf("DaemonPanic text should mention daemon name: %q", gotText)
	}
	if !strings.Contains(gotText, "index out of range") {
		t.Errorf("DaemonPanic text should include panic message: %q", gotText)
	}
}

// ── Property tests ─────────────────────────────────────────────────────────

func TestClient_Enabled_FalseWithoutURL(t *testing.T) {
	t.Setenv("ALERT_WEBHOOK_URL", "")
	c := New()
	if c.Enabled() {
		t.Error("client with empty URL should not be enabled")
	}
}

func TestClient_Send_NoopWithoutURL_NoPanic(t *testing.T) {
	t.Setenv("ALERT_WEBHOOK_URL", "")
	c := New()
	// Must not panic or crash
	c.Send(context.Background(), "test message")
}

func TestClient_AllMethods_NoopWithoutURL_NeverPanic(t *testing.T) {
	t.Setenv("ALERT_WEBHOOK_URL", "")
	c := New()
	ctx := context.Background()
	// All wrapper methods must be safe as no-ops
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("method panicked: %v", r)
		}
	}()
	c.DomainsFlagged(ctx, 0)
	c.DomainsFlagged(ctx, 999)
	c.AutoSuppressed(ctx, 0)
	c.InterestedReply(ctx, "", 0)
	c.InterestedReply(ctx, "user@example.com", 42)
	c.DaemonError(ctx, "", "")
	c.DaemonError(ctx, "daemon", "error message")
	c.BounceRateHigh(ctx, "", 0)
	c.BounceRateHigh(ctx, "domain.com", 0.99)
	c.DaemonPanic(ctx, "", "")
}
