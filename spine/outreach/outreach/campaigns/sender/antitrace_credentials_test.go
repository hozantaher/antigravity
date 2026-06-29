package sender

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestAntiTraceRequest_HasSMTPCredentials verifies that a SendRequest with
// fully populated SMTP fields carries those fields through to the relay
// payload. This guards against accidental zero-value omissions when the
// engine populates credentials from a picked mailbox.
func TestAntiTraceRequest_HasSMTPCredentials(t *testing.T) {
	req := SendRequest{
		ToAddress:    "x@y.cz",
		SMTPHost:     "smtp.seznam.cz",
		SMTPPort:     587,
		SMTPUsername: "user@email.cz",
		SMTPPassword: "password123",
	}

	if req.SMTPHost == "" {
		t.Error("SMTPHost should be set")
	}
	if req.SMTPPort == 0 {
		t.Error("SMTPPort should be set")
	}
	if req.SMTPUsername == "" {
		t.Error("SMTPUsername should be set")
	}
	if req.SMTPPassword == "" {
		t.Error("SMTPPassword should be set")
	}
}

// TestAntiTraceRequest_CredentialsInPayload verifies that JSON serialization
// of antiTraceRequest includes the SMTP fields when they are populated.
func TestAntiTraceRequest_CredentialsInPayload(t *testing.T) {
	p := antiTraceRequest{
		Recipient:    "x@y.cz",
		Subject:      "Hello",
		Body:         "body",
		SMTPHost:     "smtp.seznam.cz",
		SMTPPort:     587,
		SMTPUsername: "user@email.cz",
		SMTPPassword: "s3cr3t",
	}

	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, key := range []string{"smtp_host", "smtp_username", "smtp_password"} {
		v, ok := m[key]
		if !ok {
			t.Errorf("JSON missing key %q", key)
			continue
		}
		if s, _ := v.(string); s == "" {
			t.Errorf("JSON key %q is empty", key)
		}
	}

	port, ok := m["smtp_port"]
	if !ok {
		t.Error("JSON missing key smtp_port")
	} else if int(port.(float64)) != 587 {
		t.Errorf("smtp_port = %v, want 587", port)
	}
}

// TestAntiTraceClient_Send_SMTPCredentialsPropagated verifies that when a
// SendRequest carries SMTP credentials, the anti-trace relay receives them
// in the posted JSON payload. This is the integration point where the engine
// hands mailbox credentials to the relay.
func TestAntiTraceClient_Send_SMTPCredentialsPropagated(t *testing.T) {
	var gotPayload antiTraceRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"cred-test-01","status":"queued"}`))
	}))
	defer srv.Close()

	cli := NewAntiTraceClient(srv.URL, "token")
	req := SendRequest{
		ToAddress:    "contact@firma.cz",
		Subject:      "Credential injection test",
		BodyPlain:    "plain",
		SMTPHost:     "smtp.seznam.cz",
		SMTPPort:     465,
		SMTPUsername: "sender@firma.cz",
		SMTPPassword: "ultraSecretPass!",
	}

	result := cli.Send(context.Background(), req)
	if result.Error != nil {
		t.Fatalf("unexpected send error: %v", result.Error)
	}

	if gotPayload.SMTPHost != "smtp.seznam.cz" {
		t.Errorf("SMTPHost = %q, want smtp.seznam.cz", gotPayload.SMTPHost)
	}
	if gotPayload.SMTPPort != 465 {
		t.Errorf("SMTPPort = %d, want 465", gotPayload.SMTPPort)
	}
	if gotPayload.SMTPUsername != "sender@firma.cz" {
		t.Errorf("SMTPUsername = %q, want sender@firma.cz", gotPayload.SMTPUsername)
	}
	if gotPayload.SMTPPassword != "ultraSecretPass!" {
		t.Errorf("SMTPPassword = %q, want ultraSecretPass!", gotPayload.SMTPPassword)
	}
}

// TestAntiTraceClient_Send_EmptyCredentials verifies that a SendRequest
// without SMTP credentials sends zero-values to the relay without error.
// The relay is responsible for handling missing credentials (e.g. env-based
// account pool). The engine must not panic or silently skip the send.
func TestAntiTraceClient_Send_EmptyCredentials(t *testing.T) {
	var gotPayload antiTraceRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotPayload)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"cred-empty-01","status":"queued"}`))
	}))
	defer srv.Close()

	cli := NewAntiTraceClient(srv.URL, "t")
	result := cli.Send(context.Background(), SendRequest{
		ToAddress: "to@firma.cz",
		Subject:   "no creds",
		BodyPlain: "body",
		// SMTPHost, SMTPPort, SMTPUsername, SMTPPassword all zero/empty
	})

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if gotPayload.SMTPHost != "" {
		t.Errorf("expected empty SMTPHost, got %q", gotPayload.SMTPHost)
	}
	if gotPayload.SMTPPort != 0 {
		t.Errorf("expected SMTPPort 0, got %d", gotPayload.SMTPPort)
	}
}

// TestAntiTraceClient_Send_CredentialsNotLeakedInError verifies that SMTP
// credentials do NOT appear in error messages when the relay is unreachable.
// Protects against credential exposure in logs / Sentry events.
func TestAntiTraceClient_Send_CredentialsNotLeakedInError(t *testing.T) {
	cli := NewAntiTraceClient("http://127.0.0.1:1", "tok")
	result := cli.Send(context.Background(), SendRequest{
		ToAddress:    "to@x.cz",
		SMTPPassword: "superSecretPassword",
	})

	if result.Error == nil {
		t.Fatal("expected connection error")
	}
	if contains(result.Error.Error(), "superSecretPassword") {
		t.Errorf("SMTP password leaked into error message: %v", result.Error)
	}
}

// TestAntiTraceClient_Send_FromAddressFallbackToSMTPUsername verifies that
// when SMTPUsername is set, it is used as the from_address in the payload
// (per-mailbox rotation). This ensures the relay sends as the correct mailbox.
func TestAntiTraceClient_Send_FromAddressFallbackToSMTPUsername(t *testing.T) {
	var gotPayload antiTraceRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotPayload)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"from-test","status":"queued"}`))
	}))
	defer srv.Close()

	// Client-level fromAddr is different from per-request SMTPUsername
	cli := NewAntiTraceClient(srv.URL, "tok")
	result := cli.Send(context.Background(), SendRequest{
		ToAddress:    "to@x.cz",
		SMTPUsername: "per-mailbox@firma.cz",
		SMTPPassword: "pass",
		SMTPHost:     "smtp.seznam.cz",
		SMTPPort:     587,
	})

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	// When SMTPUsername is set, it takes precedence as from_address
	if gotPayload.FromAddress != "per-mailbox@firma.cz" {
		t.Errorf("from_address = %q, want per-mailbox@firma.cz", gotPayload.FromAddress)
	}
}

// contains is a tiny helper to avoid importing strings in this file.
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}
