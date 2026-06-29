package enrichment

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// stubSource is a programmable EnrichmentSource for pipeline tests.
type stubSource struct {
	name      SourceName
	priority  int
	available bool
	delay     time.Duration
	data      *CompanyData
	err       error
	calls     int32
}

func (s *stubSource) Name() SourceName                   { return s.name }
func (s *stubSource) Priority() int                      { return s.priority }
func (s *stubSource) IsAvailable(_ context.Context) bool { return s.available }
func (s *stubSource) Lookup(ctx context.Context, _ string) (*CompanyData, error) {
	atomic.AddInt32(&s.calls, 1)
	if s.delay > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(s.delay):
		}
	}
	return s.data, s.err
}

func newARESStub(d *CompanyData, err error) *stubSource {
	return &stubSource{name: SourceARES, priority: 1, available: true, data: d, err: err}
}
func newFirmyStub(d *CompanyData, err error) *stubSource {
	return &stubSource{name: SourceFirmyCZ, priority: 2, available: true, data: d, err: err}
}
func newJusticeStub(d *CompanyData, err error) *stubSource {
	return &stubSource{name: SourceJusticeCZ, priority: 3, available: true, data: d, err: err}
}

func TestPipeline_Enrich_EmptyICO(t *testing.T) {
	p := NewPipeline(newARESStub(&CompanyData{ICO: "1"}, nil))
	res, err := p.Enrich(context.Background(), 42, "")
	if !errors.Is(err, ErrICORequired) {
		t.Errorf("err = %v want ErrICORequired", err)
	}
	if res.Log.ContactID != 42 {
		t.Errorf("ContactID = %d want 42", res.Log.ContactID)
	}
	if res.Log.EnrichmentOutcome != OutcomeNone {
		t.Errorf("outcome = %q want %q", res.Log.EnrichmentOutcome, OutcomeNone)
	}
}

func TestPipeline_Enrich_BothPrimariesSucceed_Merged(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "AR Name", PravniForma: "112"}, nil)
	firmy := newFirmyStub(&CompanyData{ICO: "X", Email: "k@x.cz"}, nil)

	p := NewPipeline(ares, firmy)
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeMerged {
		t.Errorf("outcome = %q want merged", res.Log.EnrichmentOutcome)
	}
	if res.Data.Name != "AR Name" || res.Data.Email != "k@x.cz" {
		t.Errorf("merged data = %+v", res.Data)
	}
	if len(res.Log.SourcesSuccess) != 2 {
		t.Errorf("success len = %d want 2", len(res.Log.SourcesSuccess))
	}
}

func TestPipeline_Enrich_OnlyARESSucceeds(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "Only ARES"}, nil)
	firmy := newFirmyStub(nil, nil) // cache miss
	p := NewPipeline(ares, firmy)

	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeARESOnly {
		t.Errorf("outcome = %q want ares_only", res.Log.EnrichmentOutcome)
	}
	if res.Data.Name != "Only ARES" {
		t.Errorf("Name = %q", res.Data.Name)
	}
}

func TestPipeline_Enrich_OnlyFirmySucceeds(t *testing.T) {
	ares := newARESStub(nil, nil) // 404
	firmy := newFirmyStub(&CompanyData{ICO: "X", Email: "k@x.cz", Name: "Only Firmy"}, nil)
	p := NewPipeline(ares, firmy)

	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeFirmyOnly {
		t.Errorf("outcome = %q want firmy_cz_only", res.Log.EnrichmentOutcome)
	}
	if res.Data.Email != "k@x.cz" {
		t.Errorf("Email = %q", res.Data.Email)
	}
}

func TestPipeline_Enrich_BothPrimariesEmpty_FallsBackToJustice(t *testing.T) {
	ares := newARESStub(nil, nil)
	firmy := newFirmyStub(nil, nil)
	justice := newJusticeStub(&CompanyData{ICO: "X", Name: "Justice Provided"}, nil)

	p := NewPipeline(ares, firmy, justice)
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeJusticeFallback {
		t.Errorf("outcome = %q want justice_cz_fallback", res.Log.EnrichmentOutcome)
	}
	if res.Data.Name != "Justice Provided" {
		t.Errorf("Name = %q", res.Data.Name)
	}
	if atomic.LoadInt32(&justice.calls) == 0 {
		t.Errorf("justice source was never called")
	}
}

func TestPipeline_Enrich_AllSourcesEmpty_NoneOutcome(t *testing.T) {
	p := NewPipeline(newARESStub(nil, nil), newFirmyStub(nil, nil), newJusticeStub(nil, nil))
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeNone {
		t.Errorf("outcome = %q want none", res.Log.EnrichmentOutcome)
	}
	if len(res.Log.SourcesSuccess) != 0 {
		t.Errorf("success len = %d want 0", len(res.Log.SourcesSuccess))
	}
	// All three sources still attempted.
	if len(res.Log.SourcesAttempted) != 3 {
		t.Errorf("attempted len = %d want 3", len(res.Log.SourcesAttempted))
	}
}

