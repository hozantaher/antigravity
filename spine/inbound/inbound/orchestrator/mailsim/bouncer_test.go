package mailsim

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---- DefaultBouncerConfig / NewBouncer ----

func TestDefaultBouncerConfig_Defaults(t *testing.T) {
	cfg := DefaultBouncerConfig()
	if cfg.MailpitBaseURL == "" {
		t.Fatal("expected non-empty MailpitBaseURL")
	}
	if cfg.GreenMailSMTPAddr == "" {
		t.Fatal("expected non-empty GreenMailSMTPAddr")
	}
	if cfg.InboxAddress == "" {
		t.Fatal("expected non-empty InboxAddress")
	}
	if cfg.PollInterval <= 0 {
		t.Fatal("expected positive PollInterval")
	}
}

func TestNewBouncer_NilConfig_UsesDefault(t *testing.T) {
	b := NewBouncer(nil)
	if b == nil {
		t.Fatal("expected non-nil bouncer")
	}
	if b.cfg == nil {
		t.Fatal("expected non-nil config")
	}
}

func TestNewBouncer_WithConfig(t *testing.T) {
	cfg := &BouncerConfig{
		MailpitBaseURL:    "http://localhost:8025",
		GreenMailSMTPAddr: "localhost:2025",
		InboxAddress:      "test@test.local",
		PollInterval:      1 * time.Second,
	}
	b := NewBouncer(cfg)
	if b.cfg.InboxAddress != "test@test.local" {
		t.Fatalf("expected test inbox, got %s", b.cfg.InboxAddress)
	}
	if b.cfg.HTTPClient == nil {
		t.Fatal("expected default http client to be set")
	}
}

// ---- jitter ----

func TestJitter_ZeroDelay_NoPanic(t *testing.T) {
	b := &Bouncer{cfg: &BouncerConfig{MinResponseDelay: 0, MaxResponseDelay: 0}}
	start := time.Now()
	b.jitter()
	// Should not sleep long
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("jitter took too long with zero config")
	}
}

func TestJitter_MaxLessThanMin_SleepsMin(t *testing.T) {
	b := &Bouncer{cfg: &BouncerConfig{
		MinResponseDelay: 1 * time.Millisecond,
		MaxResponseDelay: 0, // max <= min → sleep min
	}}
	start := time.Now()
	b.jitter()
	_ = time.Since(start)
}

func TestJitter_ValidRange_NoPanic(t *testing.T) {
	b := &Bouncer{cfg: &BouncerConfig{
		MinResponseDelay: 1 * time.Millisecond,
		MaxResponseDelay: 5 * time.Millisecond,
	}}
	b.jitter()
}

// ---- handle: early-exit paths (no HTTP) ----

func TestHandle_EmptyTo_Error(t *testing.T) {
	b := NewBouncer(&BouncerConfig{
		MailpitBaseURL:    "http://localhost:1",
		GreenMailSMTPAddr: "localhost:1",
		InboxAddress:      "x@test",
		PollInterval:      time.Second,
	})
	err := b.handle(context.Background(), mailpitMessage{ID: "abc", To: nil})
	if err == nil {
		t.Fatal("expected error for empty To")
	}
}

func TestHandle_Deliver_NoHTTP(t *testing.T) {
	var called string
	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL:    "http://localhost:1",
			GreenMailSMTPAddr: "localhost:1",
			InboxAddress:      "in@test",
			PollInterval:      time.Second,
		},
		dsn:   DefaultDSNBuilder(),
		reply: DefaultReplyBuilder(),
		OnRespond: func(beh Behavior, addr string) {
			called = string(beh)
		},
	}
	msg := mailpitMessage{
		ID: "deliver-1",
		To: []mailpitAddress{{Address: "jan.novak@firma.cz"}},
	}
	if err := b.handle(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	if called != "deliver" {
		t.Fatalf("expected deliver callback, got %q", called)
	}
}

func TestHandle_Silent_NoHTTP(t *testing.T) {
	var called string
	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL:    "http://localhost:1",
			GreenMailSMTPAddr: "localhost:1",
			InboxAddress:      "in@test",
			PollInterval:      time.Second,
		},
		dsn:   DefaultDSNBuilder(),
		reply: DefaultReplyBuilder(),
		OnRespond: func(beh Behavior, addr string) {
			called = string(beh)
		},
	}
	msg := mailpitMessage{
		ID: "silent-1",
		To: []mailpitAddress{{Address: "user-silent@firm.test"}},
	}
	if err := b.handle(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	if called != "silent" {
		t.Fatalf("expected silent callback, got %q", called)
	}
}

// ---- listMessages ----

func TestListMessages_OK(t *testing.T) {
	payload := mailpitListResponse{
		Messages: []mailpitMessage{
			{ID: "msg1", Subject: "Test", To: []mailpitAddress{{Address: "user@test"}}},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}))
	defer srv.Close()

	b := NewBouncer(&BouncerConfig{
		MailpitBaseURL:    srv.URL,
		GreenMailSMTPAddr: "localhost:1",
		InboxAddress:      "x@test",
		PollInterval:      time.Second,
	})
	msgs, err := b.listMessages(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].ID != "msg1" {
		t.Fatalf("unexpected ID: %s", msgs[0].ID)
	}
}

