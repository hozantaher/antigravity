package watchdog

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"mailboxes/mailbox"
)

// fakeAuthFailsLister extends fakeAuthFails with a canned event list so the
// alert path (ListRecent → ShouldAlertOnAuthFail) fires deterministically.
type fakeAuthFailsLister struct {
	fakeAuthFails
	events map[int64][]AuthFailEvent
}

func (f *fakeAuthFailsLister) ListRecent(_ context.Context, mailboxID int64, _ time.Duration) ([]AuthFailEvent, error) {
	return f.events[mailboxID], nil
}

// buildDaemonForAlert returns a Daemon pre-loaded with 3 fresh auth fails
// for a single active mailbox so any Tick call fires exactly one alert.
func buildDaemonForAlert(webhookURL string, client *http.Client) (*Daemon, *fakeStore, *fakeEventSink) {
	now := time.Now()
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 1, FromAddress: "jan@sender.test", Status: mailbox.StatusActive,
		UpdatedAt: now,
	}}}
	events := &fakeEventSink{}
	fails := &fakeAuthFailsLister{
		fakeAuthFails: fakeAuthFails{counts: map[int64]int{1: 0}},
		events: map[int64][]AuthFailEvent{
			1: {
				{FailedAt: now.Add(-5 * time.Minute)},
				{FailedAt: now.Add(-3 * time.Minute)},
				{FailedAt: now.Add(-1 * time.Minute)},
			},
		},
	}
	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, AuthFails: fails,
		AuthThresh: 3, AuthWindow: time.Hour,
		AlertWebhookURL:    webhookURL,
		AlertWebhookClient: client,
	})
	return d, store, events
}

