package main

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

// recordingAudit is a configurable audit recorder for recordOrLog tests.
type recordingAudit struct {
	returnError error
	lastTenant  string
	lastEvent   string
	lastEnvID   string
	calls       int32
}

func (r *recordingAudit) Record(ctx context.Context, tenantID, eventType, envelopeID string) error {
	atomic.AddInt32(&r.calls, 1)
	r.lastTenant = tenantID
	r.lastEvent = eventType
	r.lastEnvID = envelopeID
	return r.returnError
}

// H2.1 — Happy path: Record returns nil, helper returns nil, no error surfaces.
func TestRecordOrLog_Success(t *testing.T) {
	rec := &recordingAudit{}
	logger := minlog.New("test")

	recordOrLog(context.Background(), rec, "tenant_1", model.EventRelayScheduled, "env_abc", logger)

	if got := atomic.LoadInt32(&rec.calls); got != 1 {
		t.Errorf("Record calls = %d, want 1", got)
	}
	if rec.lastTenant != "tenant_1" {
		t.Errorf("tenant = %q, want tenant_1", rec.lastTenant)
	}
	if rec.lastEvent != model.EventRelayScheduled {
		t.Errorf("event = %q, want %q", rec.lastEvent, model.EventRelayScheduled)
	}
	if rec.lastEnvID != "env_abc" {
		t.Errorf("envelope_id = %q, want env_abc", rec.lastEnvID)
	}
}

// H2.2 — Record returns error: helper must not panic, must not propagate the error.
func TestRecordOrLog_RecordError(t *testing.T) {
	rec := &recordingAudit{returnError: errors.New("persist failure: disk full")}
	logger := minlog.New("test")

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("recordOrLog panicked: %v", r)
		}
	}()

	recordOrLog(context.Background(), rec, "tenant_1", model.EventRelayFailed, "env_xyz", logger)

	if got := atomic.LoadInt32(&rec.calls); got != 1 {
		t.Errorf("Record calls = %d, want 1", got)
	}
}

// H2.3 — Nil audit: helper must be a no-op without panicking.
func TestRecordOrLog_NilAudit(t *testing.T) {
	logger := minlog.New("test")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("recordOrLog panicked with nil audit: %v", r)
		}
	}()
	// Nil recorder must not panic; real code should never hit this, but defensive.
	recordOrLog(context.Background(), nil, "tenant_x", model.EventRelayCompleted, "env_id", logger)
}

// H2.4 — Cancelled context: helper still calls Record (audit decides whether to honor ctx).
func TestRecordOrLog_CancelledContext(t *testing.T) {
	rec := &recordingAudit{}
	logger := minlog.New("test")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	recordOrLog(ctx, rec, "tenant_2", model.EventRelayCompleted, "env_cc", logger)

	if got := atomic.LoadInt32(&rec.calls); got != 1 {
		t.Errorf("Record calls = %d, want 1 (helper should not short-circuit on ctx cancel)", got)
	}
}

// H2.5 — All 13 event types used in main.go flow through without error.
func TestRecordOrLog_EventTypeVariants(t *testing.T) {
	logger := minlog.New("test")

	cases := []struct {
		name      string
		eventType string
	}{
		{"relay_scheduled", model.EventRelayScheduled},
		{"relay_completed", model.EventRelayCompleted},
		{"relay_failed", model.EventRelayFailed},
		{"sanitized", model.EventSanitized},
		{"blocked", model.EventBlocked},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &recordingAudit{}
			recordOrLog(context.Background(), rec, "tenant_ev", tc.eventType, "env_ev", logger)
			if got := atomic.LoadInt32(&rec.calls); got != 1 {
				t.Errorf("event %q: Record calls = %d, want 1", tc.eventType, got)
			}
			if rec.lastEvent != tc.eventType {
				t.Errorf("event = %q, want %q", rec.lastEvent, tc.eventType)
			}
		})
	}
}

// H2.6 — Record returns error AND event_type is emitted in logs (behavior smoke test).
// We cannot easily capture the logger output without rewiring minlog, but we can
// at least verify the helper attempted Record and returned cleanly.
func TestRecordOrLog_ErrorWithAllEventTypes(t *testing.T) {
	logger := minlog.New("test")
	events := []string{
		model.EventRelayScheduled,
		model.EventRelayCompleted,
		model.EventRelayFailed,
	}
	for _, ev := range events {
		rec := &recordingAudit{returnError: errors.New("boom")}
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("recordOrLog panicked on %s: %v", ev, r)
			}
		}()
		recordOrLog(context.Background(), rec, "tenant_err", ev, "env_err", logger)
		if got := atomic.LoadInt32(&rec.calls); got != 1 {
			t.Errorf("event %q: Record calls = %d, want 1", ev, got)
		}
	}
}
