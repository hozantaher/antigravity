// KT-A9.1 — enrichment_log writer.
//
// LogWriter persists one row per Pipeline.Enrich call into the
// enrichment_log audit table (migration 015). One row per call — even when
// no source returned data ("we tried this ICO three times and got nothing").
//
// Failure policy:
//   - DB writes are best-effort. A failed INSERT logs a warning and returns
//     the error to the caller, but the cron MUST treat LogWriter as
//     fire-and-forget — losing an audit row never fails enrichment.
//   - All inputs are passed via parameterised queries (lib/pq $N placeholders),
//     so attacker-controlled values (rare, but possible via firmy.cz scraped
//     descriptions surfacing in LogRow) cannot trigger SQL injection.
//   - Empty ICO is rejected: enrichment_log.ico is NOT NULL and the column
//     has no business meaning when the lookup never started.
package enrichment

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/lib/pq"
)

// dbExec is the narrow surface LogWriter needs from *sql.DB. Defined where
// it is consumed (per Go style: small interfaces near the consumer) so tests
// can supply an in-memory sqlmock without depending on the full *sql.DB API.
type dbExec interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// LogWriter inserts enrichment_log rows after every Pipeline.Enrich call.
type LogWriter struct {
	db dbExec
}

// NewLogWriter wires a writer around the given DB handle. The handle is held
// by reference; the caller owns its lifecycle.
func NewLogWriter(db dbExec) *LogWriter {
	return &LogWriter{db: db}
}

// insertEnrichmentLogSQL persists one Pipeline.Enrich result. The
// `created_at` column is left to the column DEFAULT NOW() so the DB owns
// the timestamp (consistent under cross-process clock drift).
const insertEnrichmentLogSQL = `
INSERT INTO enrichment_log
    (contact_id, ico, sources_attempted, sources_success,
     merge_conflicts, enrichment_source_used, duration_ms)
VALUES
    ($1, $2, $3, $4, $5::jsonb, $6, $7)
`

// Record inserts one enrichment_log row from a Pipeline.Result. Returns nil
// on success, or the underlying DB error on failure.
//
// Callers should treat Record as fire-and-forget — a failed audit row must
// never abort the cron. The cutover wires Record onto the same goroutine as
// the merge call so audit lag stays zero in the common case.
//
// Empty ICO → rejected with a non-DB error: the table column is NOT NULL and
// recording a "we never even started" row offers no audit value.
func (w *LogWriter) Record(ctx context.Context, log LogRow) error {
	if w == nil || w.db == nil {
		return fmt.Errorf("enrichment.LogWriter: writer nebo db handle je nil")
	}
	if log.ICO == "" {
		// Pipeline.Enrich returns ErrICORequired before reaching the writer in
		// production paths, so this branch is mainly defensive against future
		// callers persisting "we skipped this contact" rows.
		slog.Debug("enrichment_log: zaznam preskocen — prazdne ICO",
			"op", "enrichment.LogWriter.Record/empty-ico",
			"contact_id", log.ContactID,
		)
		return fmt.Errorf("enrichment_log: ICO is required")
	}

	conflictsJSON, err := json.Marshal(log.MergeConflicts)
	if err != nil {
		// json.Marshal of MergeConflict slice is effectively infallible
		// (only string fields), but wrap the error path explicitly so any
		// future field type change cannot silently corrupt the audit row.
		return fmt.Errorf("enrichment_log: marshal merge_conflicts: %w", err)
	}
	// Empty conflict array → store as "[]" so JSONB NOT NULL DEFAULT '[]'
	// matches the canonical empty form.
	if len(log.MergeConflicts) == 0 {
		conflictsJSON = []byte("[]")
	}

	outcome := log.EnrichmentOutcome
	if outcome == "" {
		outcome = OutcomeNone
	}

	_, err = w.db.ExecContext(ctx, insertEnrichmentLogSQL,
		log.ContactID,
		log.ICO,
		pq.Array(sourceNamesToStrings(log.SourcesAttempted)),
		pq.Array(sourceNamesToStrings(log.SourcesSuccess)),
		string(conflictsJSON),
		string(outcome),
		log.DurationMS,
	)
	if err != nil {
		slog.Warn("enrichment_log: zapis selhal",
			"op", "enrichment.LogWriter.Record/exec",
			"error", err,
			"contact_id", log.ContactID,
			"ico", log.ICO,
			"outcome", string(outcome),
		)
		return fmt.Errorf("enrichment_log insert: %w", err)
	}
	return nil
}

// sourceNamesToStrings converts the typed SourceName slice into the raw
// string slice that pq.Array can serialise into a Postgres text[]. The
// underlying type is already string, but pq.Array does not understand named
// string types directly.
func sourceNamesToStrings(names []SourceName) []string {
	if len(names) == 0 {
		return []string{}
	}
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = string(n)
	}
	return out
}
