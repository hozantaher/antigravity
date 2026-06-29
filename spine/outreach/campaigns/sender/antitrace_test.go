package sender

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type senderRoundTripFunc func(*http.Request) (*http.Response, error)

func (f senderRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestNewAntiTraceClient_Fields(t *testing.T) {
	c := NewAntiTraceClient("http://relay.local", "tok123")
	if c.url != "http://relay.local" {
		t.Errorf("url = %q", c.url)
	}
	if c.token != "tok123" {
		t.Errorf("token = %q", c.token)
	}
	// Note: fromAddr field removed in commit ec0f848d (drop
	// ANTI_TRACE_FROM env-var fallback). The address is now passed per
	// envelope at Submit time.
	if c.http == nil {
		t.Error("http client should not be nil")
	}
}

func TestAntiTraceClient_Send_Success(t *testing.T) {
	var gotAuth, gotContentType string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		resp := antiTraceResponse{EnvelopeID: "env-001", Status: "queued"}
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := &AntiTraceClient{url: srv.URL, token: "mytoken", http: &http.Client{}}
	result := c.Send(context.Background(), SendRequest{
		ToAddress: "contact@firma.cz",
		Subject:   "Hello",
		BodyPlain: "Test body",
	})

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if result.MessageID != "env-001" {
		t.Errorf("message ID = %q, want env-001", result.MessageID)
	}
	if gotAuth != "Bearer mytoken" {
		t.Errorf("Authorization = %q, want 'Bearer mytoken'", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContentType)
	}
}

func TestAntiTraceClient_Send_200OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := antiTraceResponse{EnvelopeID: "env-002", Status: "sent"}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := &AntiTraceClient{url: srv.URL, token: "t", http: &http.Client{}}
	result := c.Send(context.Background(), SendRequest{ToAddress: "x@y.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if result.MessageID != "env-002" {
		t.Errorf("message ID = %q, want env-002", result.MessageID)
	}
}

func TestAntiTraceClient_Send_RateLimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c := &AntiTraceClient{url: srv.URL, token: "t", http: &http.Client{}}
	result := c.Send(context.Background(), SendRequest{ToAddress: "x@y.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	if result.Error == nil {
		t.Fatal("expected rate-limited error")
	}
	if !strings.Contains(result.Error.Error(), "rate limited") {
		t.Errorf("error should mention rate limited, got %q", result.Error.Error())
	}
}

func TestAntiTraceClient_Send_NonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer srv.Close()

	c := &AntiTraceClient{url: srv.URL, token: "t", http: &http.Client{}}
	result := c.Send(context.Background(), SendRequest{ToAddress: "x@y.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	if result.Error == nil {
		t.Fatal("expected error for non-2xx status")
	}
	if !strings.Contains(result.Error.Error(), "500") {
		t.Errorf("error should mention HTTP 500, got %q", result.Error.Error())
	}
}

func TestAntiTraceClient_Send_TransportError(t *testing.T) {
	c := &AntiTraceClient{
		url:      "http://relay.local",
		token:    "t",
 
		http: &http.Client{
			Transport: senderRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, io.ErrUnexpectedEOF
			}),
		},
	}
	result := c.Send(context.Background(), SendRequest{ToAddress: "x@y.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	if result.Error == nil {
		t.Fatal("expected transport error")
	}
}

func TestAntiTraceClient_Send_InvalidURL(t *testing.T) {
	c := &AntiTraceClient{
		url:      "://invalid",
		token:    "t",
 
		http:     &http.Client{},
	}
	result := c.Send(context.Background(), SendRequest{ToAddress: "x@y.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	if result.Error == nil {
		t.Fatal("expected error for invalid URL")
	}
}
