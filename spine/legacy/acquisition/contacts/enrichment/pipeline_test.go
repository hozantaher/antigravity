package enrich

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// mockSummarizer implements DescriptionSummarizer for testing.
type mockSummarizer struct {
	result string
	err    error
	called bool
}

func (m *mockSummarizer) Summarize(_ context.Context, _ string) (string, error) {
	m.called = true
	return m.result, m.err
}

func TestPipeline_DescriptionSummarizerUsed(t *testing.T) {
	mock := &mockSummarizer{result: "Výroba strojů a kovových dílů."}
	p := NewPipeline(PipelineConfig{
		TargetIndustries:      []string{"machinery"},
		MinTargetingScore:       0,
		DescriptionSummarizer: mock,
	})
	raw := RawContact{
		Email:       "test@firma.cz",
		Name:        "Strojírny Praha s.r.o.",
		Description: strings.Repeat("Firma vyrábí stroje. ", 10), // >50 chars
	}
	result, reason := p.Enrich(raw)
	if reason != "" {
		t.Fatalf("unexpected skip: %s", reason)
	}
	if !mock.called {
		t.Error("summarizer was not called")
	}
	if result.DescriptionSnippet != "Výroba strojů a kovových dílů." {
		t.Errorf("snippet = %q, want LLM summary", result.DescriptionSnippet)
	}
}

func TestPipeline_DescriptionSummarizerNil_Truncates(t *testing.T) {
	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0,
	})
	longDesc := strings.Repeat("A", 600)
	raw := RawContact{
		Email:       "test@firma.cz",
		Name:        "Test s.r.o.",
		Description: longDesc,
	}
	result, reason := p.Enrich(raw)
	if reason != "" {
		t.Fatalf("unexpected skip: %s", reason)
	}
	if len(result.DescriptionSnippet) != 500 {
		t.Errorf("snippet len = %d, want 500 (truncated)", len(result.DescriptionSnippet))
	}
}

func TestPipeline_DescriptionSummarizerError_Truncates(t *testing.T) {
	mock := &mockSummarizer{err: errors.New("llm down")}
	p := NewPipeline(PipelineConfig{
		TargetIndustries:      []string{"machinery"},
		MinTargetingScore:       0,
		DescriptionSummarizer: mock,
	})
	longDesc := strings.Repeat("B", 600)
	raw := RawContact{
		Email:       "test@firma.cz",
		Name:        "Test s.r.o.",
		Description: longDesc,
	}
	result, reason := p.Enrich(raw)
	if reason != "" {
		t.Fatalf("unexpected skip: %s", reason)
	}
	if !mock.called {
		t.Error("summarizer should have been called")
	}
	if len(result.DescriptionSnippet) != 500 {
		t.Errorf("snippet len = %d, want 500 (truncated fallback)", len(result.DescriptionSnippet))
	}
}

func TestPipeline_CompanyStoreNilDoesNotPanic(t *testing.T) {
	// CompanyStore = nil (default) must not panic — LinkContactToCompany fallback is used.
	p := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0,
		CompanyStore:     nil,
	})
	raw := RawContact{
		Email:       "test@firma.cz",
		Name:        "Strojírny s.r.o.",
		FirmyCzID:   42,
		Description: "Výroba strojů.",
	}
	result, reason := p.Enrich(raw)
	if reason != "" {
		t.Fatalf("unexpected skip: %s", reason)
	}
	if result == nil {
		t.Fatal("expected enriched contact")
	}
	if result.FirmyCzID != 42 {
		t.Errorf("FirmyCzID = %d, want 42", result.FirmyCzID)
	}
}

func TestPipeline_ShortDescriptionSkipsSummarizer(t *testing.T) {
	mock := &mockSummarizer{result: "should not appear"}
	p := NewPipeline(PipelineConfig{
		TargetIndustries:      []string{"machinery"},
		MinTargetingScore:       0,
		DescriptionSummarizer: mock,
	})
	raw := RawContact{
		Email:       "test@firma.cz",
		Name:        "Test s.r.o.",
		Description: "Krátký popis.", // <50 chars
	}
	result, reason := p.Enrich(raw)
	if reason != "" {
		t.Fatalf("unexpected skip: %s", reason)
	}
	if mock.called {
		t.Error("summarizer should NOT be called for short descriptions")
	}
	if result.DescriptionSnippet != "Krátký popis." {
		t.Errorf("snippet = %q, want original short description", result.DescriptionSnippet)
	}
}

// ── withRetry ─────────────────────────────────────────────────────────────

func TestWithRetry_SucceedsFirstTry(t *testing.T) {
	calls := 0
	err := withRetry(context.Background(), 3, 0, func() error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
	if calls != 1 {
		t.Errorf("expected 1 call, got %d", calls)
	}
}

func TestWithRetry_RetriesOnError(t *testing.T) {
	calls := 0
	want := errors.New("transient")
	err := withRetry(context.Background(), 3, 0, func() error {
		calls++
		if calls < 3 {
			return want
		}
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil after 3rd try, got %v", err)
	}
	if calls != 3 {
		t.Errorf("expected 3 calls, got %d", calls)
	}
}

func TestWithRetry_ReturnsLastErrorAfterExhaustion(t *testing.T) {
	want := errors.New("always fails")
	err := withRetry(context.Background(), 3, 0, func() error {
		return want
	})
	if !errors.Is(err, want) {
		t.Errorf("expected %v, got %v", want, err)
	}
}

func TestWithRetry_RespectsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	calls := 0
	err := withRetry(ctx, 3, 1, func() error {
		calls++
		return errors.New("fail")
	})
	// Should stop early due to cancelled context.
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
	// At most 1 attempt should complete before context check triggers.
	if calls > 2 {
		t.Errorf("too many calls with cancelled context: %d", calls)
	}
}

// TestWithRetry_SleepInterruptedByContext pins that the sleep between retries
// actually executes (so it can be interrupted by context cancellation).
// Kills: `pipeline.go i < maxAttempts-1 → i > maxAttempts-1` — with the
// mutation, the sleep block is NEVER entered (i > maxAttempts-1 is always false
// for i in [0, maxAttempts-1]). So context cancellation during the sleep never
// fires, and all retries run immediately.
//
// Setup: 3 retries, delay=200ms, context timeout=50ms.
// With correct code: after 1st failure, sleep 200ms → context expires after 50ms
//   → ctx.Done fires during sleep → returns ctx.Err() after 1 attempt.
// With mutation (no sleep): all 3 attempts run before 50ms → returns last error.
func TestWithRetry_SleepInterruptedByContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	calls := 0
	err := withRetry(ctx, 3, 200*time.Millisecond, func() error {
		calls++
		return errors.New("transient")
	})

	if err == nil {
		t.Fatal("expected error")
	}
	// With correct code: sleep fires after 1st attempt, context expires during sleep
	// → at most 1 attempt completes before context cancellation returns.
	// With mutation (no sleep): 3 attempts run in < 1ms → calls == 3.
	if calls > 1 {
		t.Errorf("withRetry: calls = %d, want 1 (sleep should have caused context cancellation to stop retries)", calls)
	}
}
