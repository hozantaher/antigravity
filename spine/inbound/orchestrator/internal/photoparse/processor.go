// Package photoparse orchestrates the inbound-photo pipeline:
// volume save + llm-runner /v1/parse-photo call + photo_parse_audit
// INSERT.
//
// Pipeline contract (per Track E migration 019 + ROPA Činnost č. 6):
//
//   1. Skip non-image attachments.
//   2. Skip images larger than the configured size limit (default 10 MB
//      per env PHOTO_MAX_SIZE_BYTES).
//   3. Save the raw blob into the volume via photostore.Store.Save.
//   4. Best-effort POST to llm-runner /v1/parse-photo. On
//      ErrUnavailable / ErrNotImplemented we still INSERT the audit row
//      with extracted=NULL so the operator dashboard can show "pending
//      vision parse" and a future retry job can pick the row up via
//      `WHERE extracted IS NULL` query.
//   5. INSERT into photo_parse_audit. Failures are logged but never
//      bubble up to the inbound thread persist path — the message has
//      already been recorded; a missing audit row is recoverable.
//
// The package is *intentionally* fail-open: the original ProcessReply
// flow must keep working even when the volume is read-only or the
// llm-runner box is rotating. Callers wire it via
// (*thread.InboundProcessor).WithPhotoProcessor.
package photoparse

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"orchestrator/internal/llmclient"
	"orchestrator/internal/photostore"
)

// DefaultMaxSizeBytes is the per-photo upper bound (10 MiB). main.go
// can override via PHOTO_MAX_SIZE_BYTES.
const DefaultMaxSizeBytes = 10 * 1024 * 1024

// SourceEmailAttachment marks photos lifted out of inbound email MIME
// parts. Phase 2 will add `whatsapp_inbound`.
const SourceEmailAttachment = "email_attachment"

// PhotoClient is the subset of *llmclient.Client we use. Defining it
// here lets unit tests inject a fake without depending on net/http.
type PhotoClient interface {
	ParsePhoto(ctx context.Context, imageB64, promptContext string) (*llmclient.PhotoExtract, error)
}

// Photo is the input to (*Processor).Process. Each value represents
// one decoded MIME part from `mime.Attachment` after the orchestrator
// has classified it as image/*.
type Photo struct {
	ThreadID    int64
	MessageID   string // SMTP Message-ID; used as a path component
	Filename    string
	ContentType string // canonicalized lowercase, e.g. "image/jpeg"
	Data        []byte
}

// Config holds wiring + tuning knobs.
type Config struct {
	Store        *photostore.Store
	Client       PhotoClient
	MaxSizeBytes int
	// PromptContext is the static `context` field forwarded to
	// llm-runner. Use to give Ollama a hint like "TP foto stroje".
	PromptContext string
}

// Processor is the value injected into (*thread.InboundProcessor)
// .WithPhotoProcessor. Construct it once at boot via New().
type Processor struct {
	db            *sql.DB
	store         *photostore.Store
	client        PhotoClient
	maxSizeBytes  int
	promptContext string
}

// New builds a Processor. db is required; cfg.Store is required.
// cfg.Client may be nil — the processor still saves blobs and
// records audit rows with extracted=NULL.
func New(db *sql.DB, cfg Config) *Processor {
	max := cfg.MaxSizeBytes
	if max <= 0 {
		max = DefaultMaxSizeBytes
	}
	return &Processor{
		db:            db,
		store:         cfg.Store,
		client:        cfg.Client,
		maxSizeBytes:  max,
		promptContext: cfg.PromptContext,
	}
}

// IsImage is the method-form of the package-level IsImage helper, so
// (*Processor) directly satisfies the `thread.PhotoProcessor`
// interface without an adapter layer. Both forms call the same logic.
func (p *Processor) IsImage(contentType string) bool {
	return IsImage(contentType)
}

// IsImage tells callers whether a Content-Type warrants Process. The
// inbound pipeline calls this before invoking Process so we never
// allocate a Photo for non-image MIME parts.
func IsImage(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	switch ct {
	case "image/jpeg", "image/jpg", "image/png", "image/webp",
		"image/gif", "image/heic", "image/heif":
		return true
	}
	return strings.HasPrefix(ct, "image/")
}

