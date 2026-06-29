// Package auditenrich is the KT-A9.1 cron-cutover facade.
//
// It exposes the new multi-source enrichment Pipeline (which lives under
// services/contacts/internal/enrichment) to callers outside the contacts
// module — primarily the orchestrator cron entrypoint.
//
// Why this package exists:
//
//   - services/contacts/internal/enrichment is intentionally internal so
//     other modules cannot reach into the per-source primitives directly.
//   - The cron in services/orchestrator/cmd/outreach/main.go needs a single
//     entry point that runs Pipeline.Enrich + writes the enrichment_log
//     audit row for a batch of contacts before delegating actual contact
//     persistence to the legacy services/contacts/enrichment pipeline.
//
// Scope (deliberately narrow):
//
//   - Build the Pipeline from production ARES + firmy.cz + justice.cz
//     sources.
//   - For each input ICO, run Pipeline.Enrich and persist the LogRow.
//   - Failures (DB error, source error) are logged via slog with `op`
//     fields and never abort the cron — audit is best-effort.
//
// Out of scope (legacy still owns these):
//
//   - Honeypot detection, industry classification, targeting score, contact
//     INSERT, company linking — all handled by services/contacts/enrichment
//     after this package returns.
package auditenrich

import (
	"context"
	"database/sql"
	"log/slog"
	"sync"
	"time"

	"contacts/ares"
	"contacts/internal/enrichment"
)

// Runner orchestrates Pipeline.Enrich + enrichment_log audit for a batch of
// ICOs. It is constructed once per cron run (cheap — holds only references)
// and reused for every page in the prospect import loop.
type Runner struct {
	pipeline *enrichment.Pipeline
	writer   *enrichment.LogWriter
}

// NewRunner builds a Runner with production sources wired in.
//
// Inputs:
//   - db is the outreach Postgres handle (used by FirmyCZSource for the
//     firmy_cz_businesses cache lookup AND by LogWriter for the audit row
//     INSERT).
//   - aresClient is the existing rate-limited ARES fetcher.
//   - firmyStaleness caps how stale the firmy.cz cache row may be before
//     it is treated as a miss (90d default in production).
//
// Returns nil when db or aresClient is nil — the caller is expected to
// degrade gracefully (the cron skips audit but continues with legacy
// enrichment).
func NewRunner(db *sql.DB, aresClient *ares.Client, firmyStaleness time.Duration) *Runner {
	if db == nil || aresClient == nil {
		return nil
	}
	pipeline := enrichment.NewPipeline(
		enrichment.NewARESSource(aresClient, nil),
		enrichment.NewFirmyCZSource(db, firmyStaleness, nil),
		enrichment.NewJusticeCZSource(nil),
	)
	return &Runner{
		pipeline: pipeline,
		writer:   enrichment.NewLogWriter(db),
	}
}

// Input is one row of work for the runner. ContactID is whatever opaque ID
// the caller wants on the audit row — typically firmy_cz_id or 0 when the
// contact has not yet been INSERTed (the audit is correlated by ICO).
type Input struct {
	ContactID int64
	ICO       string
}

// Result mirrors the relevant fields the caller may want to inspect after
// AuditBatch completes. Counts are derived from the per-ICO outcomes.
type Result struct {
	Audited        int // total Pipeline.Enrich calls completed
	WriteFailures  int // best-effort writer errors (audit row dropped)
	SkippedNoICO   int // inputs with empty ICO (no audit row written)
}

// AuditBatch runs Pipeline.Enrich + LogWriter.Record for every input with a
// non-empty ICO. It is a no-op when r is nil (graceful degradation when the
// runner could not be constructed).
//
// The batch executes serially today: ARES has a 1 req/s rate limit and the
// new Pipeline already fans out per-source in parallel, so adding outer
// parallelism would blow the rate limit. KT-A10 may revisit when ARES gets
// per-instance budgeting.
func (r *Runner) AuditBatch(ctx context.Context, inputs []Input) Result {
	if r == nil {
		return Result{}
	}
	var res Result
	var mu sync.Mutex // guards res while we keep room to parallelise later

	for _, in := range inputs {
		if ctx.Err() != nil {
			break
		}
		if in.ICO == "" {
			mu.Lock()
			res.SkippedNoICO++
			mu.Unlock()
			continue
		}

		out, err := r.pipeline.Enrich(ctx, in.ContactID, in.ICO)
		if err != nil {
			// ErrICORequired is the only structural error from Pipeline.Enrich
			// today — already filtered above. Any other error is logged but
			// we still try to persist the LogRow so operators can see the
			// failure pattern.
			slog.Warn("enrichment audit: Pipeline.Enrich selhal",
				"op", "auditenrich.Runner.AuditBatch/enrich",
				"error", err,
				"contact_id", in.ContactID,
				"ico", in.ICO,
			)
		}

		if writeErr := r.writer.Record(ctx, out.Log); writeErr != nil {
			slog.Warn("enrichment audit: zapis enrichment_log selhal",
				"op", "auditenrich.Runner.AuditBatch/record",
				"error", writeErr,
				"contact_id", in.ContactID,
				"ico", in.ICO,
				"outcome", string(out.Log.EnrichmentOutcome),
			)
			mu.Lock()
			res.WriteFailures++
			mu.Unlock()
			continue
		}

		mu.Lock()
		res.Audited++
		mu.Unlock()
	}

	return res
}
