// cron_imap_poll.go — Z3-A IMAP poll cron migrated from BFF runImapPollCron.
//
// Background:
//
//	BFF runs on the operator Mac and is offline overnight, so any
//	24/7-critical cron has to live on the Railway-hosted Go service.
//	This module ports apps/outreach-dashboard/src/crons/runImapPollCron.js
//	with one structural simplification — instead of POSTing each fetched
//	RFC 5322 message back to /api/inbound (cross-service HTTP hop), we
//	call thread.InboundProcessor.ProcessReply directly in-process. The
//	orchestrator container already owns the processor (POST /api/inbound
//	registers the same handler), so an in-process call removes a JSON
//	round-trip and a TCP hop without changing behaviour.
//
// Transport:
//
//	The runner still does NOT dial IMAP directly. wgsocks listeners
//	bind 127.0.0.1 INSIDE the relay container (memory
//	project_bff_imap_cross_service_broken). Calling relay /v1/imap-fetch
//	mirrors the BFF behaviour and keeps egress centralised. The relay
//	does the IMAP TLS handshake, LOGIN, SELECT, UID SEARCH and UID FETCH
//	over SOCKS5, and returns parsed headers + raw RFC 5322 bodies.
//
// HARD RULE compliance:
//
//   - feedback_engine_path_test (T0)         — inbound feed goes through
//     thread.InboundProcessor.ProcessReply, which is the same canonical
//     path /api/inbound uses. No bypass.
//   - feedback_audit_log_on_mutations (T0)   — circuit + state updates
//     run via the same SQL as BFF; ProcessReply itself writes the
//     audit rows inside the thread package. UIDvalidity changes emit
//     a healing_log row.
//   - feedback_no_pii_in_commands (T0)       — slog labels use mailbox
//     id only; from_address / username / password are never logged.
//   - feedback_no_magic_thresholds (T0)      — interval + UID watermark
//     thresholds defined as package constants below.
//   - feedback_external_io_backoff (T0)      — relay calls have a 35s
//     timeout; the per-mailbox circuit breaker is left intact to back
//     off after consecutive failures (mirrors BFF behaviour).
//   - feedback_no_speculation (T0)           — RFC 3501 §2.3.1.1 for
//     UIDVALIDITY semantics; RFC 5322 for raw message format.
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"common/config"
	"common/envconfig"
	imapPkg "orchestrator/imap"
	"orchestrator/thread"
)

// ─── Named thresholds (no magic numbers) ────────────────────────────────

const (
	// defaultImapPollInterval — Sprint AC7 lowered this from 5 → 2 minutes
	// to reduce reply latency. With 8 active mailboxes and wgpool max=6
	// concurrent SOCKS5 endpoints, average concurrency at 2 min is
	// 8 × (poll_dur ≈ 8 s) / 120 s ≈ 0.5 → well below the wgpool ceiling.
	// Override at boot with IMAP_POLL_INTERVAL=<go-duration>.
	defaultImapPollInterval = 2 * time.Minute

	// imapFetchTimeout is the per-request HTTP ceiling for the relay
	// POST /v1/imap-fetch call. BFF uses 35s for the inbound POST chain;
	// relay caps internally at 90s for IMAP I/O. Anything beyond 35s
	// here usually means the relay itself is stuck and we should bail
	// for this tick.
	imapFetchTimeout = 35 * time.Second

	// imapFetchLimit caps how many messages relay returns per poll.
	// Mirrors BFF caller (limit:30 with include_body=true). Relay also
	// caps internally; sending 30 is a defensive double-bound.
	imapFetchLimit = 30

	// imapCircuitOpenThreshold is the consecutive-failure count after
	// which the per-mailbox circuit opens to back off.
	imapCircuitOpenThreshold = 5

	// imapCircuitOpenMinutesShort / Long mirror the BFF escalation
	// (120 minutes for 5..9 fails, 240 minutes for 10+ fails).
	imapCircuitOpenMinutesShort = 120
	imapCircuitOpenMinutesLong  = 240
)

// ─── Types ──────────────────────────────────────────────────────────────

