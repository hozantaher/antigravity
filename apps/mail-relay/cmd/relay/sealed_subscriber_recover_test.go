package main

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeScheduler lets tests inject panics or errors into Schedule.
type fakeScheduler struct {
	panicValue  any
	returnError error
	scheduledAt time.Time
	calls       int32
}

func (f *fakeScheduler) Schedule(ctx context.Context, env model.Envelope) (time.Time, error) {
	atomic.AddInt32(&f.calls, 1)
	if f.panicValue != nil {
		panic(f.panicValue)
	}
	if f.returnError != nil {
		return time.Time{}, f.returnError
	}
	if f.scheduledAt.IsZero() {
		return time.Now(), nil
	}
	return f.scheduledAt, nil
}

// fakeMixPool captures Submit calls; can panic on Submit when configured.
type fakeMixPool struct {
	panicValue any
	submits    int32
	size       int
}

func (f *fakeMixPool) Submit(env model.Envelope) {
	atomic.AddInt32(&f.submits, 1)
	if f.panicValue != nil {
		panic(f.panicValue)
	}
}

func (f *fakeMixPool) Size() int { return f.size }

// fakeAuditRecorder matches the auditRecorder interface used by handleSealedEnvelope.
type fakeAuditRecorder struct {
	returnError error
	calls       int32
	mu          sync.Mutex
	lastEvent   string
	events      []string
}

func (f *fakeAuditRecorder) Record(ctx context.Context, tenantID, eventType, envelopeID string) error {
	atomic.AddInt32(&f.calls, 1)
	f.mu.Lock()
	f.lastEvent = eventType
	f.events = append(f.events, eventType)
	f.mu.Unlock()
	return f.returnError
}

func makeEnvelope() model.Envelope {
	return model.Envelope{
		ID:         "env_test_123",
		TenantID:   "tenant_x",
		AliasToken: "alias_abc",
	}
}

func newTestLogger() *minlog.Logger { return minlog.New("test-relay") }

// H1.1 — Happy path: legacy schedule mode, no panic, scheduler + audit called.
func TestHandleSealedEnvelope_LegacyHappyPath(t *testing.T) {
	sched := &fakeScheduler{scheduledAt: time.Now().Add(30 * time.Second)}
	pool := &fakeMixPool{}
	aud := &fakeAuditRecorder{}

	handleSealedEnvelope(context.Background(), makeEnvelope(), "record-only", pool, sched, aud, newTestLogger())

	if got := atomic.LoadInt32(&sched.calls); got != 1 {
		t.Errorf("scheduler.Schedule calls = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&aud.calls); got != 1 {
		t.Errorf("audit.Record calls = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&pool.submits); got != 0 {
		t.Errorf("pool.Submit calls = %d, want 0 in legacy mode", got)
	}
}

// H1.2 — Happy path: deaddrop mode, no panic, pool.Submit + audit called.
func TestHandleSealedEnvelope_DeaddropHappyPath(t *testing.T) {
	sched := &fakeScheduler{}
	pool := &fakeMixPool{}
	aud := &fakeAuditRecorder{}

	handleSealedEnvelope(context.Background(), makeEnvelope(), "deaddrop", pool, sched, aud, newTestLogger())

	if got := atomic.LoadInt32(&pool.submits); got != 1 {
		t.Errorf("pool.Submit calls = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&aud.calls); got != 1 {
		t.Errorf("audit.Record calls = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&sched.calls); got != 0 {
		t.Errorf("scheduler.Schedule calls = %d, want 0 in deaddrop mode", got)
	}
}

// H1.3 — Scheduler panics with a string — must not escape, no calls crash the test.
func TestHandleSealedEnvelope_SchedulerPanicString(t *testing.T) {
	sched := &fakeScheduler{panicValue: "boom-string"}
	pool := &fakeMixPool{}
	aud := &fakeAuditRecorder{}

	// If recover is missing, this will crash the whole test binary.
	// We use defer+recover here only to convert an accidental leak into a test failure.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic leaked past handleSealedEnvelope: %v", r)
		}
	}()

	handleSealedEnvelope(context.Background(), makeEnvelope(), "record-only", pool, sched, aud, newTestLogger())

	if got := atomic.LoadInt32(&sched.calls); got != 1 {
		t.Errorf("scheduler.Schedule calls = %d, want 1", got)
	}
	// On panic we must NOT record audit success.
	if got := atomic.LoadInt32(&aud.calls); got != 0 {
		t.Errorf("audit.Record calls = %d, want 0 on panic", got)
	}
}

// H1.4 — Scheduler panics with an error value.
func TestHandleSealedEnvelope_SchedulerPanicError(t *testing.T) {
	sched := &fakeScheduler{panicValue: errors.New("boom-err")}
	pool := &fakeMixPool{}
	aud := &fakeAuditRecorder{}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic leaked past handleSealedEnvelope: %v", r)
		}
	}()

	handleSealedEnvelope(context.Background(), makeEnvelope(), "record-only", pool, sched, aud, newTestLogger())
}

// H1.5 — Panic with nil value — runtime behavior is tricky, but recover must still trap.
func TestHandleSealedEnvelope_PoolPanicNil(t *testing.T) {
	sched := &fakeScheduler{}
	// Non-nil panic (Go 1.21+ converts nil panics to *runtime.PanicNilError, but
	// we still test that the recover catches any panic value).
	pool := &fakeMixPool{panicValue: struct{}{}}
	aud := &fakeAuditRecorder{}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic leaked past handleSealedEnvelope: %v", r)
		}
	}()

	handleSealedEnvelope(context.Background(), makeEnvelope(), "deaddrop", pool, sched, aud, newTestLogger())

	if got := atomic.LoadInt32(&pool.submits); got != 1 {
		t.Errorf("pool.Submit calls = %d, want 1", got)
	}
}

// H1.6 — Schedule returns error (non-panic path): audit is NOT called, log emitted.
func TestHandleSealedEnvelope_ScheduleReturnsError(t *testing.T) {
	sched := &fakeScheduler{returnError: errors.New("schedule failed")}
	pool := &fakeMixPool{}
	aud := &fakeAuditRecorder{}

	handleSealedEnvelope(context.Background(), makeEnvelope(), "record-only", pool, sched, aud, newTestLogger())

	if got := atomic.LoadInt32(&sched.calls); got != 1 {
		t.Errorf("scheduler.Schedule calls = %d, want 1", got)
	}
	// On schedule error we must NOT record RelayScheduled audit.
	if got := atomic.LoadInt32(&aud.calls); got != 0 {
		t.Errorf("audit.Record calls = %d, want 0 on schedule error", got)
	}
}

// H1.7 — Audit failure after panic-free schedule: audit error is surfaced via recordOrLog,
// but does NOT crash the subscriber (the helper must keep going).
func TestHandleSealedEnvelope_AuditErrorDoesNotPanic(t *testing.T) {
	sched := &fakeScheduler{scheduledAt: time.Now()}
	pool := &fakeMixPool{}
	aud := &fakeAuditRecorder{returnError: errors.New("disk full")}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic leaked past handleSealedEnvelope: %v", r)
		}
	}()

	handleSealedEnvelope(context.Background(), makeEnvelope(), "record-only", pool, sched, aud, newTestLogger())

	if got := atomic.LoadInt32(&aud.calls); got != 1 {
		t.Errorf("audit.Record calls = %d, want 1 (audit should still be attempted)", got)
	}
}
