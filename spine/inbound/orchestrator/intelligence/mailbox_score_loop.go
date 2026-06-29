package intelligence

// MailboxScoreLoop runs an SMTP-probe against every active mailbox on a
// configurable interval (default 4h) and writes last_score / last_score_at
// into outreach_mailboxes.
//
// Design notes:
//   - Moved from apps/outreach-dashboard/server.js runFullCheckCron so the
//     cron runs 24/7 on Railway instead of only when pnpm dev is active.
//   - Score formula: SMTP probe ok → 100, fail → 0.  Matches the BFF-side
//     calcFullCheckScore behaviour when SMTP is the only available check.
//   - Probe is delegated to anti-trace-relay POST /v1/probe (relay handles
//     SOCKS5 dialing; Go side never dials SMTP directly per HARD RULE).
//   - Mailbox credentials are read from outreach_mailboxes at each tick so
//     a credential update is picked up on the next run without a restart.
//
// Wired in services/orchestrator/cmd/outreach/main.go alongside IMAP poller.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

const defaultScoreInterval = 4 * time.Hour

// probeSubcheck mirrors the relay POST /v1/probe response field shape
// defined in services/relay/web/probe.go.
type probeSubcheck struct {
	OK    bool   `json:"ok"`
	Ms    int64  `json:"ms"`
	Error string `json:"error,omitempty"`
}

// probeResponse mirrors relay POST /v1/probe top-level response.
type probeResponse struct {
	Checks struct {
		SMTP probeSubcheck `json:"smtp"`
	} `json:"checks"`
	CheckedAt string `json:"checked_at"`
}

// probeRequest is the body sent to relay POST /v1/probe.
type probeRequest struct {
	SMTPHost     string `json:"smtp_host"`
	SMTPPort     int    `json:"smtp_port"`
	SMTPUsername string `json:"smtp_username"`
	Password     string `json:"password"`
}

// mailboxRow holds the columns needed for a scoring tick.
type mailboxRow struct {
	ID           int64
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	Password     string
}

// MailboxScoreLoop runs periodic SMTP probes for every active mailbox and
// persists the score into outreach_mailboxes.last_score / last_score_at.
type MailboxScoreLoop struct {
	db         *sql.DB
	interval   time.Duration
	relayURL   string // base URL of anti-trace-relay, e.g. http://relay.internal
	relayToken string // Bearer token for relay /v1/probe
	logger     *slog.Logger
	httpClient *http.Client
}

// MailboxScoreOption is a functional option for NewMailboxScoreLoop.
type MailboxScoreOption func(*MailboxScoreLoop)

// WithScoreInterval overrides the default 4-hour tick interval.
func WithScoreInterval(d time.Duration) MailboxScoreOption {
	return func(l *MailboxScoreLoop) {
		if d > 0 {
			l.interval = d
		}
	}
}

// NewMailboxScoreLoop constructs a MailboxScoreLoop.
//
//	relayURL   — base URL of the anti-trace-relay service
//	relayToken — Bearer token sent in Authorization header
func NewMailboxScoreLoop(db *sql.DB, relayURL, relayToken string, opts ...MailboxScoreOption) *MailboxScoreLoop {
	l := &MailboxScoreLoop{
		db:         db,
		interval:   defaultScoreInterval,
		relayURL:   relayURL,
		relayToken: relayToken,
		logger:     slog.Default(),
		httpClient: &http.Client{Timeout: 35 * time.Second},
	}
	for _, o := range opts {
		o(l)
	}
	return l
}

// Run starts the long-running scoring loop. It blocks until ctx is cancelled
// and returns ctx.Err().
//
// On each tick:
//  1. SELECT active mailboxes with credentials from outreach_mailboxes.
//  2. For each, POST /v1/probe to relay; score = 100 if smtp.ok else 0.
//  3. UPDATE outreach_mailboxes SET last_score=$score, last_score_at=now()
//
// A failed probe is non-fatal: the mailbox score is written as 0 and the
// loop continues to the next mailbox.  A relay that is completely unreachable
// is logged once per tick; individual mailboxes are still attempted.
func (l *MailboxScoreLoop) Run(ctx context.Context) error {
	l.logger.Info("mailbox score loop started",
		"op", "MailboxScoreLoop.Run",
		"interval", l.interval,
		"relay_url", l.relayURL)

	// Run once immediately, then on ticker.
	l.tick(ctx)

	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			l.logger.Info("mailbox score loop stopped",
				"op", "MailboxScoreLoop.Run/stop")
			return ctx.Err()
		case <-ticker.C:
			l.tick(ctx)
		}
	}
}