// imapPollMailbox holds the credentials and watermark state needed for
// one tick over one mailbox. Mirrors the BFF SQL projection.
type imapPollMailbox struct {
	ID               int64
	FromAddress      string
	IMAPHost         string
	IMAPPort         int
	Username         string
	Password         string
	PreferredCountry string
	PrevUID          int64
	PrevUIDValidity  int64
}

// imapFetchRequest matches services/relay/web/imap_fetch.go imapFetchRequest.
type imapFetchRequest struct {
	MailboxAddress   string `json:"mailbox_address"`
	IMAPHost         string `json:"imap_host"`
	IMAPPort         int    `json:"imap_port"`
	Username         string `json:"username"`
	Password         string `json:"password"`
	Folder           string `json:"folder,omitempty"`
	SinceUID         uint32 `json:"since_uid,omitempty"`
	Limit            int    `json:"limit,omitempty"`
	PreferredCountry string `json:"preferred_country,omitempty"`
	IncludeBody      bool   `json:"include_body,omitempty"`
}

// imapFetchMessage mirrors delivery.FetchedMessage on the relay side.
// We only consume the fields the orchestrator actually needs, so future
// relay additions are tolerated by the standard json decoder.
type imapFetchMessage struct {
	UID       uint32 `json:"uid"`
	MessageID string `json:"message_id"`
	InReplyTo string `json:"in_reply_to"`
	From      string `json:"from"`
	Subject   string `json:"subject"`
	Date      string `json:"date"`
	RawBody   []byte `json:"raw_body"`
}

// imapFetchResponse mirrors services/relay/web/imap_fetch.go imapFetchResponse.
type imapFetchResponse struct {
	OK          bool               `json:"ok"`
	Error       string             `json:"error,omitempty"`
	UIDValidity uint32             `json:"uid_validity,omitempty"`
	UnseenTotal int                `json:"unseen_total"`
	Messages    []imapFetchMessage `json:"messages,omitempty"`
	EgressLabel string             `json:"egress_label,omitempty"`
}

// ─── Loop ───────────────────────────────────────────────────────────────

// ImapPollLoop polls every active outreach_mailbox via relay /v1/imap-fetch
// every interval and feeds new RFC 5322 messages to the inbound processor.
type ImapPollLoop struct {
	db         *sql.DB
	processor  *thread.InboundProcessor
	relayURL   string
	relayToken string
	interval   time.Duration
	httpClient *http.Client
	logger     *slog.Logger
	direct     bool // relay decommission: fetch IMAP in-process (no relay) when true
}

// ImapPollOption is a functional option for NewImapPollLoop.
type ImapPollOption func(*ImapPollLoop)

// WithImapPollInterval overrides the default 5-minute interval.
func WithImapPollInterval(d time.Duration) ImapPollOption {
	return func(l *ImapPollLoop) {
		if d > 0 {
			l.interval = d
		}
	}
}

// WithImapHTTPClient injects a custom HTTP client. Tests use this to
// point the loop at a httptest.Server.
func WithImapHTTPClient(c *http.Client) ImapPollOption {
	return func(l *ImapPollLoop) {
		if c != nil {
			l.httpClient = c
		}
	}
}

// WithImapLogger replaces the default slog.Default logger.
func WithImapLogger(lg *slog.Logger) ImapPollOption {
	return func(l *ImapPollLoop) {
		if lg != nil {
			l.logger = lg
		}
	}
}

// WithImapDirect enables relay-free in-process IMAP fetching (the relay
// decommission path). When true, pollOne dials IMAP itself via
// imap.FetchMailboxDirect instead of POSTing to the anti-trace relay.
func WithImapDirect(d bool) ImapPollOption {
	return func(l *ImapPollLoop) { l.direct = d }
}

