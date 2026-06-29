package enrichment

import (
	"context"
	"fmt"

	"contacts/ares"
)

// ARESFetcher is the small contract this source needs from an ARES client.
// Defined here (consumer-side) to keep the dependency direction inward and
// allow easy mocking in tests. The production *ares.Client satisfies this
// interface.
type ARESFetcher interface {
	FetchSubject(ctx context.Context, ico string) (*ares.SubjectData, error)
}

// HealthProbe is an optional KT-A7 health hook. When provided, IsAvailable
// reports false if the probe returns 0 (source in cooldown). When nil, the
// source is treated as always available.
type HealthProbe func() float64

// ARESSource adapts the existing ares.Client to the EnrichmentSource
// contract. Authoritative for: ICO, DIC, name, právní forma, datum vzniku,
// sídlo, NACE, datová schránka.
type ARESSource struct {
	fetcher ARESFetcher
	probe   HealthProbe
}

// NewARESSource constructs an ARESSource. probe may be nil.
func NewARESSource(fetcher ARESFetcher, probe HealthProbe) *ARESSource {
	return &ARESSource{fetcher: fetcher, probe: probe}
}

// Name returns the closed-vocabulary identifier.
func (s *ARESSource) Name() SourceName { return SourceARES }

// Priority returns 1 — ARES is the highest-priority registry source.
func (s *ARESSource) Priority() int { return 1 }

// IsAvailable consults the optional KT-A7 health probe. Returns true when
// no probe is wired (default-available) or when the probe reports >= 0.3.
func (s *ARESSource) IsAvailable(ctx context.Context) bool {
	if ctx.Err() != nil {
		return false
	}
	if s.probe == nil {
		return true
	}
	return s.probe() >= 0.3
}

// Lookup fetches a subject from ARES and maps it onto CompanyData.
//
// Contract:
//   - empty ICO → ErrICORequired.
//   - ARES 404 → (nil, nil) (not found is not an error).
//   - transport / parse error → (nil, wrapped err).
func (s *ARESSource) Lookup(ctx context.Context, ico string) (*CompanyData, error) {
	if ico == "" {
		return nil, ErrICORequired
	}
	if s.fetcher == nil {
		return nil, fmt.Errorf("enrichment.ARESSource: fetcher is nil (op=ARESSource.Lookup/no-fetcher)")
	}

	sub, err := s.fetcher.FetchSubject(ctx, ico)
	if err != nil {
		return nil, fmt.Errorf("ares lookup %s: %w", ico, err)
	}
	if sub == nil {
		// 404 — not in registry.
		return nil, nil
	}

	data := &CompanyData{
		ICO:         sub.ICO,
		Name:        sub.ObchodniJmeno,
		PravniForma: sub.PravniForma,
		DatumVzniku: sub.DatumVzniku,
		NACECodes:   append([]string(nil), sub.NACECodes...),
		NACEPrimary: sub.NACEPrimary,
	}
	return data, nil
}