// tick executes one scoring pass across all active mailboxes.
func (l *MailboxScoreLoop) tick(ctx context.Context) {
	mailboxes, err := l.loadActiveMailboxes(ctx)
	if err != nil {
		l.logger.Error("mailbox score loop: load mailboxes failed",
			"op", "MailboxScoreLoop.tick/load",
			"error", err)
		return
	}
	if len(mailboxes) == 0 {
		l.logger.Info("mailbox score loop: no active mailboxes, skipping tick",
			"op", "MailboxScoreLoop.tick/empty")
		return
	}

	l.logger.Info("mailbox score loop tick",
		"op", "MailboxScoreLoop.tick",
		"mailboxes", len(mailboxes))

	scored, failed := 0, 0
	for _, mb := range mailboxes {
		// Check ctx before each mailbox so a cancellation during a long batch
		// stops promptly without blocking a full iteration.
		if ctx.Err() != nil {
			return
		}
		score, probeErr := l.probeMailbox(ctx, mb)
		if probeErr != nil {
			l.logger.Error("mailbox score loop: probe error",
				"op", "MailboxScoreLoop.tick/probe",
				"mailbox_id", mb.ID,
				"error", probeErr)
			score = 0
			failed++
		}
		if updateErr := l.persistScore(ctx, mb.ID, score); updateErr != nil {
			l.logger.Error("mailbox score loop: persist score failed",
				"op", "MailboxScoreLoop.tick/persist",
				"mailbox_id", mb.ID,
				"score", score,
				"error", updateErr)
			continue
		}
		scored++
	}

	l.logger.Info("mailbox score loop tick done",
		"op", "MailboxScoreLoop.tick/done",
		"scored", scored,
		"probe_failures", failed)
}

// loadActiveMailboxes returns all active mailboxes with SMTP credentials.
// Only rows with status='active' are returned; paused/failed/retired are
// excluded (per the original runFullCheckCron behaviour).
func (l *MailboxScoreLoop) loadActiveMailboxes(ctx context.Context) ([]mailboxRow, error) {
	const q = `
		SELECT id, smtp_host, smtp_port, smtp_username, password
		FROM outreach_mailboxes
		WHERE status = 'active'
		  AND environment = 'production'
		  AND smtp_host IS NOT NULL AND smtp_host <> ''
		  AND smtp_port > 0
		  AND smtp_username IS NOT NULL AND smtp_username <> ''
		  AND password IS NOT NULL AND password <> ''
		ORDER BY id`

	rows, err := l.db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("loadActiveMailboxes: %w", err)
	}
	defer rows.Close()

	var result []mailboxRow
	for rows.Next() {
		var mb mailboxRow
		if err := rows.Scan(&mb.ID, &mb.SMTPHost, &mb.SMTPPort, &mb.SMTPUsername, &mb.Password); err != nil {
			return nil, fmt.Errorf("loadActiveMailboxes scan: %w", err)
		}
		result = append(result, mb)
	}
	return result, rows.Err()
}

// probeMailbox calls relay POST /v1/probe and returns 100 on smtp.ok, 0 on
// smtp fail.  A network or protocol error returns (0, err).
func (l *MailboxScoreLoop) probeMailbox(ctx context.Context, mb mailboxRow) (int, error) {
	if l.relayURL == "" {
		// No relay configured — cannot probe. Score 0 without error so the
		// caller persists 0 and moves on rather than skipping the mailbox
		// silently.
		return 0, fmt.Errorf("ANTI_TRACE_RELAY_URL not configured")
	}

	reqBody := probeRequest{
		SMTPHost:     mb.SMTPHost,
		SMTPPort:     mb.SMTPPort,
		SMTPUsername: mb.SMTPUsername,
		Password:     mb.Password,
	}
	b, err := json.Marshal(reqBody)
	if err != nil {
		return 0, fmt.Errorf("probeMailbox marshal: %w", err)
	}

	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	url := l.relayURL + "/v1/probe"
	httpReq, err := http.NewRequestWithContext(probeCtx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return 0, fmt.Errorf("probeMailbox build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if l.relayToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+l.relayToken)
	}

	resp, err := l.httpClient.Do(httpReq)
	if err != nil {
		return 0, fmt.Errorf("probeMailbox http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("probeMailbox relay status %d: %s", resp.StatusCode, string(body))
	}

	var pr probeResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return 0, fmt.Errorf("probeMailbox decode: %w", err)
	}

	// Score formula: pass=100, fail=0 — matches BFF calcFullCheckScore when
	// SMTP is the only available check (weight 30/30 = 100%).
	if pr.Checks.SMTP.OK {
		return 100, nil
	}
	return 0, nil
}

// persistScore writes last_score and last_score_at for the given mailbox.
func (l *MailboxScoreLoop) persistScore(ctx context.Context, mailboxID int64, score int) error {
	_, err := l.db.ExecContext(ctx,
		`UPDATE outreach_mailboxes SET last_score = $1, last_score_at = now() WHERE id = $2`,
		score, mailboxID)
	if err != nil {
		return fmt.Errorf("persistScore id=%d: %w", mailboxID, err)
	}
	return nil
}