// NewImapPollLoop constructs an ImapPollLoop.
//
//	db        — orchestrator DB handle (also used by the inbound processor)
//	proc      — thread.InboundProcessor wired with classifier / photo deps
//	relayURL  — base URL of the anti-trace-relay service
//	relayToken— bearer token for /v1/imap-fetch (Authorization header)
func NewImapPollLoop(db *sql.DB, proc *thread.InboundProcessor, relayURL, relayToken string, opts ...ImapPollOption) *ImapPollLoop {
	l := &ImapPollLoop{
		db:         db,
		processor:  proc,
		relayURL:   strings.TrimRight(relayURL, "/"),
		relayToken: relayToken,
		interval:   defaultImapPollInterval,
		httpClient: &http.Client{Timeout: imapFetchTimeout},
		logger:     slog.Default(),
	}
	for _, o := range opts {
		o(l)
	}
	return l
}

// Run starts the long-running poll loop. Blocks until ctx is cancelled.
func (l *ImapPollLoop) Run(ctx context.Context) error {
	l.logger.Info("imap poll loop started",
		"op", "ImapPollLoop.Run",
		"interval", l.interval,
		"relay_url", l.relayURL)

	// First tick fires immediately so a freshly-deployed runner doesn't
	// wait `interval` before the first poll.
	l.tick(ctx)

	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			l.logger.Info("imap poll loop stopped", "op", "ImapPollLoop.Run/stop")
			return ctx.Err()
		case <-ticker.C:
			l.tick(ctx)
		}
	}
}

// tick runs one poll pass across every eligible mailbox.
func (l *ImapPollLoop) tick(ctx context.Context) {
	start := time.Now()
	mailboxes, err := l.loadMailboxes(ctx)
	if err != nil {
		l.logger.Error("imap poll: load mailboxes failed",
			"op", "ImapPollLoop.tick/load",
			"error", err)
		return
	}
	if len(mailboxes) == 0 {
		l.logger.Info("imap poll: no eligible mailboxes",
			"op", "ImapPollLoop.tick/empty")
		return
	}

	processed := 0
	for _, mb := range mailboxes {
		if ctx.Err() != nil {
			return
		}
		if err := l.pollOne(ctx, mb); err != nil {
			// pollOne already logs + bumps the circuit; no extra slog
			// here to keep one log line per failure type.
			continue
		}
		processed++
	}

	l.logger.Info("imap poll tick done",
		"op", "ImapPollLoop.tick",
		"mailboxes", len(mailboxes),
		"processed", processed,
		"duration_ms", time.Since(start).Milliseconds())
}

