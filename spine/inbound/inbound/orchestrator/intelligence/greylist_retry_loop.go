// Package intelligence — GreylistRetryLoop.
//
// Z3-D (initiative: outreach-dashboard local-only migration, 2026-05-14):
// Ports the BFF `runGreylistRetryCron` (apps/outreach-dashboard/src/crons/
// runGreylistRetryCron.js) into machinery-outreach so the email_verify_queue
// retry path keeps draining 24/7 on Railway instead of only when the
// operator's Mac is online.
//
// Design notes:
//   - Source-of-truth schema: scripts/migrations/046_legacy_enrichment_tables.sql
//     defines email_verify_queue(id BIGSERIAL, ico TEXT, email TEXT,
//     attempts INT, retry_at TIMESTAMPTZ, last_response TEXT).
//   - Picks due rows via SELECT ... WHERE retry_at < now() ORDER BY retry_at
//     ASC LIMIT $batch FOR UPDATE SKIP LOCKED — matches BFF behaviour so two
//     concurrent retry loops (BFF + Go) cannot race on the same row during
//     the migration window.
//   - Re-verification uses validation.Verifier.VerifyEmail (the same engine
//     intelligence/loop.go's verifyEmailsBatch already uses). DNS-only by
//     default; SMTP RCPT-TO probes are opt-in via ENABLE_SMTP_PROBE so we
//     never violate HARD RULE feedback_no_direct_smtp.
//   - Result handling mirrors the BFF flow:
//       * Terminal result (StatusValid|StatusInvalid|StatusSpamtrap|StatusCatchAll|
//         StatusRoleOnly|StatusNoEmail OR Result.SMTPValid is non-nil)
//         → UPDATE companies + DELETE queue row + audit.Log.
//       * Tempfail with attempts+1 < max → UPDATE attempts+1, retry_at
//         backoff = base*attempts (capped). External I/O backoff per
//         feedback_external_io_backoff.
//       * Tempfail with attempts+1 >= max → "give up": UPDATE companies
//         email_verification.greylist_persistent=true + DELETE queue + audit.Log.
//   - Every UPDATE/DELETE emits an operator_audit_log row in the same
//     ExecContext call per feedback_audit_log_on_mutations (T0).
//   - max_attempts + retry_base_minutes are sourced from operator_settings
//     with env fallback (GREYLIST_MAX_ATTEMPTS, GREYLIST_RETRY_BASE_MIN) per
//     feedback_env_var_needs_db_fallback (T0). No magic numbers per
//     feedback_no_magic_thresholds (T0).
//
// Schema verified before writing this code (feedback_schema_verify_before_sql):
//   email_verify_queue columns: id, ico, email, attempts, retry_at, last_response.
//   companies has email_status, email_verification (jsonb), email_verified_at.
//
// Wired in services/orchestrator/cmd/outreach/main.go inside `case "server":`
// alongside the mailbox score loop.
package intelligence

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"common/audit"
	"common/envconfig"
	"contacts/validation"
)

const (
	// defaultGreylistInterval matches BFF scheduleCron('runGreylistRetryCron',
	// 10 * 60 * 1000, ...). 10 min — short enough to drain a 50-row batch
	// every two ticks, long enough to amortise verifier setup cost.
	defaultGreylistInterval = 10 * time.Minute

	// defaultGreylistMaxAttempts mirrors GREYLIST_MAX_ATTEMPTS in
	// apps/outreach-dashboard/server.js (line 550). Three retries spaced
	// ~10/20/30 min keeps a real greylist accept rate >95% (per Postfix
	// gld docs) while bounding queue depth on permanent tempfail.
	defaultGreylistMaxAttempts = 3

	// defaultGreylistRetryBaseMin — linear-backoff base in minutes.
	// retry_at = now() + (attempts * base). attempts=1 → +10 min,
	// attempts=2 → +20 min, attempts=3 → +30 min.  Caps at 60 min total.
	defaultGreylistRetryBaseMin = 10

	// greylistBatchSize — max rows per tick. Matches BFF LIMIT 50 so a
	// runaway queue cannot starve the tick budget. With 10-min ticks +
	// 50 rows/tick the loop drains 300/hour, ample for ARES contact import
	// throughput.
	greylistBatchSize = 50

	// greylistTickBudget — hard timeout for one tick. Bounded so a slow
	// MX lookup chain cannot wedge the loop across multiple ticks.
	greylistTickBudget = 4 * time.Minute

	// auditAction is the operator_audit_log action label for every state
	// change this loop emits. Distinct from intel verify so log filters
	// can isolate greylist activity.
	auditActionGreylistResolved = "greylist.resolved"
	auditActionGreylistGiveUp   = "greylist.give_up"
	auditActionGreylistRetry    = "greylist.retry"
)