func TestPipeline_Enrich_UnavailableSourceSkipped(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "X"}, nil)
	ares.available = false // KT-A7 cooldown
	firmy := newFirmyStub(&CompanyData{ICO: "X", Email: "f@x.cz"}, nil)

	p := NewPipeline(ares, firmy)
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&ares.calls) != 0 {
		t.Errorf("unavailable ARES source was called")
	}
	if res.Log.EnrichmentOutcome != OutcomeFirmyOnly {
		t.Errorf("outcome = %q want firmy_cz_only", res.Log.EnrichmentOutcome)
	}
}

func TestPipeline_Enrich_PrimaryParallel_FastestDoesntBlockSlowest(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "ARES"}, nil)
	ares.delay = 50 * time.Millisecond
	firmy := newFirmyStub(&CompanyData{ICO: "X", Email: "f@x.cz"}, nil)
	firmy.delay = 50 * time.Millisecond

	p := NewPipeline(ares, firmy)
	start := time.Now()
	_, err := p.Enrich(context.Background(), 1, "X")
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	// Sequential would be 100ms. Parallel must be < 90ms (allow scheduler slop).
	if elapsed > 90*time.Millisecond {
		t.Errorf("primary fan-out not parallel: elapsed=%v (want < 90ms)", elapsed)
	}
}

func TestPipeline_Enrich_PrimaryError_FallbackUsed(t *testing.T) {
	ares := newARESStub(nil, errors.New("boom"))
	firmy := newFirmyStub(nil, nil)
	justice := newJusticeStub(&CompanyData{ICO: "X", Name: "Recovered"}, nil)

	p := NewPipeline(ares, firmy, justice)
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeJusticeFallback {
		t.Errorf("outcome = %q want justice_cz_fallback", res.Log.EnrichmentOutcome)
	}
}

func TestPipeline_Enrich_SourcesAttemptedRecorded(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "X"}, nil)
	firmy := newFirmyStub(nil, nil)
	p := NewPipeline(firmy, ares) // intentionally unsorted at input
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Log.SourcesAttempted) != 2 {
		t.Fatalf("attempted = %v", res.Log.SourcesAttempted)
	}
	// Pipeline must sort by priority (ARES first).
	if res.Log.SourcesAttempted[0] != SourceARES {
		t.Errorf("attempted[0] = %q want ares", res.Log.SourcesAttempted[0])
	}
}

func TestPipeline_Enrich_DurationRecorded(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X"}, nil)
	ares.delay = 5 * time.Millisecond
	p := NewPipeline(ares)
	res, _ := p.Enrich(context.Background(), 1, "X")
	if res.Log.DurationMS < 1 {
		t.Errorf("DurationMS = %d, want >= 1", res.Log.DurationMS)
	}
}

func TestPipeline_Enrich_LogContactID(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "X"}, nil)
	p := NewPipeline(ares)
	res, _ := p.Enrich(context.Background(), 12345, "X")
	if res.Log.ContactID != 12345 {
		t.Errorf("ContactID = %d", res.Log.ContactID)
	}
	if res.Log.ICO != "X" {
		t.Errorf("ICO = %q", res.Log.ICO)
	}
}

func TestPipeline_Enrich_NoSources_NoneOutcome(t *testing.T) {
	p := NewPipeline()
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if res.Log.EnrichmentOutcome != OutcomeNone {
		t.Errorf("outcome = %q want none", res.Log.EnrichmentOutcome)
	}
}

func TestPipeline_Enrich_FallbackNotCalledWhenPrimarySucceeds(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "X"}, nil)
	justice := newJusticeStub(&CompanyData{ICO: "X", Name: "Should not be used"}, nil)
	p := NewPipeline(ares, justice)
	_, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&justice.calls) != 0 {
		t.Errorf("justice was called %d times — should be 0 when primary succeeds", justice.calls)
	}
}

func TestPipeline_Enrich_Conflicts_PropagatedToLog(t *testing.T) {
	ares := newARESStub(&CompanyData{ICO: "X", Name: "ARES Name", PravniForma: "112"}, nil)
	firmy := newFirmyStub(&CompanyData{ICO: "X", PravniForma: "Sro"}, nil)
	p := NewPipeline(ares, firmy)
	res, err := p.Enrich(context.Background(), 1, "X")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Log.MergeConflicts) != 1 {
		t.Fatalf("conflicts len = %d", len(res.Log.MergeConflicts))
	}
	if res.Log.MergeConflicts[0].Field != "pravni_forma" {
		t.Errorf("field = %q", res.Log.MergeConflicts[0].Field)
	}
	if res.Log.MergeConflicts[0].Resolved != SourceARES {
		t.Errorf("resolved = %q want ares", res.Log.MergeConflicts[0].Resolved)
	}
}
