package sender

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// capturedAntiTraceRequest is what the test relay server captures from the request body.
type capturedAntiTraceRequest struct {
	Recipient        string `json:"recipient"`
	PreferredCountry string `json:"preferred_country,omitempty"`
	FromAddress      string `json:"from_address,omitempty"`
	SMTPHost         string `json:"smtp_host,omitempty"`
}

// TestAntiTraceClient_Send_PreferredCountry_Included verifies that when
// SendRequest.PreferredCountry is set, it appears in the relay payload.
func TestAntiTraceClient_Send_PreferredCountry_Included(t *testing.T) {
	var captured capturedAntiTraceRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"env-001","status":"accepted"}`))
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	req := SendRequest{
		ToAddress:        "to@example.com",
		Subject:          "Test",
		BodyPlain:        "body",
		SMTPHost:         "smtp.test",
		SMTPUsername:     "from@test.cz",
		SMTPPassword:     "pass",
		PreferredCountry: "SK",
	}
	result := c.Send(context.Background(), req)
	if result.Error != nil {
		t.Fatalf("Send returned error: %v", result.Error)
	}

	if captured.PreferredCountry != "SK" {
		t.Fatalf("expected preferred_country=SK in payload, got %q", captured.PreferredCountry)
	}
}

// TestAntiTraceClient_Send_PreferredCountry_OmittedWhenEmpty verifies that
// when PreferredCountry is empty, the field is absent from the relay payload.
func TestAntiTraceClient_Send_PreferredCountry_OmittedWhenEmpty(t *testing.T) {
	var capturedBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"env-002","status":"accepted"}`))
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	req := SendRequest{
		ToAddress:    "to@example.com",
		Subject:      "Test",
		BodyPlain:    "body",
		SMTPHost:     "smtp.test",
		SMTPUsername: "from@test.cz",
		SMTPPassword: "pass",
		// PreferredCountry intentionally empty
	}
	result := c.Send(context.Background(), req)
	if result.Error != nil {
		t.Fatalf("Send returned error: %v", result.Error)
	}

	// Unmarshal and verify key is absent (zero value after unmarshal).
	var got capturedAntiTraceRequest
	if err := json.Unmarshal(capturedBody, &got); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if got.PreferredCountry != "" {
		t.Fatalf("expected preferred_country absent/empty, got %q", got.PreferredCountry)
	}
}

// TestAntiTraceClient_Send_PreferredCountry_ROPins verifies RO country code.
func TestAntiTraceClient_Send_PreferredCountry_ROPins(t *testing.T) {
	var captured capturedAntiTraceRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"env-003","status":"accepted"}`))
	}))
	defer srv.Close()

	c := NewAntiTraceClient(srv.URL, "tok")
	req := SendRequest{
		ToAddress:        "to@example.com",
		Subject:          "Test",
		BodyPlain:        "body",
		SMTPHost:         "smtp.test",
		SMTPUsername:     "goran.nowak@email.cz",
		SMTPPassword:     "pass",
		PreferredCountry: "RO",
	}
	result := c.Send(context.Background(), req)
	if result.Error != nil {
		t.Fatalf("Send returned error: %v", result.Error)
	}

	if captured.PreferredCountry != "RO" {
		t.Fatalf("expected preferred_country=RO, got %q", captured.PreferredCountry)
	}
}

// TestSendRequest_PreferredCountry_FieldExists verifies the field is on SendRequest.
func TestSendRequest_PreferredCountry_FieldExists(t *testing.T) {
	req := SendRequest{
		PreferredCountry: "SK",
	}
	if req.PreferredCountry != "SK" {
		t.Fatalf("expected PreferredCountry=SK, got %q", req.PreferredCountry)
	}
}
