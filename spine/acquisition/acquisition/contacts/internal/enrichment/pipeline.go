package enrichment

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// Pipeline orchestrates the multi-source enrichment fan-out.
//
// Behaviour (per KT-A9 design doc, section 3.4):
//  1. Filter sources by IsAvailable.
//  2. Fan out primary sources (Priority < 3) in parallel.
//  3. If at least one primary returned data → merge + return.
//  4. Otherwise consult fallback sources (Priority >= 3) sequentially.
//  5. Always emit a LogRow describing what happened (caller persists).
type Pipeline struct {
	sources []EnrichmentSource
}

// NewPipeline constructs a pipeline. The slice may contain any combination
// of primary + fallback sources; ordering is not significant (Pipeline
// sorts by Priority internally).
func NewPipeline(sources ...EnrichmentSource) *Pipeline {
	cp := make([]EnrichmentSource, len(sources))
	copy(cp, sources)
	sort.SliceStable(cp, func(i, j int) bool {
		return cp[i].Priority() < cp[j].Priority()
	})
	return &Pipeline{sources: cp}
}

// Result is the outcome of a single Pipeline.Enrich run.
type Result struct {
	Data      CompanyData
	Conflicts []MergeConflict
	Log       LogRow
}

// Enrich runs the multi-source fan-out for the given contact + ICO.
//
// The contactID is opaque to Pipeline — it is forwarded to LogRow so the
// caller can correlate the audit row to a contact.
func (p *Pipeline) Enrich(ctx context.Context, contactID int64, ico string) (Result, error) {
	if ico == "" {
		return Result{Log: LogRow{
			CreatedAt:         time.Now().UTC(),
			ContactID:         contactID,
			EnrichmentOutcome: OutcomeNone,
		}}, ErrICORequired
	}

	start := time.Now()

	// Partition sources into primary (Priority < 3) and fallback (>= 3).
	available := make([]EnrichmentSource, 0, len(p.sources))
	for _, s := range p.sources {
		if s.IsAvailable(ctx) {
			available = append(available, s)
		}
	}

	primaries := make([]EnrichmentSource, 0, len(available))
	fallbacks := make([]EnrichmentSource, 0, len(available))
	for _, s := range available {
		if s.Priority() < 3 {
			primaries = append(primaries, s)
		} else {
			fallbacks = append(fallbacks, s)
		}
	}

	attempted := make([]SourceName, 0, len(p.sources))
	for _, s := range p.sources {
		attempted = append(attempted, s.Name())
	}

	successPayloads := make([]SourcePayload, 0, len(p.sources))
	successNames := make([]SourceName, 0, len(p.sources))

	// Phase 1 — parallel primary fan-out.
	if len(primaries) > 0 {
		ress := runParallel(ctx, primaries, ico)
		for _, r := range ress {
			if r.err != nil {
				slog.Warn("enrichment primary source error",
					"op", "enrichment.Pipeline.Enrich/primary",
					"source", string(r.name),
					"contact_id", contactID,
					"ico", ico,
					"error", r.err,
				)
				continue
			}
			if r.data != nil {
				successPayloads = append(successPayloads, SourcePayload{Source: r.name, Data: r.data})
				successNames = append(successNames, r.name)
			}
		}
	}

	// Phase 2 — sequential fallback when no primary succeeded.
	if len(successPayloads) == 0 && len(fallbacks) > 0 {
		for _, s := range fallbacks {
			data, err := s.Lookup(ctx, ico)
			if err != nil {
				slog.Warn("enrichment fallback source error",
					"op", "enrichment.Pipeline.Enrich/fallback",
					"source", string(s.Name()),
					"contact_id", contactID,
					"ico", ico,
					"error", err,
				)
				continue
			}
			if data != nil {
				successPayloads = append(successPayloads, SourcePayload{Source: s.Name(), Data: data})
				successNames = append(successNames, s.Name())
				break
			}
		}
	}

	merged, conflicts, outcome := Merge(successPayloads)

	log := LogRow{
		CreatedAt:         time.Now().UTC(),
		ContactID:         contactID,
		ICO:               ico,
		SourcesAttempted:  attempted,
		SourcesSuccess:    successNames,
		MergeConflicts:    conflicts,
		EnrichmentOutcome: outcome,
		DurationMS:        int(time.Since(start) / time.Millisecond),
	}

	return Result{Data: merged, Conflicts: conflicts, Log: log}, nil
}

// parallelResult is a per-goroutine return value for runParallel.
type parallelResult struct {
	name SourceName
	data *CompanyData
	err  error
}

func runParallel(ctx context.Context, sources []EnrichmentSource, ico string) []parallelResult {
	results := make([]parallelResult, len(sources))
	var wg sync.WaitGroup
	for i, s := range sources {
		wg.Add(1)
		go func(idx int, src EnrichmentSource) {
			defer wg.Done()
			d, err := src.Lookup(ctx, ico)
			results[idx] = parallelResult{name: src.Name(), data: d, err: err}
		}(i, s)
	}
	wg.Wait()
	return results
}