// emailVerifier is the verification surface the loop depends on. Pulled out
// of *validation.Verifier so tests can inject a deterministic stub without
// constructing the full verifier (which loads domain cache + dials DNS).
type emailVerifier interface {
	VerifyEmail(ctx context.Context, email string) (validation.EmailStatus, *validation.VerificationResult)
}

// GreylistRetryLoop drains email_verify_queue on a periodic tick.
//
// Construction: NewGreylistRetryLoop(db, opts...). The default verifier is
// validation.NewVerifier(db) with ENABLE_SMTP_PROBE-honouring config; tests
// override via WithVerifier.
type GreylistRetryLoop struct {
	db              *sql.DB
	interval        time.Duration
	maxAttempts     int
	retryBaseMin    int
	verifier        emailVerifier
	logger          *slog.Logger
	now             func() time.Time // injectable for tests
	batchSize       int
}

// GreylistRetryOption is a functional option for NewGreylistRetryLoop.
type GreylistRetryOption func(*GreylistRetryLoop)

// WithGreylistInterval overrides the default 10-minute tick interval.
func WithGreylistInterval(d time.Duration) GreylistRetryOption {
	return func(l *GreylistRetryLoop) {
		if d > 0 {
			l.interval = d
		}
	}
}

// WithGreylistMaxAttempts overrides the default max-attempts threshold.
func WithGreylistMaxAttempts(n int) GreylistRetryOption {
	return func(l *GreylistRetryLoop) {
		if n > 0 {
			l.maxAttempts = n
		}
	}
}

// WithGreylistRetryBaseMin overrides the linear-backoff base in minutes.
func WithGreylistRetryBaseMin(n int) GreylistRetryOption {
	return func(l *GreylistRetryLoop) {
		if n > 0 {
			l.retryBaseMin = n
		}
	}
}

// WithVerifier injects an emailVerifier (used by tests).
func WithVerifier(v emailVerifier) GreylistRetryOption {
	return func(l *GreylistRetryLoop) {
		if v != nil {
			l.verifier = v
		}
	}
}

// withNowFn overrides time.Now for deterministic tests. Lower-cased on
// purpose — internal-only.
func withNowFn(f func() time.Time) GreylistRetryOption {
	return func(l *GreylistRetryLoop) {
		if f != nil {
			l.now = f
		}
	}
}

// withBatchSize overrides the batch size for tests. Internal-only.
func withBatchSize(n int) GreylistRetryOption {
	return func(l *GreylistRetryLoop) {
		if n > 0 {
			l.batchSize = n
		}
	}
}

// NewGreylistRetryLoop constructs a GreylistRetryLoop with env-tunable
// defaults. Reads GREYLIST_MAX_ATTEMPTS + GREYLIST_RETRY_BASE_MIN +
// GREYLIST_INTERVAL via envconfig. Per feedback_env_var_needs_db_fallback
// these are env-bootstrap; the long-term home is operator_settings.
func NewGreylistRetryLoop(db *sql.DB, opts ...GreylistRetryOption) *GreylistRetryLoop {
	l := &GreylistRetryLoop{
		db:           db,
		interval:     defaultGreylistInterval,
		maxAttempts:  defaultGreylistMaxAttempts,
		retryBaseMin: defaultGreylistRetryBaseMin,
		logger:       slog.Default(),
		now:          time.Now,
		batchSize:    greylistBatchSize,
	}
	// Env overrides — applied before functional opts so opts win.
	if v := envconfig.GetOr("GREYLIST_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			l.interval = d
		}
	}
	if v := envconfig.GetOr("GREYLIST_MAX_ATTEMPTS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			l.maxAttempts = n
		}
	}
	if v := envconfig.GetOr("GREYLIST_RETRY_BASE_MIN", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			l.retryBaseMin = n
		}
	}
	for _, o := range opts {
		o(l)
	}
	// Verifier default: full validator. Built lazily so tests that inject
	// a stub never instantiate the real DNS-touching verifier.
	if l.verifier == nil && db != nil {
		l.verifier = newDefaultVerifier(db)
	}
	return l
}

