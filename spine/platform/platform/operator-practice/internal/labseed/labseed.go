// Package labseed orchestrates the Lab Feedback Loop seed cycle:
// select recent classified replies → drop already-seeded → anonymize →
// IMAP APPEND into the Mail Lab → record in seed log → emit Sentry
// breadcrumb summarising the batch.
//
// KT-B5 — closes the loop between live operator inboxes and the Mail
// Lab fixtures used for new-operator practice. The cron caller invokes
// Run once per night with a small batch size.
package labseed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"common/telemetry"

	op "operator-practice/internal/anonymize"
	"operator-practice/internal/imapinject"
)

// SelectorMessage is a re-export alias so callers that depend only on
// labseed do not need a separate import of the anonymize package just
// to implement the Selector interface (e.g. the noopStore in the CLI).
type SelectorMessage = op.Message

// Config drives a single Run invocation.
type Config struct {
	BatchSize  int    // hard cap on rows pulled per cycle
	LabHost    string // IMAP host
	LabPort    int    // IMAP port
	LabTLS     bool
	LabUser    string // mailbox address (e.g. op@gmail.lab)
	LabPass    string
	LabFolder  string // INBOX
	Salt       string // anonymizer salt
	DryRun     bool   // skip IMAP + DB writes; print plan
	NowFunc    func() time.Time
	BatchIDGen func() string // override for deterministic tests
}

func (c Config) batchSize() int {
	if c.BatchSize <= 0 {
		return 10
	}
	if c.BatchSize > 200 {
		return 200
	}
	return c.BatchSize
}

func (c Config) now() time.Time {
	if c.NowFunc == nil {
		return time.Now().UTC()
	}
	return c.NowFunc().UTC()
}

func (c Config) batchID() string {
	if c.BatchIDGen != nil {
		return c.BatchIDGen()
	}
	return defaultBatchID(c.now())
}

func defaultBatchID(now time.Time) string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Fallback to nanos if /dev/urandom is unavailable.
		return fmt.Sprintf("seed-%s-%d", now.Format("20060102"), now.UnixNano())
	}
	return fmt.Sprintf("seed-%s-%s", now.Format("20060102"), hex.EncodeToString(buf[:]))
}

// Stats describes the outcome of a Run.
type Stats struct {
	BatchID            string
	StartedAt          time.Time
	FinishedAt         time.Time
	Selected           int
	SkippedAlreadySent int
	Anonymized         int
	Injected           int
	Failed             int
	DryRun             bool
	Categories         map[string]int
	ReviewCandidates   int // sum across the batch — operator-visible signal
}

// Injector is the small subset of imapinject.Conn used by Run; the
// indirection lets tests inject a fake without standing up a TCP
// listener.
type Injector interface {
	Login() error
	Append(raw string) error
	Logout() error
	Close() error
}

// InjectorFactory returns a fresh Injector configured for the lab.
type InjectorFactory func(Config) (Injector, error)

// DefaultInjectorFactory wires the real imapinject.Conn.
func DefaultInjectorFactory(cfg Config) (Injector, error) {
	return imapinject.New(imapinject.Config{
		Host:     cfg.LabHost,
		Port:     cfg.LabPort,
		UseTLS:   cfg.LabTLS,
		Username: cfg.LabUser,
		Password: cfg.LabPass,
		Folder:   cfg.LabFolder,
	})
}

// Selector is the read side of the workflow. seedstore.Store satisfies
// the interface; tests substitute a fake.
type Selector interface {
	EnsureSchema(ctx context.Context) error
	SelectClassifiedReplies(ctx context.Context, limit int) ([]op.Message, error)
	FilterUnseen(ctx context.Context, msgs []op.Message) ([]op.Message, error)
	RecordSeeded(ctx context.Context, messageID, batchID, category, labMailbox string) error
}

// Runner couples a Selector + InjectorFactory. Use NewRunner.
type Runner struct {
	store   Selector
	factory InjectorFactory
}

// NewRunner constructs a Runner. Pass nil for factory to use the real
// imapinject implementation.
func NewRunner(store Selector, factory InjectorFactory) *Runner {
	if factory == nil {
		factory = DefaultInjectorFactory
	}
	return &Runner{store: store, factory: factory}
}

