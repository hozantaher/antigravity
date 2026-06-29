package enrichment

import "context"

// JusticeCZSource is the deferred fallback source documented in the KT-A9
// design doc (section 3.1). Live HTML scraping of or.justice.cz is parked
// for a follow-on sprint because it requires anti-bot bypass and a DOM
// parser. The stub returns (nil, nil) for every lookup so the pipeline
// fallback chain compiles, runs, and is exercised by tests.
//
// To replace this stub: implement Lookup against or.justice.cz, keep the
// (Name, Priority, IsAvailable, Lookup) shape unchanged, and remove the
// "deferred" marker. The pipeline will pick up the new behaviour without
// any other code change.
type JusticeCZSource struct {
	probe HealthProbe
}

// NewJusticeCZSource returns the deferred stub.
func NewJusticeCZSource(probe HealthProbe) *JusticeCZSource {
	return &JusticeCZSource{probe: probe}
}

// Name returns the closed-vocabulary identifier.
func (s *JusticeCZSource) Name() SourceName { return SourceJusticeCZ }

// Priority returns 3 — last-resort fallback.
func (s *JusticeCZSource) Priority() int { return 3 }

// IsAvailable returns false by default (deferred stub). When a probe is
// supplied and reports >= 0.3, the stub still returns true so callers can
// flip availability on for integration tests of the future implementation.
func (s *JusticeCZSource) IsAvailable(ctx context.Context) bool {
	if ctx.Err() != nil {
		return false
	}
	if s.probe == nil {
		// Deferred — not actually reachable yet.
		return false
	}
	return s.probe() >= 0.3
}

// Lookup is intentionally a no-op until the live implementation lands. It
// always returns (nil, nil), which the merge layer treats as "source
// attempted, not found".
func (s *JusticeCZSource) Lookup(ctx context.Context, ico string) (*CompanyData, error) {
	if ico == "" {
		return nil, ErrICORequired
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, nil
}