// TestDaemonAlertWebhook covers every status/transport branch of
// postAlertWebhook. Each case is independent; we rebuild the daemon per
// case so cooldown state is fresh.
func TestDaemonAlertWebhook(t *testing.T) {
	t.Run("200_ok_fires_and_records_event", func(t *testing.T) {
		var reqBody []byte
		var contentType string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				t.Errorf("webhook expected POST, got %s", r.Method)
			}
			contentType = r.Header.Get("Content-Type")
			reqBody, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		d, _, events := buildDaemonForAlert(srv.URL, srv.Client())
		if err := d.Tick(context.Background()); err != nil {
			t.Fatalf("tick: %v", err)
		}

		if contentType != "application/json" {
			t.Errorf("webhook content-type = %q, want application/json", contentType)
		}
		var payload map[string]any
		if err := json.Unmarshal(reqBody, &payload); err != nil {
			t.Fatalf("webhook body not JSON: %v (body=%s)", err, string(reqBody))
		}
		if id, ok := payload["mailbox_id"].(float64); !ok || int64(id) != 1 {
			t.Errorf("webhook payload mailbox_id = %v, want 1", payload["mailbox_id"])
		}
		if fc, ok := payload["fail_count"].(float64); !ok || int(fc) != 3 {
			t.Errorf("webhook payload fail_count = %v, want 3", payload["fail_count"])
		}
		var sawAlertEvent bool
		for _, e := range events.events {
			if e.Type == EventAuthFailAlert {
				sawAlertEvent = true
				if e.AutoHealed {
					t.Errorf("auth_fail_alert must NOT be auto_healed (needs human)")
				}
			}
		}
		if !sawAlertEvent {
			t.Errorf("expected auth_fail_alert event in sink, got %+v", events.events)
		}
	})

	t.Run("404_does_not_panic_event_still_recorded", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()

		d, _, events := buildDaemonForAlert(srv.URL, srv.Client())
		if err := d.Tick(context.Background()); err != nil {
			t.Fatalf("tick: %v", err)
		}
		// 4xx response is non-fatal; alert event still recorded
		// because the DB row is the canonical audit signal.
		var sawAlertEvent bool
		for _, e := range events.events {
			if e.Type == EventAuthFailAlert {
				sawAlertEvent = true
			}
		}
		if !sawAlertEvent {
			t.Errorf("alert event should be recorded even when webhook 404s")
		}
	})

	t.Run("500_error_is_swallowed_event_recorded", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, "boom")
		}))
		defer srv.Close()

		d, _, events := buildDaemonForAlert(srv.URL, srv.Client())
		// Must not panic, must not return error.
		if err := d.Tick(context.Background()); err != nil {
			t.Fatalf("tick should tolerate webhook 5xx: %v", err)
		}
		var sawAlertEvent bool
		for _, e := range events.events {
			if e.Type == EventAuthFailAlert {
				sawAlertEvent = true
			}
		}
		if !sawAlertEvent {
			t.Errorf("alert event should be recorded even when webhook 500s")
		}
	})

	t.Run("timeout_does_not_block_tick", func(t *testing.T) {
		// Server hangs until the test signals stop. We assert the client
		// timeout (150ms) fires cleanly without blocking the tick.
		stop := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-stop:
			case <-r.Context().Done():
			}
		}))
		t.Cleanup(func() {
			close(stop)
			srv.CloseClientConnections() // force any in-flight handlers to exit
			srv.Close()
		})

		client := &http.Client{Timeout: 150 * time.Millisecond}
		d, _, _ := buildDaemonForAlert(srv.URL, client)
		start := time.Now()
		if err := d.Tick(context.Background()); err != nil {
			t.Fatalf("tick should swallow webhook timeout: %v", err)
		}
		elapsed := time.Since(start)
		if elapsed > 2*time.Second {
			t.Errorf("tick took %s, webhook timeout should cap well under 2s", elapsed)
		}
	})

	t.Run("network_error_unreachable_host", func(t *testing.T) {
		// Pick a closed port on loopback so Dial fails immediately.
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := l.Addr().String()
		_ = l.Close() // close immediately so next Dial gets connection refused

		d, _, events := buildDaemonForAlert("http://"+addr, &http.Client{Timeout: time.Second})
		if err := d.Tick(context.Background()); err != nil {
			t.Fatalf("tick should swallow network error: %v", err)
		}
		var sawAlertEvent bool
		for _, e := range events.events {
			if e.Type == EventAuthFailAlert {
				sawAlertEvent = true
			}
		}
		if !sawAlertEvent {
			t.Errorf("alert event should be recorded even on network error")
		}
	})

	t.Run("no_webhook_configured_still_records_event", func(t *testing.T) {
		// Empty URL ⇒ webhook is a no-op. Event sink still sees the row.
		d, _, events := buildDaemonForAlert("", nil)
		if err := d.Tick(context.Background()); err != nil {
			t.Fatalf("tick: %v", err)
		}
		var sawAlertEvent bool
		for _, e := range events.events {
			if e.Type == EventAuthFailAlert {
				sawAlertEvent = true
			}
		}
		if !sawAlertEvent {
			t.Errorf("alert event should be recorded even when webhook unset")
		}
	})
}

// TestDaemonAuthAlert_Cooldown proves a second Tick within the 1h cooldown
// does NOT re-fire the alert (neither webhook nor event sink grows).
func TestDaemonAuthAlert_Cooldown(t *testing.T) {
	var postCount atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		postCount.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d, _, events := buildDaemonForAlert(srv.URL, srv.Client())

	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("tick 1: %v", err)
	}
	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("tick 2: %v", err)
	}
	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("tick 3: %v", err)
	}

	if got := postCount.Load(); got != 1 {
		t.Errorf("webhook POST count = %d across 3 ticks, want 1 (cooldown)", got)
	}
	var alertCount int
	for _, e := range events.events {
		if e.Type == EventAuthFailAlert {
			alertCount++
		}
	}
	if alertCount != 1 {
		t.Errorf("auth_fail_alert event count = %d, want 1 (cooldown)", alertCount)
	}
}