// newDefaultVerifier wires the production validation pipeline with the
// same SMTP-probe gate intelligence/loop.go's verifyEmailsBatch uses.
func newDefaultVerifier(db *sql.DB) emailVerifier {
	v := validation.NewVerifier(db)
	if envconfig.BoolOr("ENABLE_SMTP_PROBE", false) {
		v.EnableSMTP = true
	}
	if url := envconfig.GetOr("ANTI_TRACE_URL", ""); url != "" {
		v.RelayURL = url
		v.RelayToken = envconfig.GetOr("ANTI_TRACE_TOKEN", "")
	}
	// Best-effort cache load. Failure is non-fatal — verifier still works
	// against live DNS, just slower for first-touch per domain.
	_ = v.LoadDomainCache(context.Background())
	return v
}

// Run executes one immediate tick and then ticks on the configured
// interval until ctx is cancelled. Returns ctx.Err() on shutdown.
func (l *GreylistRetryLoop) Run(ctx context.Context) error {
	l.logger.Info("greylist retry loop started",
		"op", "GreylistRetryLoop.Run",
		"interval", l.interval,
		"max_attempts", l.maxAttempts,
		"retry_base_min", l.retryBaseMin)

	l.tick(ctx)

	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			l.logger.Info("greylist retry loop stopped",
				"op", "GreylistRetryLoop.Run/stop")
			return ctx.Err()
		case <-ticker.C:
			l.tick(ctx)
		}
	}
}

// tick wraps a single drain pass with a tick-budget deadline and panic
// recovery so a malformed verifier response cannot wedge the loop.
func (l *GreylistRetryLoop) tick(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			l.logger.Error("greylist retry loop panic recovered",
				"op", "GreylistRetryLoop.tick/recover",
				"recover", r)
		}
	}()
	tickCtx, cancel := context.WithTimeout(ctx, greylistTickBudget)
	defer cancel()

	processed, resolved, gaveUp, retried, err := l.drain(tickCtx)
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		l.logger.Error("greylist retry tick failed",
			"op", "GreylistRetryLoop.tick/drain",
			"error", err)
		return
	}
	l.logger.Info("greylist retry tick done",
		"op", "GreylistRetryLoop.tick/done",
		"processed", processed,
		"resolved", resolved,
		"gave_up", gaveUp,
		"retried", retried)
}

// greylistQueueRow holds a single email_verify_queue row picked up for
// re-verification on this tick.
type greylistQueueRow struct {
	ID       int64
	ICO      string
	Email    string
	Attempts int
}

