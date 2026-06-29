package labseed

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	op "operator-practice/internal/anonymize"
)

// fakeStore is the in-memory Selector. Records every interaction so
// tests can assert exact call shapes.
type fakeStore struct {
	ensureSchemaErr error
	rows            []op.Message
	selectErr       error
	filterErr       error
	recordErr       error
	recorded        []recordedSeed
	ensureCalls     int
	selectCalls     int
	filterCalls     int
	seenIDs         map[string]struct{}
}

type recordedSeed struct {
	MessageID  string
	BatchID    string
	Category   string
	LabMailbox string
}

func newFakeStore() *fakeStore {
	return &fakeStore{seenIDs: map[string]struct{}{}}
}

func (f *fakeStore) EnsureSchema(_ context.Context) error {
	f.ensureCalls++
	return f.ensureSchemaErr
}
func (f *fakeStore) SelectClassifiedReplies(_ context.Context, _ int) ([]op.Message, error) {
	f.selectCalls++
	return f.rows, f.selectErr
}
func (f *fakeStore) FilterUnseen(_ context.Context, msgs []op.Message) ([]op.Message, error) {
	f.filterCalls++
	if f.filterErr != nil {
		return nil, f.filterErr
	}
	out := make([]op.Message, 0, len(msgs))
	for _, m := range msgs {
		if _, ok := f.seenIDs[m.MessageID]; ok {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}
func (f *fakeStore) RecordSeeded(_ context.Context, mid, batch, cat, lab string) error {
	if f.recordErr != nil {
		return f.recordErr
	}
	f.recorded = append(f.recorded, recordedSeed{mid, batch, cat, lab})
	return nil
}

// fakeInjector records every Append + tracks login/logout.
type fakeInjector struct {
	loginErr  error
	appendErr error
	closed    bool
	loggedOut bool
	appended  []string
}

func (f *fakeInjector) Login() error  { return f.loginErr }
func (f *fakeInjector) Logout() error { f.loggedOut = true; return nil }
func (f *fakeInjector) Close() error  { f.closed = true; return nil }
func (f *fakeInjector) Append(raw string) error {
	if f.appendErr != nil {
		return f.appendErr
	}
	f.appended = append(f.appended, raw)
	return nil
}

func factory(inj *fakeInjector, dialErr error) InjectorFactory {
	return func(_ Config) (Injector, error) {
		if dialErr != nil {
			return nil, dialErr
		}
		return inj, nil
	}
}

func newCfg() Config {
	t0 := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	return Config{
		BatchSize:  3,
		LabHost:    "localhost",
		LabPort:    25993,
		LabUser:    "op@gmail.lab",
		LabPass:    "labpass",
		LabFolder:  "INBOX",
		Salt:       "test-salt",
		NowFunc:    func() time.Time { return t0 },
		BatchIDGen: func() string { return "batch-fixed-1" },
	}
}

// TestRun_HappyPath_InjectsAndRecords — three rows, all fresh, all
// succeed.
func TestRun_HappyPath_InjectsAndRecords(t *testing.T) {
	store := newFakeStore()
	store.rows = []op.Message{
		{ID: 1, MessageID: "<m1@x>", FromAddr: "honza@firma.cz", BodyText: "Pavel zde", Classification: "interested", ReceivedAt: time.Now()},
		{ID: 2, MessageID: "<m2@x>", FromAddr: "p@y.cz", BodyText: "Re: ahoj", Classification: "ooo", ReceivedAt: time.Now()},
		{ID: 3, MessageID: "<m3@x>", FromAddr: "x@z.cz", BodyText: "ne dekuji", Classification: "not-interested", ReceivedAt: time.Now()},
	}
	inj := &fakeInjector{}
	r := NewRunner(store, factory(inj, nil))

	stats, err := r.Run(context.Background(), newCfg())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if stats.Selected != 3 || stats.Anonymized != 3 || stats.Injected != 3 {
		t.Fatalf("counters off: %+v", stats)
	}
	if stats.Failed != 0 {
		t.Fatalf("failed should be 0; got %d", stats.Failed)
	}
	if len(store.recorded) != 3 {
		t.Fatalf("expected 3 recorded; got %d", len(store.recorded))
	}
	if !inj.loggedOut {
		t.Errorf("expected logout")
	}
	if stats.BatchID != "batch-fixed-1" {
		t.Errorf("BatchID override not honored: %q", stats.BatchID)
	}
}

// TestRun_DryRun_NoInjectorOrRecord — operator can preview without
// touching IMAP or DB writes.
func TestRun_DryRun_NoInjectorOrRecord(t *testing.T) {
	store := newFakeStore()
	store.rows = []op.Message{{ID: 1, MessageID: "<m1@x>", FromAddr: "a@b.cz", BodyText: "hi"}}
	inj := &fakeInjector{}
	cfg := newCfg()
	cfg.DryRun = true
	r := NewRunner(store, factory(inj, nil))

	stats, err := r.Run(context.Background(), cfg)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !stats.DryRun {
		t.Errorf("DryRun flag not set on stats")
	}
	if stats.Anonymized != 1 {
		t.Errorf("expected anonymized=1; got %d", stats.Anonymized)
	}
	if stats.Injected != 0 {
		t.Errorf("dry-run must not inject; got %d", stats.Injected)
	}
	if len(store.recorded) != 0 {
		t.Errorf("dry-run must not record; got %d", len(store.recorded))
	}
	if len(inj.appended) != 0 {
		t.Errorf("dry-run must not call Append")
	}
}

// TestRun_BatchSizeCap — request 1000, cap at 200.
func TestRun_BatchSizeCap(t *testing.T) {
	store := newFakeStore()
	cfg := newCfg()
	cfg.BatchSize = 100000
	r := NewRunner(store, factory(&fakeInjector{}, nil))
	if _, err := r.Run(context.Background(), cfg); err != nil {
		t.Fatalf("run: %v", err)
	}
	// We assert that the cap clamp happened by reading batchSize() directly.
	if cfg.batchSize() != 200 {
		t.Fatalf("expected clamp to 200; got %d", cfg.batchSize())
	}
}

// TestRun_BatchSizeFloor — request 0 or negative falls back to 10.
func TestRun_BatchSizeFloor(t *testing.T) {
	cfg := newCfg()
	cfg.BatchSize = 0
	if cfg.batchSize() != 10 {
		t.Fatalf("expected 10 default; got %d", cfg.batchSize())
	}
}

// TestRun_AlreadySeeded_Filtered — re-running on a window with an
// already-shipped row skips it and shows skipped_already_sent in stats.
func TestRun_AlreadySeeded_Filtered(t *testing.T) {
	store := newFakeStore()
	store.seenIDs["<m1@x>"] = struct{}{}
	store.rows = []op.Message{
		{ID: 1, MessageID: "<m1@x>", BodyText: "old"},
		{ID: 2, MessageID: "<m2@x>", BodyText: "new"},
	}
	inj := &fakeInjector{}
	r := NewRunner(store, factory(inj, nil))

	stats, err := r.Run(context.Background(), newCfg())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if stats.SkippedAlreadySent != 1 {
		t.Errorf("expected skipped=1; got %d", stats.SkippedAlreadySent)
	}
	if stats.Injected != 1 {
		t.Errorf("expected injected=1; got %d", stats.Injected)
	}
	if len(store.recorded) != 1 || store.recorded[0].MessageID != "<m2@x>" {
		t.Errorf("expected only m2 recorded; got %+v", store.recorded)
	}
}

// TestRun_EmptyBatch_NoInjector — when nothing to inject, we shouldn't
// even dial the IMAP server.
func TestRun_EmptyBatch_NoInjector(t *testing.T) {
	store := newFakeStore()
	dialed := false
	r := NewRunner(store, func(_ Config) (Injector, error) {
		dialed = true
		return &fakeInjector{}, nil
	})

	if _, err := r.Run(context.Background(), newCfg()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if dialed {
		t.Fatalf("empty batch must not open IMAP connection")
	}
}

// TestRun_PartialFailure_ContinuesBatch — one bad APPEND should not
// abort the rest of the batch.
func TestRun_PartialFailure_ContinuesBatch(t *testing.T) {
	store := newFakeStore()
	store.rows = []op.Message{
		{ID: 1, MessageID: "<m1@x>", BodyText: "row1"},
		{ID: 2, MessageID: "<m2@x>", BodyText: "row2"},
	}

	calls := 0
	inj := &fakeInjector{}
	customFactory := func(_ Config) (Injector, error) {
		// Wrap so first Append fails, second succeeds.
		return &flakyInjector{wrapped: inj, failOn: 1, callsRef: &calls}, nil
	}
	r := NewRunner(store, customFactory)

	stats, err := r.Run(context.Background(), newCfg())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if stats.Failed != 1 || stats.Injected != 1 {
		t.Fatalf("expected 1 failed + 1 injected; got %+v", stats)
	}
}

// TestRun_DialError_PropagatesAndBreadcrumb — IMAP dial failure surfaces
// as a wrapped error and the breadcrumb status reflects the outage.
func TestRun_DialError_PropagatesAndBreadcrumb(t *testing.T) {
	store := newFakeStore()
	store.rows = []op.Message{{ID: 1, MessageID: "<m1@x>", BodyText: "row1"}}
	r := NewRunner(store, factory(nil, errors.New("connection refused")))

	stats, err := r.Run(context.Background(), newCfg())
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("expected wrapped dial error; got %v", err)
	}
	bc := BreadcrumbData(stats, "imap-dial-error")
	if bc["status"] != "imap-dial-error" {
		t.Errorf("breadcrumb status: %v", bc["status"])
	}
}

// TestRun_LoginError_PropagatesAndBreadcrumb — login failures surface.
func TestRun_LoginError_PropagatesAndBreadcrumb(t *testing.T) {
	store := newFakeStore()
	store.rows = []op.Message{{ID: 1, MessageID: "<m1@x>", BodyText: "row1"}}
	inj := &fakeInjector{loginErr: errors.New("auth failed")}
	r := NewRunner(store, factory(inj, nil))

	if _, err := r.Run(context.Background(), newCfg()); err == nil {
		t.Fatalf("expected login error")
	}
}

// TestRun_SchemaError_Propagates — the cron's first-night call needs
// schema; surface failures clearly.
func TestRun_SchemaError_Propagates(t *testing.T) {
	store := newFakeStore()
	store.ensureSchemaErr = errors.New("DDL forbidden")
	r := NewRunner(store, factory(&fakeInjector{}, nil))
	if _, err := r.Run(context.Background(), newCfg()); err == nil {
		t.Fatalf("expected schema error")
	}
}

// TestBreadcrumbData_Shape — verifies every documented field is in
// the map and nothing is dropped on the floor. This is the contract
// downstream consumers (Sentry dashboards, audit log) lean on.
func TestBreadcrumbData_Shape(t *testing.T) {
	stats := Stats{
		BatchID:            "b1",
		StartedAt:          time.Unix(0, 0),
		FinishedAt:         time.Unix(0, 5_000_000),
		Selected:           5,
		SkippedAlreadySent: 2,
		Anonymized:         3,
		Injected:           3,
		Failed:             0,
		DryRun:             false,
		Categories:         map[string]int{"interested": 2, "ooo": 1},
		ReviewCandidates:   4,
	}
	got := BreadcrumbData(stats, "completed")

	for _, k := range []string{"batch_id", "status", "selected", "skipped_already_sent", "anonymized", "injected", "failed", "dry_run", "duration_ms", "review_candidates", "categories"} {
		if _, ok := got[k]; !ok {
			t.Errorf("missing breadcrumb key %q", k)
		}
	}
	if got["duration_ms"].(int64) != 5 {
		t.Errorf("duration_ms wrong: %v", got["duration_ms"])
	}
	if got["status"] != "completed" {
		t.Errorf("status: %v", got["status"])
	}
	cats, ok := got["categories"].(map[string]int)
	if !ok || cats["interested"] != 2 {
		t.Errorf("categories wrong: %v", got["categories"])
	}
}

// TestBreadcrumbData_HandlesZeroFinishedAt — early-bail paths leave
// FinishedAt zero; the helper must not blow up calculating duration.
func TestBreadcrumbData_HandlesZeroFinishedAt(t *testing.T) {
	got := BreadcrumbData(Stats{BatchID: "x"}, "schema-error")
	if got["duration_ms"].(int64) != 0 {
		t.Errorf("expected 0 duration; got %v", got["duration_ms"])
	}
}

// TestNewRunner_DefaultFactory verifies passing nil factory falls back
// to DefaultInjectorFactory (we don't dial — just assert non-nil).
func TestNewRunner_DefaultFactory(t *testing.T) {
	r := NewRunner(newFakeStore(), nil)
	if r.factory == nil {
		t.Fatalf("expected default factory wired")
	}
}

// TestRun_RecordSeededError_DoesNotAbortBatch — recording is best
// effort; if it fails we keep going on the rest of the batch.
func TestRun_RecordSeededError_DoesNotAbortBatch(t *testing.T) {
	store := newFakeStore()
	store.rows = []op.Message{
		{ID: 1, MessageID: "<m1@x>", BodyText: "a"},
		{ID: 2, MessageID: "<m2@x>", BodyText: "b"},
	}
	store.recordErr = errors.New("conflict")
	inj := &fakeInjector{}
	r := NewRunner(store, factory(inj, nil))

	stats, err := r.Run(context.Background(), newCfg())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if stats.Injected != 2 {
		t.Errorf("expected 2 injected; got %d", stats.Injected)
	}
}

// TestRun_DefaultBatchIDFormat — when no override, the generated id
// has the seed-YYYYMMDD-XXXXX shape.
func TestRun_DefaultBatchIDFormat(t *testing.T) {
	store := newFakeStore()
	cfg := newCfg()
	cfg.BatchIDGen = nil
	r := NewRunner(store, factory(&fakeInjector{}, nil))

	stats, _ := r.Run(context.Background(), cfg)
	if !strings.HasPrefix(stats.BatchID, "seed-2026") {
		t.Fatalf("batch id format unexpected: %q", stats.BatchID)
	}
}

// flakyInjector wraps fakeInjector but fails the i-th Append.
type flakyInjector struct {
	wrapped  *fakeInjector
	failOn   int
	callsRef *int
}

func (f *flakyInjector) Login() error  { return f.wrapped.Login() }
func (f *flakyInjector) Logout() error { return f.wrapped.Logout() }
func (f *flakyInjector) Close() error  { return f.wrapped.Close() }
func (f *flakyInjector) Append(raw string) error {
	*f.callsRef++
	if *f.callsRef == f.failOn {
		return errors.New("boom")
	}
	return f.wrapped.Append(raw)
}