// Process runs the pipeline for a single photo. Returns the audit row
// ID on success. On any failure that the caller should ignore (the
// pipeline is fail-open), the function returns 0 + a wrapped error
// the caller logs but does not propagate.
//
// Preconditions: db != nil, store != nil. The processor is meant to
// be constructed once and reused; nil fields are programmer error.
func (p *Processor) Process(ctx context.Context, photo Photo) (int64, error) {
	if p == nil {
		return 0, errors.New("photoparse: nil processor")
	}
	if !IsImage(photo.ContentType) {
		// Should not happen — inbound.go gates this with IsImage —
		// but a defensive check keeps the audit table free of garbage.
		return 0, fmt.Errorf("photoparse: skip non-image content_type=%q", photo.ContentType)
	}
	if len(photo.Data) == 0 {
		return 0, errors.New("photoparse: empty photo data")
	}
	if len(photo.Data) > p.maxSizeBytes {
		return 0, fmt.Errorf(
			"photoparse: photo too large size=%d max=%d",
			len(photo.Data), p.maxSizeBytes,
		)
	}

	// 1. Save the blob — a missing volume is a hard failure: without a
	// blob_ref the audit row would be useless.
	blobRef, err := p.store.Save(photo.ThreadID, photo.MessageID, photo.Filename, photo.Data)
	if err != nil {
		return 0, fmt.Errorf("photoparse: save blob: %w", err)
	}

	// 2. Best-effort vision call. Skeleton llm-runner returns 501; we
	// record a NULL-extract audit row in that case so the row exists
	// and a future retry job can re-process it.
	var extracted *llmclient.PhotoExtract
	var llmErr error
	if p.client != nil {
		b64 := base64.StdEncoding.EncodeToString(photo.Data)
		extracted, llmErr = p.client.ParsePhoto(ctx, b64, p.promptContext)
		if llmErr != nil {
			slog.Warn("photo parse upstream failed",
				"op", "photoparse.Process/llm",
				"thread_id", photo.ThreadID,
				"blob_ref", blobRef,
				"error", llmErr)
		}
	}

	// 3. Persist audit row regardless of LLM outcome — that is the
	// whole point of this table per ROPA Činnost č. 6.
	auditID, insertErr := p.insertAudit(ctx, blobRef, extracted, llmErr)
	if insertErr != nil {
		return 0, fmt.Errorf("photoparse: insert audit: %w", insertErr)
	}
	return auditID, nil
}

// insertAudit writes the photo_parse_audit row. The shape mirrors
// migration 019's column list. `extracted` is JSON-encoded; on
// llm-runner failure it falls back to an empty JSON object so the
// NOT NULL constraint passes — the failure detail is captured under
// `details.upstream_error` for ops triage.
func (p *Processor) insertAudit(
	ctx context.Context,
	blobRef string,
	extract *llmclient.PhotoExtract,
	upstreamErr error,
) (int64, error) {
	extractedJSON := []byte("{}")
	retainedJSON := []byte("{}")
	var discardedJSON []byte

	if extract != nil {
		if buf, err := json.Marshal(extract); err == nil {
			extractedJSON = buf
		}
		// Retained = the machinery attributes we keep. Discarded =
		// nothing in skeleton; future LLM2.3 will populate when
		// face/license-plate scrubbing lands.
		if buf, err := json.Marshal(retainAttributes(extract)); err == nil {
			retainedJSON = buf
		}
	}

	details := map[string]any{
		"max_size_bytes": p.maxSizeBytes,
	}
	if upstreamErr != nil {
		details["upstream_error"] = upstreamErr.Error()
		details["upstream_status"] = classifyUpstreamErr(upstreamErr)
	}
	detailsJSON, _ := json.Marshal(details)

	const q = `
		INSERT INTO photo_parse_audit (
			blob_ref, source, extracted, retained, discarded, details
		) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`
	var id int64
	err := p.db.QueryRowContext(
		ctx, q,
		blobRef,
		SourceEmailAttachment,
		string(extractedJSON),
		string(retainedJSON),
		nullableJSON(discardedJSON),
		string(detailsJSON),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("query: %w", err)
	}
	return id, nil
}

// retainAttributes carves out the data-minimization subset (machinery
// attributes only) for the `retained` column. Empty / unknown fields
// drop out so the column reflects what we actually kept.
func retainAttributes(extract *llmclient.PhotoExtract) map[string]any {
	out := map[string]any{}
	if extract == nil {
		return out
	}
	if extract.Year != nil {
		out["year"] = *extract.Year
	}
	if extract.Make != "" {
		out["make"] = extract.Make
	}
	if extract.Model != "" {
		out["model"] = extract.Model
	}
	if extract.Condition != "" {
		out["condition"] = extract.Condition
	}
	if extract.OdometerKM != nil {
		out["odometer_km"] = *extract.OdometerKM
	}
	return out
}

// classifyUpstreamErr buckets the upstream failure for slog grouping
// + dashboards. Returns "unavailable" / "not_implemented" / "other".
func classifyUpstreamErr(err error) string {
	switch {
	case errors.Is(err, llmclient.ErrUnavailable):
		return "unavailable"
	case errors.Is(err, llmclient.ErrNotImplemented):
		return "not_implemented"
	default:
		return "other"
	}
}

// nullableJSON returns interface{}=nil when buf is empty so PG stores
// SQL NULL into the JSONB column.
func nullableJSON(buf []byte) interface{} {
	if len(buf) == 0 {
		return nil
	}
	return string(buf)
}
