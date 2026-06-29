package sender_test

// Pipeline smoke test: verifies the full send path from Engine.Enqueue
// through AntiTraceClient.Send to a mock relay server.
// Validates that SMTP credentials from SendRequest reach the relay payload.

import (
	"campaigns/sender"
	"common/config"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type capturedRelayReq struct {
	Recipient    string `json:"recipient"`
	Subject      string `json:"subject"`
	FromAddress  string `json:"from_address"`
	SMTPHost     string `json:"smtp_host"`
	SMTPPort     int    `json:"smtp_port"`
	SMTPUsername string `json:"smtp_username"`
	SMTPPassword string `json:"smtp_password"`
}

// TestPipeline_CredentialsReachRelay verifies that after Engine picks a mailbox,
// the SMTP credentials are injected into the AntiTrace request payload.
func TestPipeline_CredentialsReachRelay(t *testing.T) {
	var captured capturedRelayReq
	done := make(chan struct{}, 1)

	// Mock relay server — accepts /v1/submit and records the payload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/submit" {
			body, _ := io.ReadAll(r.Body)
			json.Unmarshal(body, &captured)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			w.Write([]byte(`{"envelope_id":"test-123","status":"accepted"}`))
			done <- struct{}{}
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	// Create engine with one mailbox
	mb := config.MailboxConfig{
		Address:    "mazher.a@email.cz",
		SMTPHost:   "smtp.seznam.cz",
		SMTPPort:   587,
		Username:   "mazher.a@email.cz",
		Password:   "secretpassword123",
		DailyLimit: 100,
	}
	eng := sender.NewEngine([]config.MailboxConfig{mb}, config.SendingConfig{
		WindowStart: 0, WindowEnd: 24,
		MinDelaySeconds: 0, MaxDelaySeconds: 0,
		MaxPerDomainHour: 1000, // must be >0 for allowDomain to return true
	}, config.SafetyConfig{MaxBounceRate: 0.5})

	// Wire mock relay as AntiTrace client
	antiTrace := sender.NewAntiTraceClient(srv.URL, "test-token")
	eng = eng.WithAntiTrace(antiTrace)

	// Enqueue one request
	eng.Enqueue(sender.SendRequest{
		CampaignID: 1,
		ContactID:  1,
		ToAddress:  "recipient@firma.cz",
		Subject:    "Test subject",
		BodyPlain:  "Test body",
	})

	// Run engine briefly
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {})
	}()

	// Wait for relay to receive the request
	select {
	case <-done:
		// Verify credentials were injected
		if captured.SMTPHost != "smtp.seznam.cz" {
			t.Errorf("SMTPHost not injected: got %q", captured.SMTPHost)
		}
		if captured.SMTPPort != 587 {
			t.Errorf("SMTPPort not injected: got %d", captured.SMTPPort)
		}
		if captured.SMTPUsername != "mazher.a@email.cz" {
			t.Errorf("SMTPUsername not injected: got %q", captured.SMTPUsername)
		}
		if captured.SMTPPassword != "secretpassword123" {
			t.Errorf("SMTPPassword not injected: got %q", captured.SMTPPassword)
		}
		if captured.Recipient != "recipient@firma.cz" {
			t.Errorf("Recipient wrong: got %q", captured.Recipient)
		}
		t.Logf("✓ Credentials reached relay: user=%s host=%s:%d",
			captured.SMTPUsername, captured.SMTPHost, captured.SMTPPort)

	case <-time.After(5 * time.Second):
		t.Fatal("timeout — relay did not receive request within 5s")
	}
}

// TestPipeline_NoAntiTrace_ReturnsError verifies ErrAntiTraceRequired.
func TestPipeline_NoAntiTrace_ReturnsError(t *testing.T) {
	eng := sender.NewEngine([]config.MailboxConfig{{
		Address: "test@test.cz", SMTPHost: "smtp.test.cz", SMTPPort: 587,
		Username: "test@test.cz", Password: "pass", DailyLimit: 10,
	}}, config.SendingConfig{WindowStart: 0, WindowEnd: 24}, config.SafetyConfig{})

	eng.Enqueue(sender.SendRequest{CampaignID: 1, ContactID: 1, ToAddress: "x@y.cz", Subject: "S", BodyPlain: "B"})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	err := eng.Run(ctx, nil)
	if err != sender.ErrAntiTraceRequired {
		t.Errorf("expected ErrAntiTraceRequired, got: %v", err)
	}
}
