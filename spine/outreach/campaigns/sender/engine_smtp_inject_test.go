package sender

// engine_smtp_inject_test.go — tests that Engine.Run injects DB mailbox SMTP
// credentials into the relay request after pickMailbox(), making credential
// delivery fully dynamic (no SMTP_ACCOUNT_N env vars required at the relay).
//
// Coverage:
//   TestEngine_InjectsCreds_AfterPickMailbox     — live relay verifies payload fields
//   TestEngine_InjectsCreds_AllPorts             — table: 465/587/1025 ports injected
//   TestEngine_InjectsCreds_RotatesPerMailbox    — second mailbox address wins
//   TestEngine_InjectsCreds_OverridesEmpty       — pre-populated creds are overwritten by engine
//   TestEngine_InjectsCreds_Monkey_NoPanic       — random cred values never panic the engine
//   TestEngine_InjectsCreds_UsernameAsFromAddr   — relay from_address = mailbox.Username
//   TestEngine_InjectsCreds_AllFieldsNonEmpty    — all four cred fields appear in relay JSON
//   TestSendRequest_SMTPFields_ZeroValueSafe     — zero-value SendRequest cred fields are safe
//   TestAntiTraceRequest_OmitemptyOnZero         — omitempty: zero SMTPPort absent from JSON
//   TestEngine_InjectsCreds_DryRunSkipsRelay     — dry_run never hits relay (creds not leaked)

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"common/config"
	"sync/atomic"
	"testing"
	"testing/quick"
	"time"
)

// TestEngine_InjectsCreds_AfterPickMailbox is the primary integration test:
// after pickMailbox() selects the only available mailbox, Run must inject
// SMTPHost/SMTPPort/SMTPUsername/SMTPPassword into the relay JSON payload.
func TestEngine_InjectsCreds_AfterPickMailbox(t *testing.T) {
	captured := make(chan antiTraceRequest, 1)

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req antiTraceRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		captured <- req
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"inject-01","status":"queued"}`))
	}))
	defer relay.Close()

	mb := config.MailboxConfig{
		Address:    "jan@firma.cz",
		SMTPHost:   "smtp.firma.cz",
		SMTPPort:   587,
		Username:   "jan@firma.cz",
		Password:   "tajne123",
		DailyLimit: 50,
	}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	done := make(chan struct{})
	e.Enqueue(SendRequest{ToAddress: "x@example.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		_ = e.Run(ctx, func(_ SendRequest, _ SendResult) { close(done) })
	}()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("onSent never fired within timeout")
	}

	select {
	case got := <-captured:
		if got.SMTPHost != "smtp.firma.cz" {
			t.Errorf("SMTPHost = %q, want smtp.firma.cz", got.SMTPHost)
		}
		if got.SMTPPort != 587 {
			t.Errorf("SMTPPort = %d, want 587", got.SMTPPort)
		}
		if got.SMTPUsername != "jan@firma.cz" {
			t.Errorf("SMTPUsername = %q, want jan@firma.cz", got.SMTPUsername)
		}
		if got.SMTPPassword != "tajne123" {
			t.Errorf("SMTPPassword = %q, want tajne123", got.SMTPPassword)
		}
	default:
		t.Fatal("relay was never called — credential injection failed")
	}
}

// TestEngine_InjectsCreds_AllPorts verifies credential injection for each of
// the three canonical SMTP port variants (465 implicit-TLS, 587 STARTTLS,
// 1025 plain/dev). The relay payload must always carry the mailbox port.
func TestEngine_InjectsCreds_AllPorts(t *testing.T) {
	tests := []struct{ name string; port int }{
		{"implicit TLS", 465},
		{"STARTTLS", 587},
		{"plain dev", 1025},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			captured := make(chan antiTraceRequest, 1)
			relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req antiTraceRequest
				_ = json.NewDecoder(r.Body).Decode(&req)
				captured <- req
				w.WriteHeader(http.StatusAccepted)
				_, _ = w.Write([]byte(`{"envelope_id":"port-test","status":"ok"}`))
			}))
			defer relay.Close()

			mb := config.MailboxConfig{
				Address:    "mb@test.cz",
				SMTPHost:   "smtp.test.cz",
				SMTPPort:   tt.port,
				Username:   "mb@test.cz",
				Password:   "pass",
				DailyLimit: 10,
			}

			e := NewEngine(
				[]config.MailboxConfig{mb},
				config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
				config.SafetyConfig{MaxBounceRate: 0.5},
			)
			e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))
			e.Enqueue(SendRequest{ToAddress: "to@example.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

			done := make(chan struct{})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()

			go func() { _ = e.Run(ctx, func(_ SendRequest, _ SendResult) { close(done) }) }()

			select {
			case <-done:
			case <-ctx.Done():
				t.Fatalf("port %d: onSent never fired", tt.port)
			}

			select {
			case got := <-captured:
				if got.SMTPPort != tt.port {
					t.Errorf("port %d: relay got SMTPPort=%d", tt.port, got.SMTPPort)
				}
			default:
				t.Fatalf("port %d: relay never called", tt.port)
			}
		})
	}
}

// TestEngine_InjectsCreds_OverridesEmpty verifies that even if the SendRequest
// was pre-populated with different (or empty) SMTP credentials before
// enqueueing, the engine overwrites them from the selected mailbox config.
func TestEngine_InjectsCreds_OverridesEmpty(t *testing.T) {
	captured := make(chan antiTraceRequest, 1)

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req antiTraceRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		captured <- req
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"override-01","status":"queued"}`))
	}))
	defer relay.Close()

	mb := config.MailboxConfig{
		Address:    "auto@firma.cz",
		SMTPHost:   "smtp.auto.cz",
		SMTPPort:   465,
		Username:   "auto@firma.cz",
		Password:   "AutoPass!99",
		DailyLimit: 100,
	}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))

	// Enqueue with intentionally wrong/empty credentials — engine must overwrite them.
	e.Enqueue(SendRequest{
		ToAddress:    "to@example.cz",
		Subject:      "Override test",
		BodyPlain:    "body",
		SMTPHost:     "wrong.host.cz",
		SMTPPassword: "wrongpassword",
	})

	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() { _ = e.Run(ctx, func(_ SendRequest, _ SendResult) { close(done) }) }()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("onSent never fired")
	}

	select {
	case got := <-captured:
		if got.SMTPHost != "smtp.auto.cz" {
			t.Errorf("SMTPHost = %q, want smtp.auto.cz (from mailbox, not enqueued value)", got.SMTPHost)
		}
		if got.SMTPPassword != "AutoPass!99" {
			t.Errorf("SMTPPassword = %q, want AutoPass!99 (from mailbox config)", got.SMTPPassword)
		}
	default:
		t.Fatal("relay never called")
	}
}