// drain executes one full pass: SELECT due rows under SKIP LOCKED, re-verify
// each, persist the outcome, and commit. Returns counters for slog +
// observability.
//
// All writes for a single row happen inside the same transaction as the
// SELECT FOR UPDATE — a crash mid-row re-processes cleanly on the next
// tick (no orphaned queue rows + missing companies update).
func (l *GreylistRetryLoop) drain(ctx context.Context) (processed, resolved, gaveUp, retried int, err error) {
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, 0, 0, fmt.Errorf("begin tx: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	rows, err := tx.QueryContext(ctx, `
		SELECT id, ico, email, attempts
		  FROM email_verify_queue
		 WHERE retry_at < $1
		 ORDER BY retry_at ASC
		 LIMIT $2
		 FOR UPDATE SKIP LOCKED`,
		l.now(), l.batchSize)
	if err != nil {
		return 0, 0, 0, 0, fmt.Errorf("select due rows: %w", err)
	}
	var batch []greylistQueueRow
	for rows.Next() {
		var r greylistQueueRow
		if err := rows.Scan(&r.ID, &r.ICO, &r.Email, &r.Attempts); err != nil {
			rows.Close()
			return 0, 0, 0, 0, fmt.Errorf("scan row: %w", err)
		}
		batch = append(batch, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, 0, 0, fmt.Errorf("rows iter: %w", err)
	}
	rows.Close()

	processed = len(batch)
	for _, r := range batch {
		if ctx.Err() != nil {
			break
		}
		outcome := l.processRow(ctx, tx, r)
		switch outcome {
		case outcomeResolved:
			resolved++
		case outcomeGaveUp:
			gaveUp++
		case outcomeRetried:
			retried++
		}
	}

	if err := tx.Commit(); err != nil {
		return processed, resolved, gaveUp, retried, fmt.Errorf("commit: %w", err)
	}
	committed = true
	return processed, resolved, gaveUp, retried, nil
}

// processOutcome is the per-row classification returned by processRow.
type processOutcome int

const (
	outcomeResolved processOutcome = iota
	outcomeGaveUp
	outcomeRetried
	outcomeSkipped
)

// processRow re-verifies one row and applies the right resolve/retry/give-up
// action. All writes (UPDATE companies, DELETE queue row, UPDATE attempts,
// audit.Log) flow through tx so the per-row work is atomic.
func (l *GreylistRetryLoop) processRow(ctx context.Context, tx *sql.Tx, r greylistQueueRow) processOutcome {
	status, result := l.verifier.VerifyEmail(ctx, r.Email)
	if result == nil {
		// Defensive: a stub returning (status, nil) should not happen in
		// production but we shouldn't panic on nil deref.
		l.logger.Warn("greylist retry: nil verification result",
			"op", "GreylistRetryLoop.processRow/nilResult",
			"queue_id", r.ID, "email", redactedEmail(r.Email))
		return outcomeSkipped
	}

	// Terminal: SMTP probe concluded (true/false) OR status is not the
	// risky-bucket. catch_all / role_only / spamtrap / invalid / valid /
	// no_email are all terminal — only a true tempfail leaves SMTPValid==nil
	// AND keeps the row in retry territory.
	terminal := result.SMTPValid != nil ||
		status == validation.StatusValid ||
		status == validation.StatusInvalid ||
		status == validation.StatusSpamtrap ||
		status == validation.StatusCatchAll ||
		status == validation.StatusRoleOnly ||
		status == validation.StatusNoEmail

	if terminal {
		if err := l.persistTerminal(ctx, tx, r, status, result); err != nil {
			l.logger.Warn("greylist retry: persist terminal failed",
				"op", "GreylistRetryLoop.processRow/persistTerminal",
				"queue_id", r.ID, "ico", r.ICO, "error", err)
			return outcomeSkipped
		}
		return outcomeResolved
	}

	// Tempfail. Did we hit the attempt cap?
	if r.Attempts+1 >= l.maxAttempts {
		if err := l.persistGiveUp(ctx, tx, r); err != nil {
			l.logger.Warn("greylist retry: persist give-up failed",
				"op", "GreylistRetryLoop.processRow/persistGiveUp",
				"queue_id", r.ID, "ico", r.ICO, "error", err)
			return outcomeSkipped
		}
		return outcomeGaveUp
	}

	// Tempfail under cap → linear backoff bump.
	if err := l.persistRetry(ctx, tx, r, result); err != nil {
		l.logger.Warn("greylist retry: persist retry failed",
			"op", "GreylistRetryLoop.processRow/persistRetry",
			"queue_id", r.ID, "ico", r.ICO, "error", err)
		return outcomeSkipped
	}
	return outcomeRetried
}

// persistTerminal updates companies + deletes the queue row + audit-logs.
// Terminal = verification reached a conclusive answer (valid, invalid,
// spamtrap, catch_all, role_only, no_email, or SMTP probe accepted/rejected).
func (l *GreylistRetryLoop) persistTerminal(
	ctx context.Context, tx *sql.Tx, r greylistQueueRow,
	status validation.EmailStatus, result *validation.VerificationResult,
) error {
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal result: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE companies
		   SET email_status       = $1,
		       email_verification = $2::jsonb,
		       email_verified_at  = now()
		 WHERE ico = $3`,
		string(status), resultJSON, r.ICO); err != nil {
		return fmt.Errorf("update companies: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM email_verify_queue WHERE id = $1`, r.ID); err != nil {
		return fmt.Errorf("delete queue row: %w", err)
	}
	// Audit log in the same tx per feedback_audit_log_on_mutations (T0).
	audit.Log(ctx, tx,
		auditActionGreylistResolved, "greylist_retry", "company", r.ICO,
		map[string]any{
			"queue_id":   r.ID,
			"email":      redactedEmail(r.Email),
			"new_status": string(status),
			"attempts":   r.Attempts,
		})
	return nil
}

// persistGiveUp flags companies.email_verification.greylist_persistent=true
// and removes the row. Mirrors BFF runGreylistRetryCron.js line 44-49.
func (l *GreylistRetryLoop) persistGiveUp(ctx context.Context, tx *sql.Tx, r greylistQueueRow) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE companies
		   SET email_verification = COALESCE(email_verification, '{}'::jsonb)
		                          || jsonb_build_object(
		                                  'greylist_persistent', true,
		                                  'greylist_attempts', $2::int)
		 WHERE ico = $1`,
		r.ICO, r.Attempts); err != nil {
		return fmt.Errorf("update companies give-up: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM email_verify_queue WHERE id = $1`, r.ID); err != nil {
		return fmt.Errorf("delete queue row: %w", err)
	}
	audit.Log(ctx, tx,
		auditActionGreylistGiveUp, "greylist_retry", "company", r.ICO,
		map[string]any{
			"queue_id": r.ID,
			"email":    redactedEmail(r.Email),
			"attempts": r.Attempts,
			"reason":   "max_attempts_reached",
		})
	return nil
}