func TestListMessages_Non200_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		_, _ = w.Write([]byte("service unavailable"))
	}))
	defer srv.Close()

	b := NewBouncer(&BouncerConfig{
		MailpitBaseURL:    srv.URL,
		GreenMailSMTPAddr: "localhost:1",
		InboxAddress:      "x@test",
		PollInterval:      time.Second,
	})
	_, err := b.listMessages(context.Background())
	if err == nil {
		t.Fatal("expected error for non-200")
	}
}

// ---- fetchOriginal ----

func TestFetchOriginal_OK(t *testing.T) {
	raw := struct {
		ID        string           `json:"ID"`
		MessageID string           `json:"MessageID"`
		From      mailpitAddress   `json:"From"`
		To        []mailpitAddress `json:"To"`
		Subject   string           `json:"Subject"`
		Date      time.Time        `json:"Date"`
		Text      string           `json:"Text"`
	}{
		ID:        "mp-1",
		MessageID: "<orig@test>",
		From:      mailpitAddress{Address: "sender@outreach.test"},
		To:        []mailpitAddress{{Address: "buyer@firm.test"}},
		Subject:   "Nabídka strojů",
		Text:      "Hello world",
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(raw)
	}))
	defer srv.Close()

	b := NewBouncer(&BouncerConfig{
		MailpitBaseURL:    srv.URL,
		GreenMailSMTPAddr: "localhost:1",
		InboxAddress:      "x@test",
		PollInterval:      time.Second,
	})
	orig, err := b.fetchOriginal(context.Background(), "mp-1")
	if err != nil {
		t.Fatal(err)
	}
	if orig.MessageID != "<orig@test>" {
		t.Fatalf("unexpected MessageID: %s", orig.MessageID)
	}
	if orig.Subject != "Nabídka strojů" {
		t.Fatalf("unexpected Subject: %s", orig.Subject)
	}
}

func TestFetchOriginal_Non200_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte("not found"))
	}))
	defer srv.Close()

	b := NewBouncer(&BouncerConfig{
		MailpitBaseURL:    srv.URL,
		GreenMailSMTPAddr: "localhost:1",
		InboxAddress:      "x@test",
		PollInterval:      time.Second,
	})
	_, err := b.fetchOriginal(context.Background(), "missing-id")
	if err == nil {
		t.Fatal("expected error for non-200")
	}
}

// ---- tick ----

func TestTick_ProcessesMessages(t *testing.T) {
	// Mailpit returns one deliver-behavior message → processed, no SMTP needed.
	var responded []string
	listPayload := mailpitListResponse{
		Messages: []mailpitMessage{
			{ID: "t1", To: []mailpitAddress{{Address: "jan@firma.cz"}}},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(listPayload)
	}))
	defer srv.Close()

	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL:    srv.URL,
			GreenMailSMTPAddr: "localhost:1",
			InboxAddress:      "in@test",
			PollInterval:      time.Second,
			HTTPClient:        http.DefaultClient,
		},
		dsn:   DefaultDSNBuilder(),
		reply: DefaultReplyBuilder(),
		OnRespond: func(beh Behavior, addr string) {
			responded = append(responded, string(beh))
		},
	}
	if err := b.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(responded) != 1 {
		t.Fatalf("expected 1 response callback, got %d", len(responded))
	}
}

func TestTick_DeduplicatesMessages(t *testing.T) {
	var callCount int
	listPayload := mailpitListResponse{
		Messages: []mailpitMessage{
			{ID: "dup1", To: []mailpitAddress{{Address: "jan@firma.cz"}}},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(listPayload)
	}))
	defer srv.Close()

	b := &Bouncer{
		cfg: &BouncerConfig{
			MailpitBaseURL: srv.URL, GreenMailSMTPAddr: "localhost:1",
			InboxAddress: "in@test", PollInterval: time.Second,
			HTTPClient: srv.Client(),
		},
		dsn: DefaultDSNBuilder(), reply: DefaultReplyBuilder(),
		OnRespond: func(_ Behavior, _ string) { callCount++ },
	}
	_ = b.tick(context.Background())
	_ = b.tick(context.Background()) // second tick — same message should be skipped
	if callCount != 1 {
		t.Fatalf("expected 1 callback (dedup), got %d", callCount)
	}
}

// ---- Run ----

func TestRun_ContextCancel_Returns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(mailpitListResponse{})
	}))
	defer srv.Close()

	b := NewBouncer(&BouncerConfig{
		MailpitBaseURL:    srv.URL,
		GreenMailSMTPAddr: "localhost:1",
		InboxAddress:      "in@test",
		PollInterval:      10 * time.Millisecond,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := b.Run(ctx)
	if err == nil {
		t.Fatal("expected context error")
	}
}