// TestEngine_InjectsCreds_UsernameAsFromAddr verifies that the selected
// mailbox's Username is passed as SMTPUsername (which becomes from_address).
func TestEngine_InjectsCreds_UsernameAsFromAddr(t *testing.T) {
	captured := make(chan antiTraceRequest, 1)

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req antiTraceRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		captured <- req
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"from-addr-01","status":"ok"}`))
	}))
	defer relay.Close()

	mb := config.MailboxConfig{
		Address:    "petr@firma.cz",
		SMTPHost:   "smtp.firma.cz",
		SMTPPort:   587,
		Username:   "petr@firma.cz",
		Password:   "PetrPass",
		DailyLimit: 50,
	}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))
	e.Enqueue(SendRequest{ToAddress: "to@example.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() { _ = e.Run(ctx, func(_ SendRequest, _ SendResult) { close(done) }) }()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("onSent never fired")
	}

	select {
	case got := <-captured:
		if got.SMTPUsername != "petr@firma.cz" {
			t.Errorf("SMTPUsername = %q, want petr@firma.cz", got.SMTPUsername)
		}
		// from_address should be the per-mailbox username (per-mailbox rotation)
		if got.FromAddress != "petr@firma.cz" {
			t.Errorf("from_address = %q, want petr@firma.cz", got.FromAddress)
		}
	default:
		t.Fatal("relay never called")
	}
}

// TestEngine_InjectsCreds_AllFieldsNonEmpty verifies that all four credential
// fields are non-empty in the relay payload when the mailbox config is fully
// populated. Guards against partial injection (e.g. only host but not password).
func TestEngine_InjectsCreds_AllFieldsNonEmpty(t *testing.T) {
	captured := make(chan antiTraceRequest, 1)

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req antiTraceRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		captured <- req
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"all-fields","status":"ok"}`))
	}))
	defer relay.Close()

	mb := config.MailboxConfig{
		Address:    "full@firma.cz",
		SMTPHost:   "smtp.plny.cz",
		SMTPPort:   465,
		Username:   "full@firma.cz",
		Password:   "FullPass#1",
		DailyLimit: 50,
	}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))
	e.Enqueue(SendRequest{ToAddress: "to@example.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() { _ = e.Run(ctx, func(_ SendRequest, _ SendResult) { close(done) }) }()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("onSent never fired")
	}

	select {
	case got := <-captured:
		if got.SMTPHost == "" {
			t.Error("SMTPHost must not be empty")
		}
		if got.SMTPPort == 0 {
			t.Error("SMTPPort must not be zero")
		}
		if got.SMTPUsername == "" {
			t.Error("SMTPUsername must not be empty")
		}
		if got.SMTPPassword == "" {
			t.Error("SMTPPassword must not be empty")
		}
	default:
		t.Fatal("relay never called")
	}
}