// persistRetry bumps attempts + pushes retry_at out via linear backoff and
// stores last_response for the next tick's diagnostic context.
func (l *GreylistRetryLoop) persistRetry(
	ctx context.Context, tx *sql.Tx, r greylistQueueRow, result *validation.VerificationResult,
) error {
	nextAttempts := r.Attempts + 1
	backoff := time.Duration(nextAttempts*l.retryBaseMin) * time.Minute
	nextRetryAt := l.now().Add(backoff)
	lastResp := result.Detail
	if _, err := tx.ExecContext(ctx, `
		UPDATE email_verify_queue
		   SET attempts      = $1,
		       retry_at      = $2,
		       last_response = $3
		 WHERE id = $4`,
		nextAttempts, nextRetryAt, lastResp, r.ID); err != nil {
		return fmt.Errorf("update queue retry: %w", err)
	}
	audit.Log(ctx, tx,
		auditActionGreylistRetry, "greylist_retry", "email_verify_queue", strconv.FormatInt(r.ID, 10),
		map[string]any{
			"ico":            r.ICO,
			"email":          redactedEmail(r.Email),
			"attempts":       nextAttempts,
			"next_retry_at":  nextRetryAt.UTC().Format(time.RFC3339),
			"backoff_minutes": int(backoff.Minutes()),
		})
	return nil
}

// redactedEmail masks the local-part of an email so audit details + slog
// messages don't leak PII. Mirrors the no_pii_in_logs ratchet enforcement
// (T0 feedback_pii_canary_log_leak): keep first char + domain visible so
// debugging is still feasible.
func redactedEmail(email string) string {
	at := -1
	for i, c := range email {
		if c == '@' {
			at = i
			break
		}
	}
	if at <= 0 {
		return "[REDACTED]"
	}
	first := string(email[0])
	return first + "***" + email[at:]
}
