// KT-A8.1 — healing_log writer.
//
// LogWriter persists one row per detected upstream block into the healing_log
// audit table (migration 008). It is intentionally small: one INSERT, no
// recovery loop, no circuit-breaker, no fallback bookkeeping. Those layers
// (alt-source recovery, 30/50 breaker, BFF endpoint) live in the KT-A8.1
// follow-up parts and plug in on top of this writer via the same observer
// hook.
//
// Failure policy:
//   - DB writes are best-effort. A failed INSERT logs a warning and returns
//     the error to the caller, but ARES / firmy.cz fetch wrappers MUST treat
//     LogWriter as fire-and-forget — losing an audit row never fails a fetch.
//   - All inputs are passed via parameterised queries (lib/pq $N placeholders),
//     so callers may pass arbitrary strings (URLs with control chars,
//     attacker-controlled bodies) without SQL-injection risk.
package blockdetect

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// dbExec is the narrow surface LogWriter needs from *sql.DB. Defined where it
// is used (per Go style: small interfaces near the consumer) so tests can
// supply an in-memory sqlmock without depending on the full *sql.DB API.
type dbExec interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// LogWriter inserts healing_log rows on every detected block.
type LogWriter struct {
	db dbExec
}

// NewLogWriter wires a writer around the given DB handle. The handle is held
// by reference; the caller owns its lifecycle.
func NewLogWriter(db dbExec) *LogWriter {
	return &LogWriter{db: db}
}

// BlockEvent is the parameter object for LogWriter.Record. Using a struct
// (rather than a long positional list) keeps call sites stable when KT-A8.1
// adds optional fields like FallbackSource / Recovered in follow-up PRs.
type BlockEvent struct {
	// SourceName is the upstream identifier. Allowed: "ares", "firmy_cz",
	// or any future source. Empty input is normalised to "unknown" so the
	// NOT NULL constraint cannot trip on a misconfigured caller.
	SourceName string
	// BlockType is the classification produced by DetectBlock. Wire form
	// (rate_limit / captcha / cloudflare / forbidden) is taken from
	// BlockType.String().
	BlockType BlockType
	// HTTPStatus is the original upstream status (0 if unknown — stored as
	// NULL).
	HTTPStatus int
	// TargetURL is the URL that tripped the block. Stored verbatim;
	// parameterised query keeps this safe even with hostile input.
	TargetURL string
	// BodySignature is a short forensic snippet (≤ 200 bytes recommended;
	// the column is TEXT so a longer string will still insert, but the
	// caller should trim with bodySnippet equivalent).
	BodySignature string
}

const insertHealingLogSQL = `
INSERT INTO healing_log
    (source_name, block_type, http_status, target_url, body_signature)
VALUES
    ($1, $2, NULLIF($3, 0), NULLIF($4, ''), NULLIF($5, ''))
`

// Record inserts one healing_log row. It returns nil on success, or the
// underlying DB error on failure. Callers should not abort the fetch on
// error — log and move on. occurred_at is left to the column DEFAULT NOW()
// so the DB owns the timestamp (consistent with cross-process clock drift).
//
// BlockTypeNone is rejected explicitly: if DetectBlock returned none there
// is nothing to audit, and the CHECK constraint on block_type would reject
// the wire value "none" anyway. The Record method short-circuits before the
// DB round-trip so the contract is clear.
func (w *LogWriter) Record(ctx context.Context, ev BlockEvent) error {
	if w == nil || w.db == nil {
		return fmt.Errorf("blockdetect: writer: nil writer or db handle")
	}
	if ev.BlockType == BlockTypeNone {
		// Defensive — the wire value "none" is not in the CHECK constraint.
		// Returning nil makes Record idempotent under "always call Record"
		// callers; logging keeps the silent-skip visible to operators.
		slog.Debug("healing_log: zaznam preskocen — BlockTypeNone",
			"op", "blockdetect.LogWriter.Record/none",
			"source_name", ev.SourceName,
		)
		return nil
	}

	source := ev.SourceName
	if source == "" {
		source = "unknown"
	}

	_, err := w.db.ExecContext(ctx, insertHealingLogSQL,
		source,
		ev.BlockType.String(),
		ev.HTTPStatus,
		ev.TargetURL,
		ev.BodySignature,
	)
	if err != nil {
		slog.Warn("healing_log: zapis selhal",
			"op", "blockdetect.LogWriter.Record/exec",
			"error", err,
			"source_name", source,
			"block_type", ev.BlockType.String(),
		)
		return fmt.Errorf("healing_log insert: %w", err)
	}
	return nil
}

// AsObserver returns a fire-and-forget callback suitable for plugging into
// the ARES client (and any future scraper) via the BlockObserver hook. The
// returned function:
//
//   - swallows DB errors after logging — a failed audit row must never abort
//     the upstream fetch.
//   - uses context.Background() because the observer fires on a hot request
//     path where the caller's context may be cancelled before the audit row
//     is persisted; the audit insert is a best-effort side channel.
//   - trims body to ~200 bytes to keep the audit table read-friendly.
//
// sourceName is captured by closure so the same LogWriter can serve multiple
// scrapers (one observer per source).
func (w *LogWriter) AsObserver(sourceName string) func(targetURL string, blockType BlockType, httpStatus int, body []byte) {
	return func(targetURL string, blockType BlockType, httpStatus int, body []byte) {
		_ = w.Record(context.Background(), BlockEvent{
			SourceName:    sourceName,
			BlockType:     blockType,
			HTTPStatus:    httpStatus,
			TargetURL:     targetURL,
			BodySignature: trimBodyForAudit(body),
		})
	}
}

// trimBodyForAudit caps the audit signature at 200 bytes and replaces
// control characters with spaces so the row stays single-line in psql.
func trimBodyForAudit(body []byte) string {
	const maxSignatureBytes = 200
	if len(body) > maxSignatureBytes {
		body = body[:maxSignatureBytes]
	}
	out := make([]byte, len(body))
	for i, b := range body {
		switch b {
		case '\n', '\r', '\t':
			out[i] = ' '
		default:
			out[i] = b
		}
	}
	return string(out)
}