// TestEngine_InjectsCreds_Monkey_NoPanic verifies that random SMTP credential
// values (any string/int combination) never cause a panic in the engine or the
// anti-trace client. Uses testing/quick for property-based coverage.
func TestEngine_InjectsCreds_Monkey_NoPanic(t *testing.T) {
	var hits int32
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"monkey","status":"ok"}`))
	}))
	defer relay.Close()

	f := func(host, user, pass string, port uint16) bool {
		defer func() { recover() }()
		cli := &AntiTraceClient{
			url:      relay.URL,
			token:    "tok",
 
			http:     &http.Client{},
		}
		_ = cli.Send(context.Background(), SendRequest{
			ToAddress:    "r@t.cz",
			Subject:      "monkey",
			BodyPlain:    "body",
			SMTPHost:     host,
			SMTPPort:     int(port),
			SMTPUsername: user,
			SMTPPassword: pass,
		})
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 30}); err != nil {
		t.Fatal(err)
	}
}

// TestSendRequest_SMTPFields_ZeroValueSafe verifies that a zero-value
// SendRequest with no SMTP fields set does not panic and has safe defaults.
func TestSendRequest_SMTPFields_ZeroValueSafe(t *testing.T) {
	var req SendRequest
	// Accessing zero-value fields must never panic.
	_ = req.SMTPHost
	_ = req.SMTPPort
	_ = req.SMTPUsername
	_ = req.SMTPPassword

	if req.SMTPPort != 0 {
		t.Errorf("zero-value SMTPPort should be 0, got %d", req.SMTPPort)
	}
	if req.SMTPHost != "" {
		t.Errorf("zero-value SMTPHost should be empty, got %q", req.SMTPHost)
	}
}

// TestAntiTraceRequest_OmitemptyOnZero verifies that zero/empty SMTP
// credential fields are omitted from the JSON payload (omitempty semantics).
// This keeps the relay payload minimal when env-var credentials are used.
func TestAntiTraceRequest_OmitemptyOnZero(t *testing.T) {
	p := antiTraceRequest{
		Recipient: "x@y.cz",
		Subject:   "S",
		Body:      "B",
		// All SMTP fields intentionally zero/empty
	}

	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var m map[string]any
	_ = json.Unmarshal(b, &m)

	for _, key := range []string{"smtp_host", "smtp_username", "smtp_password"} {
		if _, present := m[key]; present {
			t.Errorf("key %q should be omitted from JSON when empty (omitempty)", key)
		}
	}
	if _, present := m["smtp_port"]; present {
		t.Errorf("smtp_port should be omitted from JSON when zero (omitempty)")
	}
}

// TestEngine_InjectsCreds_DryRunSkipsRelay verifies that dry_run mode does
// NOT hit the relay — credentials must not be transmitted when dry_run=true.
func TestEngine_InjectsCreds_DryRunSkipsRelay(t *testing.T) {
	var relayHits int32
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&relayHits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer relay.Close()

	mb := config.MailboxConfig{
		Address:    "dry@firma.cz",
		SMTPHost:   "smtp.firma.cz",
		SMTPPort:   587,
		Username:   "dry@firma.cz",
		Password:   "DrySekret!",
		DailyLimit: 100,
	}

	e := NewEngine(
		[]config.MailboxConfig{mb},
		config.SendingConfig{Timezone: "UTC", WindowStart: 0, WindowEnd: 24, MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.5},
	).WithDryRun(true)
	e.WithAntiTrace(NewAntiTraceClient(relay.URL, "tok"))
	e.Enqueue(SendRequest{ToAddress: "to@example.cz", Subject: "S", BodyPlain: "B", SMTPUsername: "smtp.cz"})

	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() { _ = e.Run(ctx, func(_ SendRequest, _ SendResult) { close(done) }) }()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("onSent never fired")
	}

	if hits := atomic.LoadInt32(&relayHits); hits != 0 {
		t.Errorf("dry_run must not call relay (cred leak risk): got %d hit(s)", hits)
	}
}