// Run executes one seed cycle. Returns Stats regardless of outcome —
// callers use the embedded counters for log lines + Sentry context.
func (r *Runner) Run(ctx context.Context, cfg Config) (Stats, error) {
	stats := Stats{
		BatchID:    cfg.batchID(),
		StartedAt:  cfg.now(),
		DryRun:     cfg.DryRun,
		Categories: map[string]int{},
	}
	defer func() { stats.FinishedAt = cfg.now() }()

	if r.store == nil {
		return stats, errors.New("labseed: nil store")
	}

	// 1. Ensure DSR-aware seed log table exists.
	if err := r.store.EnsureSchema(ctx); err != nil {
		emitBreadcrumb(stats, "schema-error: "+err.Error())
		return stats, err
	}

	// 2. Pull most-recent N classified inbound rows respecting suppression.
	msgs, err := r.store.SelectClassifiedReplies(ctx, cfg.batchSize())
	if err != nil {
		emitBreadcrumb(stats, "select-error: "+err.Error())
		return stats, err
	}
	stats.Selected = len(msgs)

	// 3. Drop already-seeded message_ids.
	fresh, err := r.store.FilterUnseen(ctx, msgs)
	if err != nil {
		emitBreadcrumb(stats, "filter-error: "+err.Error())
		return stats, err
	}
	stats.SkippedAlreadySent = stats.Selected - len(fresh)

	if len(fresh) == 0 {
		slog.Info("[op] labseed nothing to inject",
			"op", "labseed.Run/empty",
			"batch_id", stats.BatchID,
			"selected", stats.Selected,
			"skipped_already_sent", stats.SkippedAlreadySent,
		)
		emitBreadcrumb(stats, "empty-batch")
		return stats, nil
	}

	// 4. Anonymize.
	anonOpts := op.Options{
		Salt:    cfg.Salt,
		ToAddr:  cfg.LabUser,
		NowFunc: cfg.now,
	}
	results := make([]op.Result, 0, len(fresh))
	for _, m := range fresh {
		results = append(results, op.Anonymize(m, anonOpts))
	}
	stats.Anonymized = len(results)

	// Tally categories + review candidates from the anonymized batch
	// before any IMAP write so dry-run still surfaces the same numbers.
	for _, res := range results {
		stats.Categories[res.Category]++
		stats.ReviewCandidates += len(res.Candidates)
	}

	if cfg.DryRun {
		slog.Info("[op] labseed dry-run",
			"op", "labseed.Run/dry-run",
			"batch_id", stats.BatchID,
			"would_inject", len(results),
			"categories", stats.Categories,
		)
		emitBreadcrumb(stats, "dry-run")
		return stats, nil
	}

	// 5. Inject via IMAP. Log per-message outcome but never bail on a
	// single failure — the cron's job is to ship as many of the batch
	// as it can; one bad row should not stop the next ten.
	conn, err := r.factory(cfg)
	if err != nil {
		emitBreadcrumb(stats, "imap-dial-error: "+err.Error())
		return stats, fmt.Errorf("labseed: dial lab IMAP: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.Login(); err != nil {
		emitBreadcrumb(stats, "imap-login-error: "+err.Error())
		return stats, fmt.Errorf("labseed: lab IMAP login: %w", err)
	}

	for i, res := range results {
		msg := fresh[i]
		if err := conn.Append(res.EML); err != nil {
			stats.Failed++
			slog.Warn("[op] labseed append failed",
				"op", "labseed.Run/append-failed",
				"batch_id", stats.BatchID,
				"message_id", msg.MessageID,
				"error", err,
			)
			continue
		}
		stats.Injected++
		if recErr := r.store.RecordSeeded(ctx, msg.MessageID, stats.BatchID, res.Category, cfg.LabUser); recErr != nil {
			slog.Warn("[op] labseed record-seeded failed",
				"op", "labseed.Run/record-seeded-failed",
				"batch_id", stats.BatchID,
				"message_id", msg.MessageID,
				"error", recErr,
			)
		}
	}

	if err := conn.Logout(); err != nil {
		slog.Warn("[op] labseed logout failed",
			"op", "labseed.Run/logout-failed",
			"batch_id", stats.BatchID,
			"error", err,
		)
	}

	slog.Info("[op] labseed completed",
		"op", "labseed.Run/done",
		"batch_id", stats.BatchID,
		"selected", stats.Selected,
		"skipped_already_sent", stats.SkippedAlreadySent,
		"injected", stats.Injected,
		"failed", stats.Failed,
		"review_candidates", stats.ReviewCandidates,
	)
	emitBreadcrumb(stats, "completed")
	return stats, nil
}

// emitBreadcrumb pushes a Sentry breadcrumb describing the batch. Shape
// is stable so the operator dashboard or test harness can parse it.
//
// Per memory feedback_no_external_services we emit only via the
// existing telemetry helper which is a no-op when SENTRY_DSN_GO is
// unset. No additional services are added by this package.
func emitBreadcrumb(stats Stats, status string) {
	telemetry.Breadcrumb("operator-practice.lab-seed", "lab-seed batch "+status, BreadcrumbData(stats, status))
}

// BreadcrumbData builds the data payload for the Sentry breadcrumb.
// Exposed so unit tests can assert the exact map shape without
// instrumenting Sentry. Includes status so the payload distinguishes
// success from each failure mode.
func BreadcrumbData(stats Stats, status string) map[string]interface{} {
	durMS := int64(0)
	if !stats.FinishedAt.IsZero() {
		durMS = stats.FinishedAt.Sub(stats.StartedAt).Milliseconds()
	}
	cats := stats.Categories
	if cats == nil {
		cats = map[string]int{}
	}
	return map[string]interface{}{
		"batch_id":             stats.BatchID,
		"status":               strings.TrimSpace(status),
		"selected":             stats.Selected,
		"skipped_already_sent": stats.SkippedAlreadySent,
		"anonymized":           stats.Anonymized,
		"injected":             stats.Injected,
		"failed":               stats.Failed,
		"dry_run":              stats.DryRun,
		"duration_ms":          durMS,
		"review_candidates":    stats.ReviewCandidates,
		"categories":           cats,
	}
}