// loadMailboxes returns the set of mailboxes eligible for this tick.
// Same projection + filter as the BFF cron (server.js runImapPollCron).
func (l *ImapPollLoop) loadMailboxes(ctx context.Context) ([]imapPollMailbox, error) {
	if l.db == nil {
		return nil, nil
	}
	rows, err := l.db.QueryContext(ctx, `
		SELECT m.id,
		       m.from_address,
		       m.imap_host,
		       COALESCE(m.imap_port, 993),
		       COALESCE(m.imap_username, m.smtp_username),
		       m.password,
		       COALESCE(m.preferred_country, 'CZ'),
		       COALESCE(s.last_processed_uid, 0),
		       COALESCE(s.uid_validity, 0)
		FROM outreach_mailboxes m
		LEFT JOIN mailbox_imap_state s ON s.mailbox_id = m.id
		WHERE m.status NOT IN ('retired', 'auth_locked')
		  AND m.environment = 'production'
		  AND m.imap_host IS NOT NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("select mailboxes: %w", err)
	}
	defer rows.Close()

	var out []imapPollMailbox
	for rows.Next() {
		var mb imapPollMailbox
		if err := rows.Scan(
			&mb.ID, &mb.FromAddress, &mb.IMAPHost, &mb.IMAPPort,
			&mb.Username, &mb.Password, &mb.PreferredCountry,
			&mb.PrevUID, &mb.PrevUIDValidity,
		); err != nil {
			return nil, fmt.Errorf("scan mailbox: %w", err)
		}
		out = append(out, mb)
	}
	return out, rows.Err()
}

// pollOne fetches new messages for one mailbox, persists the watermark,
// and feeds raw bytes to the inbound processor.
func (l *ImapPollLoop) pollOne(ctx context.Context, mb imapPollMailbox) error {
	// 1. Circuit breaker — if open, skip this tick.
	if l.circuitOpen(ctx, mb.ID) {
		return nil
	}

	// 2. Fetch new messages — relay-free direct IMAP, or via the relay.
	var resp *imapFetchResponse
	var err error
	if l.direct {
		resp, err = l.fetchDirect(ctx, mb)
	} else {
		resp, err = l.fetchFromRelay(ctx, mb)
	}
	if err != nil {
		l.bumpCircuit(ctx, mb.ID, err)
		return err
	}
	if !resp.OK {
		// Treat relay-returned non-OK like transient relay failure.
		// Mirrors BFF behaviour: log + continue without opening the
		// per-mailbox circuit (the circuit was for direct-dial fails
		// in the original BFF impl).
		l.logger.Warn("imap poll: relay returned non-ok",
			"op", "ImapPollLoop.pollOne/relayNotOk",
			"mailbox_id", mb.ID,
			"error", resp.Error)
		return nil
	}

	// 3. Compute the candidate UID watermark (highest UID this fetch). This is
	//    NOT persisted yet — saveState runs AFTER the ProcessReply loop (step 6)
	//    so a failed reply can cap the saved watermark below its UID and keep it
	//    re-fetchable. Persisting here (the pre-fix order) advanced the watermark
	//    past messages whose ProcessReply then errored+continued → the relay's
	//    next SinceUID filter skipped them forever → permanent reply loss. This
	//    mirrors orchestrator/imap/poller.go's firstFailedUID handling.
	highestUID := int64(mb.PrevUID)
	for _, m := range resp.Messages {
		if int64(m.UID) > highestUID {
			highestUID = int64(m.UID)
		}
	}
	uidValidity := int64(resp.UIDValidity)

	// 4. Feed each message to the inbound processor in-process.
	//
	// Track the LOWEST UID whose ProcessReply returned non-nil this tick. The
	// watermark must not advance past a message that never persisted, or the
	// next poll skips it forever (RCA 2026-06-01). Capping below it keeps the
	// message re-fetchable; re-processing successes above it next poll is safe
	// (ProcessReply is idempotent — reply_inbox dedup + unmatched_inbound upsert).
	var firstFailedUID int64
	for _, m := range resp.Messages {
		if len(m.RawBody) == 0 {
			continue
		}
		raw := thread.RawInbound{
			MessageID:  strings.TrimSpace(m.MessageID),
			InReplyTo:  strings.TrimSpace(m.InReplyTo),
			From:       strings.TrimSpace(m.From),
			Subject:    strings.TrimSpace(m.Subject),
			RawBytes:   m.RawBody,
			ReceivedAt: parseInboundDate(m.Date),
		}
		if perr := l.processor.ProcessReply(ctx, raw); perr != nil {
			l.logger.Warn("imap poll: ProcessReply failed",
				"op", "ImapPollLoop.pollOne/processReply",
				"mailbox_id", mb.ID,
				"message_id", m.MessageID,
				"error", perr)
			// Do NOT advance the watermark past this UID. Track the lowest
			// failed UID so saveState caps below it; the rest of the batch
			// still processes (one bad message shouldn't drop the entire
			// mailbox's inbound for this tick).
			if m.UID > 0 && (firstFailedUID == 0 || int64(m.UID) < firstFailedUID) {
				firstFailedUID = int64(m.UID)
			}
		}
	}

	// 5. Cap the watermark below the first failed UID. With zero failures it
	//    advances to highestUID; otherwise it stops at firstFailedUID-1 so the
	//    failed message (and anything after it) is re-fetched next tick.
	savedUID := highestUID
	if firstFailedUID > 0 {
		if capUID := firstFailedUID - 1; savedUID > capUID {
			savedUID = capUID
		}
	}

	// 6. Persist mailbox_imap_state with the (capped) UID watermark + validity.
	//    saveState keeps GREATEST() monotonicity so a cap below PrevUID can
	//    never regress the stored watermark.
	if err := l.saveState(ctx, mb.ID, resp.UnseenTotal, savedUID, uidValidity); err != nil {
		l.logger.Warn("imap poll: save state failed",
			"op", "ImapPollLoop.pollOne/saveState",
			"mailbox_id", mb.ID,
			"error", err)
	}

	// 7. UIDVALIDITY change detection (RFC 3501 §2.3.1.1).
	if mb.PrevUIDValidity != 0 && uidValidity != 0 && mb.PrevUIDValidity != uidValidity {
		l.recordValidityChange(ctx, mb, uidValidity)
	}

	// 8. Reset circuit on success.
	l.resetCircuit(ctx, mb.ID)
	return nil
}

// fetchDirect performs a relay-free, in-process IMAP fetch for one mailbox and
// adapts the result to imapFetchResponse so the rest of pollOne is unchanged.
// Bounded by imapFetchTimeout per mailbox (connect() honors ctx cancellation).
func (l *ImapPollLoop) fetchDirect(ctx context.Context, mb imapPollMailbox) (*imapFetchResponse, error) {
	cctx, cancel := context.WithTimeout(ctx, imapFetchTimeout)
	defer cancel()
	cfg := config.MailboxConfig{
		Address:          mb.FromAddress,
		IMAPHost:         mb.IMAPHost,
		IMAPPort:         mb.IMAPPort,
		Username:         mb.Username,
		Password:         mb.Password,
		PreferredCountry: mb.PreferredCountry,
	}
	res, err := imapPkg.FetchMailboxDirect(cctx, cfg, mb.PrevUID)
	if err != nil {
		return nil, fmt.Errorf("direct imap fetch: %w", err)
	}
	out := &imapFetchResponse{
		OK:          true,
		UIDValidity: uint32(res.UIDValidity),
		UnseenTotal: len(res.Messages),
	}
	for _, m := range res.Messages {
		out.Messages = append(out.Messages, imapFetchMessage{
			UID:       uint32(m.UID),
			MessageID: m.Inbound.MessageID,
			InReplyTo: m.Inbound.InReplyTo,
			From:      m.Inbound.From,
			Subject:   m.Inbound.Subject,
			Date:      m.Inbound.ReceivedAt.Format(time.RFC3339),
			RawBody:   m.Inbound.RawBytes,
		})
	}
	return out, nil
}

// fetchFromRelay POSTs the IMAP request to the relay service.
func (l *ImapPollLoop) fetchFromRelay(ctx context.Context, mb imapPollMailbox) (*imapFetchResponse, error) {
	if l.relayURL == "" {
		return nil, fmt.Errorf("relay url not configured")
	}
	reqBody := imapFetchRequest{
		MailboxAddress:   mb.FromAddress,
		IMAPHost:         mb.IMAPHost,
		IMAPPort:         mb.IMAPPort,
		Username:         mb.Username,
		Password:         mb.Password,
		Folder:           "INBOX",
		SinceUID:         uint32(mb.PrevUID),
		Limit:            imapFetchLimit,
		PreferredCountry: mb.PreferredCountry,
		IncludeBody:      true,
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal imap-fetch request: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, imapFetchTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(cctx, http.MethodPost, l.relayURL+"/v1/imap-fetch", bytes.NewReader(buf))
	if err != nil {
		return nil, fmt.Errorf("build imap-fetch http request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if l.relayToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+l.relayToken)
	}
	res, err := l.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("imap-fetch http: %w", err)
	}
	defer res.Body.Close()

	// Bound the response body so a misbehaving relay can't OOM the runner.
	// imapFetchLimit messages × ~1 MB attachments ≈ 30 MB; 64 MB is the
	// defensive ceiling matching maxInboundBodyBytes on the inbound side.
	body, err := io.ReadAll(io.LimitReader(res.Body, 64*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("imap-fetch read body: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		// Relay returns 502 + JSON {ok:false,error:...} on upstream IMAP
		// fail; surface this as a non-OK response rather than a hard error
		// so the caller can log + continue per mailbox.
		var parsed imapFetchResponse
		_ = json.Unmarshal(body, &parsed)
		return &imapFetchResponse{
			OK:          false,
			Error:       fmt.Sprintf("relay http %d: %s", res.StatusCode, firstLine(string(body))),
			UIDValidity: parsed.UIDValidity,
		}, nil
	}
	var parsed imapFetchResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("imap-fetch decode: %w", err)
	}
	return &parsed, nil
}

// saveState upserts mailbox_imap_state with the new watermark + validity.
func (l *ImapPollLoop) saveState(ctx context.Context, mailboxID int64, unseen int, highestUID, uidValidity int64) error {
	if l.db == nil {
		return nil
	}
	_, err := l.db.ExecContext(ctx, `
		INSERT INTO mailbox_imap_state(mailbox_id, unseen, prev_unseen, last_processed_uid, uid_validity, polled_at)
		VALUES($1, $2, $2, $3, NULLIF($4, 0), now())
		ON CONFLICT(mailbox_id) DO UPDATE
		   SET prev_unseen        = mailbox_imap_state.unseen,
		       unseen             = EXCLUDED.unseen,
		       last_processed_uid = GREATEST(COALESCE(mailbox_imap_state.last_processed_uid, 0), COALESCE(EXCLUDED.last_processed_uid, 0)),
		       uid_validity       = EXCLUDED.uid_validity,
		       polled_at          = now()
	`, mailboxID, unseen, highestUID, uidValidity)
	return err
}

// recordValidityChange writes a healing_log row when the relay's reported
// UIDVALIDITY differs from the stored value (mailbox was rebuilt).
func (l *ImapPollLoop) recordValidityChange(ctx context.Context, mb imapPollMailbox, newValidity int64) {
	if l.db == nil {
		return
	}
	if _, err := l.db.ExecContext(ctx, `
		INSERT INTO healing_log(entity_type, entity_id, entity_label, action, reason)
		VALUES('mailbox', $1, $2, 'uid_validity_change', $3)
	`, fmt.Sprintf("%d", mb.ID), mb.FromAddress,
		fmt.Sprintf("%d → %d", mb.PrevUIDValidity, newValidity),
	); err != nil {
		l.logger.Warn("imap poll: healing_log insert failed",
			"op", "ImapPollLoop.pollOne/healingLog",
			"mailbox_id", mb.ID,
			"error", err)
	}
}

// circuitOpen reports whether the per-mailbox circuit breaker is
// currently open. We never block — a DB error just returns false.
func (l *ImapPollLoop) circuitOpen(ctx context.Context, mailboxID int64) bool {
	if l.db == nil {
		return false
	}
	var openUntil sql.NullTime
	err := l.db.QueryRowContext(ctx, `
		SELECT open_until FROM mailbox_imap_circuit WHERE mailbox_id = $1
	`, mailboxID).Scan(&openUntil)
	if err != nil || !openUntil.Valid {
		return false
	}
	return openUntil.Time.After(time.Now())
}

// bumpCircuit increments the circuit breaker counter and opens the
// circuit when the threshold is exceeded. Mirrors the BFF semantics.
func (l *ImapPollLoop) bumpCircuit(ctx context.Context, mailboxID int64, cause error) {
	if l.db == nil {
		return
	}
	var failCount int
	err := l.db.QueryRowContext(ctx, `
		INSERT INTO mailbox_imap_circuit(mailbox_id, fail_count, updated_at)
		VALUES($1, 1, now())
		ON CONFLICT(mailbox_id) DO UPDATE
		   SET fail_count = mailbox_imap_circuit.fail_count + 1,
		       updated_at = now()
		RETURNING fail_count
	`, mailboxID).Scan(&failCount)
	if err != nil {
		l.logger.Warn("imap poll: bump circuit failed",
			"op", "ImapPollLoop.bumpCircuit",
			"mailbox_id", mailboxID,
			"error", err)
		return
	}
	if failCount >= imapCircuitOpenThreshold {
		openMinutes := imapCircuitOpenMinutesShort
		if failCount >= 10 {
			openMinutes = imapCircuitOpenMinutesLong
		}
		if _, uerr := l.db.ExecContext(ctx, `
			UPDATE mailbox_imap_circuit
			   SET open_until = now() + ($2 * INTERVAL '1 minute')
			 WHERE mailbox_id = $1
		`, mailboxID, openMinutes); uerr != nil {
			l.logger.Warn("imap poll: open circuit failed",
				"op", "ImapPollLoop.bumpCircuit/open",
				"mailbox_id", mailboxID,
				"error", uerr)
			return
		}
		l.logger.Warn("imap poll: circuit opened",
			"op", "ImapPollLoop.bumpCircuit/opened",
			"mailbox_id", mailboxID,
			"fail_count", failCount,
			"open_minutes", openMinutes,
			"error", cause)
	}
}

// resetCircuit clears the circuit counter for a healthy mailbox.
func (l *ImapPollLoop) resetCircuit(ctx context.Context, mailboxID int64) {
	if l.db == nil {
		return
	}
	if _, err := l.db.ExecContext(ctx, `
		INSERT INTO mailbox_imap_circuit(mailbox_id, fail_count, open_until, updated_at)
		VALUES($1, 0, NULL, now())
		ON CONFLICT(mailbox_id) DO UPDATE
		   SET fail_count = 0,
		       open_until = NULL,
		       updated_at = now()
	`, mailboxID); err != nil {
		l.logger.Warn("imap poll: reset circuit failed",
			"op", "ImapPollLoop.resetCircuit",
			"mailbox_id", mailboxID,
			"error", err)
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────

// parseInboundDate accepts RFC 5322 IMAP Date header strings ("Mon, 11
// May 2026 14:44:36 +0200") or RFC 3339 ISO 8601, returning time.Now()
// when nothing parses. Mirrors web.handleInbound's date handling.
func parseInboundDate(s string) time.Time {
	s = strings.TrimSpace(s)
	if s != "" {
		// net/mail's ParseDate handles RFC 5322 + several legacy obsolete
		// formats; covers virtually every real Date: header in the wild.
		if t, err := mail.ParseDate(s); err == nil {
			return t
		}
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t
		}
	}
	return time.Now().UTC()
}

// firstLine returns the first line of a string (used to bound a relay
// error message in slog without printing the full HTML/JSON payload).
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// startImapPollLoop wires the cron into the orchestrator `server` boot path.
// Returns true when the cron is enabled and the goroutine was launched.
// Returns false when the cron is gated off — caller logs the reason.
func startImapPollLoop(ctx context.Context, db *sql.DB, proc *thread.InboundProcessor) bool {
	if envconfig.BoolOr("DISABLE_IMAP_POLL_LOOP", false) {
		slog.Info("imap poll loop disabled (DISABLE_IMAP_POLL_LOOP=1)",
			"op", "main.startImapPollLoop/disabled")
		return false
	}
	// Relay decommission: ALLOW_IMAP_DIRECT=1 switches the loop to relay-free
	// in-process IMAP fetching. Explicit opt-in so the orchestrator native IP is
	// never silently exposed in mailbox login telemetry.
	direct := envconfig.BoolOr("ALLOW_IMAP_DIRECT", false)
	relayURL := envconfig.GetOr("ANTI_TRACE_RELAY_URL", "")
	relayToken := envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", envconfig.GetOr("ANTI_TRACE_TOKEN", ""))
	if !direct && (relayURL == "" || relayToken == "") {
		slog.Warn("imap poll loop not started — relay url/token unset and ALLOW_IMAP_DIRECT not set",
			"op", "main.startImapPollLoop/configMissing",
			"have_url", relayURL != "",
			"have_token", relayToken != "")
		return false
	}

	opts := []ImapPollOption{}
	if v := envconfig.GetOr("IMAP_POLL_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			opts = append(opts, WithImapPollInterval(d))
		}
	}
	if direct {
		opts = append(opts, WithImapDirect(true))
	}
	loop := NewImapPollLoop(db, proc, relayURL, relayToken, opts...)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("imap poll loop panic recovered",
					"op", "main.startImapPollLoop/recover",
					"recover", r)
			}
		}()
		if err := loop.Run(ctx); err != nil && ctx.Err() == nil {
			slog.Error("imap poll loop exited unexpectedly",
				"op", "main.startImapPollLoop/exit",
				"error", err)
		}
	}()
	mode := "relay"
	if direct {
		mode = "direct"
	}
	slog.Info("imap poll loop started",
		"op", "main.startImapPollLoop/ok",
		"mode", mode,
		"relay_url", relayURL)
	return true
}
