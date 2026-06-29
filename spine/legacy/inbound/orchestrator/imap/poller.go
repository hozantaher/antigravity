package imap

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"os"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"common/audit"
	"common/config"
	"common/envconfig"
	"common/health"
	"golang.org/x/net/html/charset"
	"golang.org/x/net/proxy"
	"orchestrator/thread"
)

// defaultSeenCap caps the in-memory dedupe LRU. Sized for a typical
// busy mailbox: ~1000 inbounds/day × ~30 days of history is well under
// 50k entries; long-running pollers stay bounded under any churn.
const defaultSeenCap = 50_000

// Poller fetches new emails from IMAP mailboxes and routes them to the inbound processor.
type Poller struct {
	mailboxes []config.MailboxConfig
	processor *thread.InboundProcessor
	// seen is a bounded FIFO dedupe set keyed by Message-ID. F4-1
	// (2026-04-29): pre-fix this was an unbounded map[string]bool —
	// each PollOnce added entries forever, leaking memory linearly
	// with mailbox volume over weeks (hundreds of MB on a busy
	// mailbox).
	seen     map[string]struct{}
	seenList []string // FIFO order; head is oldest, tail is newest
	seenCap  int
	lastPoll time.Time
	health   *health.Registry
	// auditDB writes Track E inbound channel_audit_log rows after each
	// successful ProcessReply. Optional — nil keeps the legacy behaviour
	// (helpful for unit tests that don't care about audit).
	auditDB audit.Execer
	// uidStore persists UIDvalidity + watermark to survive restarts.
	// Nil disables DB persistence; seen-set still dedupes within the session.
	uidStore UIDValidityStore
}

// NewPoller creates an IMAP poller.
func NewPoller(mailboxes []config.MailboxConfig, processor *thread.InboundProcessor) *Poller {
	return &Poller{
		mailboxes: mailboxes,
		processor: processor,
		seen:      make(map[string]struct{}),
		seenList:  make([]string, 0, defaultSeenCap),
		seenCap:   defaultSeenCap,
	}
}

// WithSeenCap overrides the dedupe-set capacity. Test-only helper.
func (p *Poller) WithSeenCap(n int) *Poller {
	if n < 1 {
		n = 1
	}
	p.seenCap = n
	return p
}

// markSeen records a message-id in the bounded dedupe set. When the set
// is at capacity, the oldest entry is evicted (FIFO).
func (p *Poller) markSeen(messageID string) {
	if _, ok := p.seen[messageID]; ok {
		return // idempotent — already marked
	}
	if len(p.seenList) >= p.seenCap {
		// Evict the oldest. We accept the slice-shift cost (O(n)) in
		// favor of keeping a simple data structure; it amortises to
		// O(1) over all inserts because eviction only fires once per
		// new entry past the cap.
		oldest := p.seenList[0]
		delete(p.seen, oldest)
		p.seenList = p.seenList[1:]
	}
	p.seen[messageID] = struct{}{}
	p.seenList = append(p.seenList, messageID)
}

// isSeen reports whether the message-id has been recorded.
func (p *Poller) isSeen(messageID string) bool {
	_, ok := p.seen[messageID]
	return ok
}

// WithHealth attaches a health registry for daemon status reporting.
func (p *Poller) WithHealth(reg *health.Registry) *Poller {
	p.health = reg
	return p
}

// WithAuditDB wires a Track E inbound audit sink. After each successful
// ProcessReply the poller records an inbound row in `channel_audit_log`
// (migration 019). Pass nil — or skip the call — to disable; audit is
// best-effort and never blocks reply processing.
func (p *Poller) WithAuditDB(db audit.Execer) *Poller {
	p.auditDB = db
	return p
}

// UIDValidityStore persists per-mailbox UIDvalidity + UID watermark across
// orchestrator restarts. Implemented by any *sql.DB wrapper over
// mailbox_imap_state (migration 054). Pass nil to disable persistence —
// the in-memory seen-set still deduplicates within a single session.
type UIDValidityStore interface {
	// LoadUIDState returns (storedValidity, watermark, error).
	// Returns (0, 0, nil) when no row exists for this mailbox yet.
	LoadUIDState(ctx context.Context, mailboxAddr string) (uidValidity int64, watermark int64, err error)
	// SaveUIDState atomically persists validity + watermark for the mailbox.
	SaveUIDState(ctx context.Context, mailboxAddr string, uidValidity int64, watermark int64) error
}

// WithUIDValidityStore wires a persistent UIDvalidity store. Call before the
// first PollOnce. Safe to omit in tests that only care about in-session dedup.
func (p *Poller) WithUIDValidityStore(s UIDValidityStore) *Poller {
	p.uidStore = s
	return p
}

// PollResult summarizes one polling cycle.
type PollResult struct {
	Mailbox  string
	Fetched  int
	Matched  int
	Errors   int
	Duration time.Duration
}

// PollOnce checks all mailboxes for new replies.
// For each mailbox it:
//  1. Fetches unseen messages (UIDvalidity captured from SELECT response).
//  2. Compares the server UIDvalidity against the stored value.
//  3. On mismatch (mailbox rebuild): clears the watermark, re-processes all
//     unseen messages, and logs a warning.
//  4. Applies the UID watermark to skip messages already processed.
//  5. Persists updated UIDvalidity + watermark atomically via uidStore.
func (p *Poller) PollOnce(ctx context.Context) ([]PollResult, error) {
	var results []PollResult

	for _, mb := range p.mailboxes {
		if mb.IMAPHost == "" || mb.IMAPPort == 0 {
			continue
		}

		start := time.Now()
		result := PollResult{Mailbox: mb.Address}

		// Pre-load UID state BEFORE the fetch so we can use the watermark in
		// the IMAP SEARCH command. Pre-2026-05-16 the watermark was applied
		// AFTER fetch as a post-filter on `UID SEARCH UNSEEN`, which meant
		// messages already marked \Seen by an operator opening webmail were
		// silently skipped (4 days of reply data loss diagnosed 2026-05-16).
		var storedValidity, storedWatermark int64
		if p.uidStore != nil {
			var loadErr error
			storedValidity, storedWatermark, loadErr = p.uidStore.LoadUIDState(ctx, mb.Address)
			if loadErr != nil {
				slog.Warn("imap uidstore load failed, falling back to UNSEEN search",
					"op", "Poller.Poll/uidLoadFail",
					"mailbox", mb.Address, "error", loadErr)
				storedValidity, storedWatermark = 0, 0
			}
		}

		fetchRes, err := p.fetchNewMessagesWithWatermark(ctx, mb, storedWatermark)
		if err != nil {
			slog.Error("imap fetch error", "op", "Poller.Poll/fetchFail", "mailbox", mb.Address, "error", err)
			result.Errors = 1
			result.Duration = time.Since(start)
			results = append(results, result)
			continue
		}

		serverValidity := fetchRes.UIDValidity
		validityChanged := serverValidity != 0 && storedValidity != 0 && serverValidity != storedValidity
		if validityChanged {
			slog.Warn("imap UIDVALIDITY changed — mailbox rebuilt, resetting watermark",
				"op", "Poller.Poll/uidValidityReset",
				"mailbox", mb.Address,
				"stored", storedValidity,
				"server", serverValidity)
			storedWatermark = 0 // full re-fetch
		}

		// Apply watermark filter: skip messages already seen in previous polls.
		var maxUID int64
		// Lowest UID whose ProcessReply FAILED this cycle (0 = none). The
		// watermark must not advance past it, otherwise a message that was
		// never persisted (e.g. a swallowed unmatched_inbound insert error)
		// would be skipped forever on the next poll → silent permanent loss
		// (RCA 2026-06-01). Capping below it keeps the message re-fetchable;
		// re-processing successes above it is safe (reply_inbox dedup keys on
		// the message's own Date, unmatched_inbound upserts ON CONFLICT).
		var firstFailedUID int64
		for _, item := range fetchRes.Messages {
			if item.UID > 0 && storedWatermark > 0 && item.UID <= storedWatermark {
				continue // already processed in a previous poll
			}
			result.Fetched++

			if p.isSeen(item.Msg.MessageID) {
				continue
			}

			msg := item.Msg
			// G3.1: stamp the polling mailbox address so insertReplyInbox can
			// resolve mailbox_id even when no send_events row exists for the
			// contact (e.g. legacy sends pre-dating the send_events schema).
			msg.MailboxAddr = mb.Address
			err := p.processor.ProcessReply(ctx, msg)
			if err != nil {
				slog.Error("imap process error", "op", "Poller.Poll/processFail", "mailbox", mb.Address, "message_id", msg.MessageID, "error", err)
				result.Errors++
				// Do NOT markSeen — the in-memory dedup would block the retry
				// within this process lifetime. Track the lowest failed UID so
				// the watermark stays below it.
				if item.UID > 0 && (firstFailedUID == 0 || item.UID < firstFailedUID) {
					firstFailedUID = item.UID
				}
				continue
			}
			// Mark seen only AFTER a successful, persisted ProcessReply.
			p.markSeen(item.Msg.MessageID)
			result.Matched++
			if item.UID > maxUID {
				maxUID = item.UID
			}

			// Track E (migration 019) — inbound channel audit. Best-effort:
			// LogChannel swallows DB errors so a flaky audit table never
			// degrades the IMAP reply path.
			if p.auditDB != nil {
				audit.LogChannel(ctx, p.auditDB,
					audit.ChannelEmail, audit.DirectionInbound,
					msg.From, msg.MessageID,
					map[string]any{
						"mailbox": mb.Address,
					})
			}
		}

		// Cap the watermark so it never advances past the first failed UID —
		// that message (and anything after it) must stay re-fetchable until it
		// persists. Successes above the failure get re-processed next poll
		// (idempotent), which is the price of not losing the failed one.
		if firstFailedUID > 0 {
			capUID := firstFailedUID - 1
			if maxUID > capUID {
				maxUID = capUID
			}
		}

		// Persist updated UIDvalidity + watermark (monotonically advancing).
		if p.uidStore != nil && serverValidity != 0 {
			newWatermark := storedWatermark
			if maxUID > newWatermark {
				newWatermark = maxUID
			}
			if saveErr := p.uidStore.SaveUIDState(ctx, mb.Address, serverValidity, newWatermark); saveErr != nil {
				slog.Warn("imap uidstore save failed",
					"op", "Poller.Poll/uidSaveFail",
					"mailbox", mb.Address, "error", saveErr)
			}
		}

		result.Duration = time.Since(start)
		results = append(results, result)

		if result.Fetched > 0 {
			slog.Info("imap poll result",
				"mailbox", mb.Address,
				"fetched", result.Fetched,
				"matched", result.Matched,
				"errors", result.Errors,
				"duration", result.Duration.Round(time.Millisecond),
				"uid_validity", serverValidity,
				"validity_changed", validityChanged)
		}
	}

	p.lastPoll = time.Now()
	if p.health != nil {
		p.health.Report("imap_poll", true, "")
	}
	return results, nil
}

// runWithReconnect wraps handler in a reconnect loop with exponential backoff.
// handler receives a fresh connection on every invocation. On error the loop
// waits [backoff] (doubling up to 5 min) then retries. The loop exits when ctx
// is cancelled.
func runWithReconnect(ctx context.Context, cfg config.MailboxConfig, handler func(ctx context.Context, conn net.Conn) error, dial func(context.Context, config.MailboxConfig) (net.Conn, error)) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}

		conn, err := dial(ctx, cfg)
		if err != nil {
			slog.Warn("imap dial failed, reconnecting", "op", "withBackoff/dialFail", "mailbox", cfg.Address, "backoff", backoff, "err", err)
		} else {
			err = handler(ctx, conn)
			conn.Close()
			if err == nil {
				backoff = time.Second // reset on success
				return
			}
			slog.Warn("imap disconnected, reconnecting", "op", "withBackoff/handlerFail", "mailbox", cfg.Address, "backoff", backoff, "err", err)
		}

		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		if backoff < 5*time.Minute {
			backoff *= 2
			if backoff > 5*time.Minute {
				backoff = 5 * time.Minute
			}
		}
	}
}

// noopInterval is how often a NOOP is sent to keep the connection alive.
const noopInterval = 20 * time.Minute

// PollDaemon runs the poller on a schedule. Each poll cycle opens a fresh
// connection; if a cycle returns an error, runWithReconnect retries with
// exponential backoff before the next tick.
func (p *Poller) PollDaemon(ctx context.Context, interval time.Duration) error {
	slog.Info("imap daemon started", "interval", interval, "mailboxes", len(p.mailboxes))

	// Poll immediately
	p.PollOnce(ctx)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	noop := time.NewTicker(noopInterval)
	defer noop.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("imap daemon stopped")
			return ctx.Err()
		case <-noop.C:
			// Send NOOP to each mailbox to keep any persistent TCP state alive
			// at the network layer. fetchNewMessages opens a fresh connection
			// per cycle, so we just log a heartbeat here.
			slog.Debug("imap noop heartbeat")
		case <-ticker.C:
			p.PollOnce(ctx)
		}
	}
}

// RawMessage is a parsed email from IMAP.
type RawMessage struct {
	MessageID  string
	InReplyTo  string
	References string
	From       string
	Subject    string
	Body       string
	Date       time.Time
}

// inboundWithUID pairs a RawInbound with its numeric IMAP UID for watermark
// advancement. The UID is imap-package-internal; thread.RawInbound is unchanged.
type inboundWithUID struct {
	Msg thread.RawInbound
	UID int64 // 0 when the server UID is non-numeric (should not happen)
}

// fetchResult bundles messages from one IMAP session with the UIDvalidity value
// from the SELECT response (RFC 3501 §7.1).
type fetchResult struct {
	Messages    []inboundWithUID
	UIDValidity int64 // 0 if server did not include UIDVALIDITY in SELECT
}

// fetchNewMessages connects to IMAP and fetches unseen messages.
// On transient errors it uses runWithReconnect with exponential backoff.
//
// Legacy entry-point: watermark=0 forces UNSEEN-based search (used on first
// poll for a mailbox before any UID watermark exists in mailbox_imap_state).
func (p *Poller) fetchNewMessages(ctx context.Context, mb config.MailboxConfig) (fetchResult, error) {
	return p.fetchNewMessagesWithDial(ctx, mb, 0, connect)
}

// fetchNewMessagesWithWatermark prefers UID > watermark over UNSEEN flag.
// 2026-05-16 fix: UNSEEN-based search silently skipped messages that the
// operator marked \Seen by reading them in webmail. UID watermark catches
// them regardless of \Seen state.
func (p *Poller) fetchNewMessagesWithWatermark(ctx context.Context, mb config.MailboxConfig, watermark int64) (fetchResult, error) {
	return p.fetchNewMessagesWithDial(ctx, mb, watermark, connect)
}

// ── Relay-free direct fetch (relay decommission, 2026-06-19) ────────────────

// DirectMessage pairs a fetched inbound message with its IMAP UID so the caller
// can advance its own watermark.
type DirectMessage struct {
	UID     int64
	Inbound thread.RawInbound
}

// DirectFetchResult is the outcome of one FetchMailboxDirect call.
type DirectFetchResult struct {
	UIDValidity int64
	Messages    []DirectMessage
}

// FetchMailboxDirect performs ONE stateless IMAP fetch for a single mailbox and
// returns the new messages (UID > sinceUID, or UNSEEN when sinceUID==0) plus the
// mailbox UIDVALIDITY. It dials via connect() — a SOCKS5 endpoint when one is
// configured (IMAP_SOCKS_* / relay), or a DIRECT TCP/TLS dial when
// ALLOW_IMAP_DIRECT=1. This is the relay-free replacement for the anti-trace
// relay's POST /v1/imap-fetch: the orchestrator runs the IMAP protocol itself
// in-process instead of delegating it to the relay container.
//
// Stateless by design — the caller (cmd/outreach ImapPollLoop) owns watermark
// persistence (mailbox_imap_state) and ProcessReply routing. Bound the per-call
// time by passing a ctx with a deadline; connect()/runWithReconnect honor it.
//
// POLICY NOTE: direct dialling (ALLOW_IMAP_DIRECT=1) bypasses the anti-trace
// egress shield and exposes the orchestrator's native IP in mailbox login
// telemetry — the multi-country/datacenter pattern that originally triggered the
// nowak.gorak fraud lock (feedback_no_direct_smtp). Enabled ONLY by explicit
// operator decision during the relay decommission.
func FetchMailboxDirect(ctx context.Context, mb config.MailboxConfig, sinceUID int64) (DirectFetchResult, error) {
	return fetchMailboxDirect(ctx, mb, sinceUID, connect)
}

// fetchMailboxDirect is the dial-injectable core of FetchMailboxDirect; tests
// substitute a scriptConn dialer to avoid real network I/O.
func fetchMailboxDirect(ctx context.Context, mb config.MailboxConfig, sinceUID int64, dial func(context.Context, config.MailboxConfig) (net.Conn, error)) (DirectFetchResult, error) {
	p := NewPoller(nil, nil)
	res, err := p.fetchNewMessagesWithDial(ctx, mb, sinceUID, dial)
	if err != nil {
		return DirectFetchResult{}, err
	}
	out := DirectFetchResult{UIDValidity: res.UIDValidity}
	for _, m := range res.Messages {
		out.Messages = append(out.Messages, DirectMessage{UID: m.UID, Inbound: m.Msg})
	}
	return out, nil
}

// fetchNewMessagesWithDial is the dial-injectable variant of fetchNewMessages.
// Tests use it to substitute a scriptConn without starting a real TCP server.
func (p *Poller) fetchNewMessagesWithDial(ctx context.Context, mb config.MailboxConfig, watermark int64, dial func(context.Context, config.MailboxConfig) (net.Conn, error)) (fetchResult, error) {
	var result fetchResult
	var fetchErr error

	runWithReconnect(ctx, mb, func(ctx context.Context, conn net.Conn) error {
		r, err := p.doFetch(ctx, conn, mb, watermark)
		if err != nil {
			fetchErr = err
			return err
		}
		result = r
		return nil
	}, dial)

	if ctx.Err() != nil {
		return fetchResult{}, fmt.Errorf("context cancelled: %w", ctx.Err())
	}
	return result, fetchErr
}

// doFetch performs the actual IMAP session on an already-connected net.Conn.
// It captures UIDVALIDITY from the SELECT response per RFC 3501 §7.1.
//
// watermark > 0: select via `UID SEARCH UID <wm+1>:*` — fetches every message
// with UID greater than the watermark regardless of \Seen flag. This is the
// post-2026-05-16 default that survives operators reading webmail.
// watermark == 0: legacy `UID SEARCH UNSEEN [SINCE date]` — used only on the
// very first poll for a mailbox (before any state row exists).
func (p *Poller) doFetch(ctx context.Context, conn net.Conn, mb config.MailboxConfig, watermark int64) (fetchResult, error) {
	// Login
	if err := command(conn, fmt.Sprintf("LOGIN %s %s", mb.Username, mb.Password)); err != nil {
		return fetchResult{}, fmt.Errorf("login: %w", err)
	}

	// Select INBOX — capture full response to extract UIDVALIDITY.
	// selectInbox uses tag "A001" (same as command()) which is safe because
	// IMAP commands are sequential; each round-trip fully completes before
	// the next command is sent.
	selectResp, err := selectInbox(conn)
	if err != nil {
		return fetchResult{}, fmt.Errorf("select: %w", err)
	}
	uidValidity := parseUIDValidity(selectResp)
	if uidValidity == 0 {
		slog.Warn("imap SELECT response missing UIDVALIDITY",
			"op", "doFetch/noUIDVALIDITY",
			"mailbox", mb.Address)
	}

	// Send NOOP to confirm connection is alive before expensive fetch
	if err := command(conn, "NOOP"); err != nil {
		return fetchResult{}, fmt.Errorf("noop: %w", err)
	}

	// 2026-05-16 fix: prefer UID range over UNSEEN. UNSEEN skips messages
	// the operator already read in webmail (4-day data loss diagnosed at
	// `mailbox_imap_state.unseen=0` for all 4 mailboxes while real replies
	// existed in INBOX). UID watermark is the canonical RFC 3501 way to
	// resume after a previous poll — independent of \Seen flag.
	//
	// First-poll edge case: when no watermark exists (storedWatermark=0),
	// fall back to UNSEEN to avoid pulling the full mailbox history. After
	// the first poll persists a watermark, subsequent polls use UID range.
	//
	// F4-3 (2026-04-29): RFC 3501 §6.4.4 — IMAP SINCE is a date the
	// server interprets in its local timezone (typically UTC). Force UTC
	// for the UNSEEN fallback so the formatted date matches the server's frame.
	var searchCmd string
	if watermark > 0 {
		searchCmd = fmt.Sprintf("UID SEARCH UID %d:*", watermark+1)
	} else if !p.lastPoll.IsZero() {
		searchCmd = fmt.Sprintf("UID SEARCH UNSEEN SINCE %s", p.lastPoll.UTC().Format("02-Jan-2006"))
	} else {
		searchCmd = "UID SEARCH UNSEEN"
	}

	// DEBUG-TRACE 2026-05-17 — when IMAP_INSPECT=1 env set, list ALL UIDs
	// in INBOX to diagnose missing replies. Compares to watermark to see
	// what's actually there. Remove after diagnosis. Gated by env so tests
	// don't see extra commands in scriptConn replay.
	if os.Getenv("IMAP_INSPECT") == "1" {
		allResp, _ := commandResponse(conn, "UID SEARCH ALL")
		allUIDs := parseSearchResponse(allResp)
		min, max := "", ""
		if len(allUIDs) > 0 {
			min, max = allUIDs[0], allUIDs[len(allUIDs)-1]
		}
		slog.Info("inbound.trace/inboxState",
			"op", "doFetch/inboxState",
			"mailbox", mb.Address,
			"watermark", watermark,
			"total_uids_in_inbox", len(allUIDs),
			"min_uid", min,
			"max_uid", max,
			"search_cmd", searchCmd,
		)
	}

	response, err := commandResponse(conn, searchCmd)
	// commandResponse returns nil error even for BAD/NO server responses; we
	// also check the response body so that servers that reject UID commands with
	// a tagged BAD are handled gracefully (rare — RFC 3501 requires UID support).
	uidSearchRejected := err != nil ||
		strings.Contains(response, "A002 BAD") ||
		strings.Contains(response, "A002 NO")
	if uidSearchRejected {
		// Rare: server does not support UID SEARCH (violates RFC 3501 §6.4.8
		// baseline but some embedded servers omit it). Fall back to SEQ SEARCH
		// with a prominent warning — the race window is narrow in low-concurrency
		// environments, and crashing is worse than degraded accuracy.
		slog.Warn("imap UID SEARCH failed, falling back to SEQ SEARCH",
			"op", "doFetch/uidSearchFallback",
			"mailbox", mb.Address,
			"error", err)
		seqCmd := "SEARCH UNSEEN"
		if !p.lastPoll.IsZero() {
			seqCmd = fmt.Sprintf("SEARCH UNSEEN SINCE %s", p.lastPoll.UTC().Format("02-Jan-2006"))
		}
		response, err = commandResponse(conn, seqCmd)
		if err != nil {
			return fetchResult{}, fmt.Errorf("search: %w", err)
		}
	}

	uids := parseSearchResponse(response)
	if len(uids) == 0 {
		command(conn, "LOGOUT") //nolint:errcheck
		return fetchResult{UIDValidity: uidValidity}, nil
	}

	// Sort UIDs ascending so the watermark advances monotonically even when the
	// server returns them out of order (RFC 3501 does not guarantee order).
	sort.Slice(uids, func(i, j int) bool {
		ni, _ := strconv.ParseInt(uids[i], 10, 64)
		nj, _ := strconv.ParseInt(uids[j], 10, 64)
		return ni < nj
	})

	// Fetch headers + body for each UID using UID FETCH (RFC 3501 §6.4.8).
	// UID FETCH addresses messages by their persistent UID, not by their
	// session-scoped sequence number, eliminating the race condition in #878.
	var messages []inboundWithUID
	for _, uid := range uids {
		msg, err := fetchMessageByUID(conn, uid)
		if err != nil {
			slog.Warn("imap uid fetch failed", "op", "doFetch/uidFetchFail", "mailbox", mb.Address, "uid", uid, "error", err)
			continue
		}
		if msg == nil {
			continue
		}
		// Fall back to UID-based key so messages without Message-ID don't
		// collide in the seen map and get incorrectly deduplicated.
		if msg.MessageID == "" {
			msg.MessageID = "uid:" + uid + "@" + mb.IMAPHost
		}
		// Parse numeric UID for watermark advancement.
		var numUID int64
		if n, err2 := strconv.ParseInt(uid, 10, 64); err2 == nil {
			numUID = n
		}
		messages = append(messages, inboundWithUID{Msg: *msg, UID: numUID})
	}

	// Logout
	command(conn, "LOGOUT") //nolint:errcheck

	return fetchResult{Messages: messages, UIDValidity: uidValidity}, nil
}

// selectInbox issues SELECT INBOX and returns the full server response so the
// caller can extract UIDVALIDITY (RFC 3501 §7.1). Uses tag "A001" — safe because
// IMAP commands are sequential (no pipelining) so each round-trip completes
// before the next write. Errors on BAD/NO responses consistent with command().
func selectInbox(conn net.Conn) (string, error) {
	tag := "A001"
	line := fmt.Sprintf("%s SELECT INBOX\r\n", tag)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second)) //nolint:errcheck
	if _, err := conn.Write([]byte(line)); err != nil {
		return "", fmt.Errorf("write select: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second)) //nolint:errcheck
	var response bytes.Buffer
	buf := make([]byte, 8192)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return response.String(), fmt.Errorf("read select: %w", err)
		}
		response.Write(buf[:n])
		tail := response.Bytes()
		if len(tail) > 128 {
			tail = tail[len(tail)-128:]
		}
		if bytes.Contains(tail, markerOK) {
			return response.String(), nil
		}
		if bytes.Contains(tail, markerNO) || bytes.Contains(tail, markerBAD) {
			return "", fmt.Errorf("IMAP error: %s", strings.TrimSpace(response.String()))
		}
	}
	return response.String(), nil
}

// parseUIDValidity extracts the UIDVALIDITY value from an IMAP SELECT response.
// RFC 3501 §7.1: server MUST include "* OK [UIDVALIDITY <n>]" in SELECT.
// Returns 0 if absent or unparseable (broken server — caller logs a warning).
func parseUIDValidity(selectResponse string) int64 {
	const marker = "UIDVALIDITY"
	for _, line := range strings.Split(selectResponse, "\n") {
		upper := strings.ToUpper(line)
		idx := strings.Index(upper, marker)
		if idx < 0 {
			continue
		}
		// Rest of the line after "UIDVALIDITY"
		rest := strings.TrimSpace(line[idx+len(marker):])
		rest = strings.TrimLeft(rest, " \t]")
		// Take first run of decimal digits.
		end := len(rest)
		for i, c := range rest {
			if c < '0' || c > '9' {
				end = i
				break
			}
		}
		rest = rest[:end]
		if rest == "" {
			continue
		}
		n, err := strconv.ParseInt(rest, 10, 64)
		if err == nil && n > 0 {
			return n
		}
	}
	return 0
}

// ErrIMAPSOCKSUnavailable is returned by connect() when no SOCKS5 endpoint can
// be resolved for the mailbox and the operator has not explicitly opted into
// direct dialling via ALLOW_IMAP_DIRECT=1.
//
// HARD RULE (memory feedback_no_direct_smtp): production IMAP MUST traverse
// the anti-trace-relay SOCKS5 layer. A silent direct fallback exposes the
// Railway orchestrator egress IP in mailbox login telemetry — exactly the
// multi-country pattern that triggered the nowak.gorak fraud lock (issue
// #1179, AW7-2). Returning this sentinel makes the failure visible in
// runWithReconnect's backoff log so operators can spot misconfiguration
// instead of silently leaking IPs.
var ErrIMAPSOCKSUnavailable = errors.New("imap: SOCKS5 endpoint unavailable (HARD RULE: no direct dial)")

// connect establishes a TCP (or TLS) connection to the IMAP server, reads the
// greeting, and returns the raw net.Conn. It is a package-level function so
// tests can substitute a fake dialer via runWithReconnect.
//
// AW7-2 (2026-05-09): direct fallback REMOVED. When no SOCKS5 endpoint can be
// resolved for the mailbox connect returns ErrIMAPSOCKSUnavailable instead of
// silently dialling from the orchestrator's native IP (issue #1179). The only
// escape hatch is ALLOW_IMAP_DIRECT=1, intended for local development against
// docker-compose IMAP fixtures (never set in production).
//
// AO2 (2026-05-07): dial is routed through a country-pinned SOCKS5 endpoint
// resolved by resolveImapSOCKSAddr. Resolution order:
//  1. IMAP_SOCKS_CZ / IMAP_SOCKS_SK / IMAP_SOCKS_DEFAULT env (operator pin).
//  2. Relay discovery via ANTI_TRACE_RELAY_URL/v1/imap-socks-addr — mirrors
//     BFF dialIMAPViaSOCKS5 so orchestrator + BFF use the same wgpool egress.
//
// F4-2 (2026-04-29): the TLS branch used tls.DialWithDialer, which respects
// only dialer.Timeout (10s) and does NOT honor ctx for cancellation. A slow
// TLS handshake to e.g. Seznam :993 hangs up to 10s regardless of
// ctx.Done(). Fix: dial TCP via DialContext(ctx), then wrap with tls.Client
// and call HandshakeContext(ctx) — both layers now honor cancellation.
func connect(ctx context.Context, mb config.MailboxConfig) (net.Conn, error) {
	addr := fmt.Sprintf("%s:%d", mb.IMAPHost, mb.IMAPPort)
	baseDialer := &net.Dialer{Timeout: 10 * time.Second}

	// Resolve SOCKS5 endpoint. Resolution order:
	//   1. Operator pin via IMAP_SOCKS_CZ / IMAP_SOCKS_SK / IMAP_SOCKS_DEFAULT
	//      (forces a specific endpoint — e.g. dev override or co-located default).
	//   2. Relay discovery via ANTI_TRACE_RELAY_URL — production path that
	//      resolves to the wgpool endpoint exposed by the relay service.
	//
	// If both miss, dialTCP refuses to dial direct (HARD RULE — see below).
	// Relay decommission: ALLOW_IMAP_DIRECT=1 forces a true direct dial and
	// skips SOCKS5 resolution entirely. Without this short-circuit, CZ/SK
	// mailboxes get a hardcoded 127.0.0.1:108x default from resolveImapSOCKSAddr
	// (the relay's in-container wgsocks port) — which no longer exists once the
	// relay is gone, so the dial would fail against a dead local port instead of
	// going direct.
	allowDirect := envconfig.GetOr("ALLOW_IMAP_DIRECT", "") == "1"
	var socksAddr string
	if !allowDirect {
		socksAddr = resolveImapSOCKSAddr(mb.PreferredCountry)
		if socksAddr == "" {
			socksAddr = discoverImapSOCKSAddrFromRelay(ctx, mb.PreferredCountry)
		}
	}

	// dialTCP wraps baseDialer in SOCKS5 when an endpoint is available.
	// HARD RULE: when no SOCKS5 endpoint is available, fail loud — no
	// silent fallback to orchestrator native IP.
	dialTCP := func(ctx context.Context, network, address string) (net.Conn, error) {
		if socksAddr == "" {
			if !allowDirect {
				slog.Error("imap_no_socks5_refusing_direct",
					"op", "imap.connect/noSocksFailFast",
					"mailbox", mb.Address,
					"preferred_country", mb.PreferredCountry,
					"hint", "set ANTI_TRACE_RELAY_URL or IMAP_SOCKS_DEFAULT; ALLOW_IMAP_DIRECT=1 only for local dev",
				)
				return nil, fmt.Errorf("%w: mailbox=%s country=%s", ErrIMAPSOCKSUnavailable, mb.Address, mb.PreferredCountry)
			}
			// Operator explicitly opted into direct dial (local dev/test).
			// Still emit warn so the unshielded path is visible in logs.
			slog.Warn("imap_dial_direct_allow_imap_direct_set",
				"op", "imap.connect/allowDirect",
				"mailbox", mb.Address,
				"preferred_country", mb.PreferredCountry,
			)
			return baseDialer.DialContext(ctx, network, address)
		}
		socks5, err := proxy.SOCKS5("tcp", socksAddr, nil, baseDialer)
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer init %s: %w", socksAddr, err)
		}
		cd, ok := socks5.(proxy.ContextDialer)
		if !ok {
			return nil, fmt.Errorf("socks5 dialer does not implement ContextDialer")
		}
		return cd.DialContext(ctx, network, address)
	}

	var conn net.Conn
	if mb.IMAPPort == 993 {
		// Step 1: TCP dial (via SOCKS5 or direct) honoring ctx.
		tcpConn, err := dialTCP(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("tls dial tcp %s: %w", addr, err)
		}
		// Step 2: TLS handshake honoring ctx. On handshake error close
		// the underlying TCP conn so we don't leak the FD.
		tlsConn := tls.Client(tcpConn, &tls.Config{ServerName: mb.IMAPHost})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = tcpConn.Close()
			return nil, fmt.Errorf("tls handshake %s: %w", addr, err)
		}
		conn = tlsConn
	} else {
		c, err := dialTCP(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dial %s: %w", addr, err)
		}
		conn = c
	}

	// Read server greeting. F4-2 also surfaces read errors instead of
	// silently swallowing — a failed greeting means the connection is
	// half-broken; better to fail-fast than to LOGIN against it.
	buf := make([]byte, 1024)
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("set greeting deadline: %w", err)
	}
	if _, err := conn.Read(buf); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("read greeting %s: %w", addr, err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("clear deadline: %w", err)
	}

	return conn, nil
}

// resolveImapSOCKSAddr maps a mailbox preferred_country ISO code to a local
// SOCKS5 bridge address. The mapping follows the wgsocks bridge port
// convention established in services/relay:
//
//	CZ pool: 127.0.0.1:1080–:1083  (4 cz-prg Wireguard endpoints)
//	SK pool: 127.0.0.1:1084–:1085  (2 sk-bts Wireguard endpoints)
//
// Operators can override per-country via IMAP_SOCKS_CZ / IMAP_SOCKS_SK, or
// set a catch-all via IMAP_SOCKS_DEFAULT. An empty return means "no SOCKS5
// endpoint available" — the caller falls back to a direct dial and logs a
// warning.
func resolveImapSOCKSAddr(country string) string {
	switch country {
	case "CZ":
		return envconfig.GetOr("IMAP_SOCKS_CZ", "127.0.0.1:1080")
	case "SK":
		return envconfig.GetOr("IMAP_SOCKS_SK", "127.0.0.1:1084")
	default:
		// Unknown / empty country — honour global override, else direct fallback.
		return envconfig.GetOr("IMAP_SOCKS_DEFAULT", "")
	}
}

// discoverImapSOCKSAddrFromRelay queries the anti-trace-relay's
// /v1/imap-socks-addr endpoint to learn which SOCKS5 endpoint to dial for the
// requested preferred country. Mirrors BFF's relayImapSocksAddr (apps/
// outreach-dashboard/src/lib/relayClient.js) so orchestrator + BFF resolve to
// the same wgpool endpoints.
//
// Returns the SOCKS5 address ("127.0.0.1:108x" in wgpool mode, or whatever the
// relay's fallback proxy is in single-endpoint mode). Returns "" on any failure
// — caller is responsible for honouring HARD RULE and refusing the direct dial.
//
// Discovery is best-effort: a 5s timeout is enforced so that a missing /
// flapping relay does not stall the IMAP poll cycle. When relay is unreachable
// we fall back to the operator-pinned env vars (IMAP_SOCKS_*) and then to
// ErrIMAPSOCKSUnavailable.
//
// ANTI_TRACE_RELAY_URL is the same env var the rest of the orchestrator already
// uses (cmd/outreach/main.go), so wiring is zero-config for production.
func discoverImapSOCKSAddrFromRelay(ctx context.Context, preferredCountry string) string {
	relayURL := strings.TrimSpace(envconfig.GetOr("ANTI_TRACE_RELAY_URL", ""))
	if relayURL == "" {
		return ""
	}
	// Build the discovery URL — accept relay URLs with or without trailing slash.
	relayURL = strings.TrimRight(relayURL, "/")
	endpoint := relayURL + "/v1/imap-socks-addr"
	if preferredCountry != "" {
		endpoint += "?preferred_country=" + url.QueryEscape(preferredCountry)
	}

	// Bound the discovery time so a slow relay doesn't stretch poll cycles.
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		slog.Warn("imap_socks_discovery_request_build_failed",
			"op", "imap.discoverImapSOCKSAddrFromRelay/buildReq",
			"error", err)
		return ""
	}
	if token := strings.TrimSpace(envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", "")); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("imap_socks_discovery_transport_failed",
			"op", "imap.discoverImapSOCKSAddrFromRelay/transport",
			"error", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		slog.Warn("imap_socks_discovery_non_200",
			"op", "imap.discoverImapSOCKSAddrFromRelay/status",
			"status", resp.StatusCode)
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		slog.Warn("imap_socks_discovery_read_failed",
			"op", "imap.discoverImapSOCKSAddrFromRelay/read",
			"error", err)
		return ""
	}
	var payload struct {
		SocksAddr string `json:"socks_addr"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		slog.Warn("imap_socks_discovery_unmarshal_failed",
			"op", "imap.discoverImapSOCKSAddrFromRelay/unmarshal",
			"error", err)
		return ""
	}
	return strings.TrimSpace(payload.SocksAddr)
}

func command(conn net.Conn, cmd string) error {
	tag := "A001"
	line := fmt.Sprintf("%s %s\r\n", tag, cmd)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(line)); err != nil {
		return fmt.Errorf("write command: %w", err)
	}

	// Read response until we get the tagged response
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	resp := string(buf[:n])

	if strings.Contains(resp, tag+" NO") || strings.Contains(resp, tag+" BAD") {
		return fmt.Errorf("IMAP error: %s", strings.TrimSpace(resp))
	}

	return nil
}

func commandResponse(conn net.Conn, cmd string) (string, error) {
	tag := "A002"
	line := fmt.Sprintf("%s %s\r\n", tag, cmd)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(line)); err != nil {
		return "", fmt.Errorf("write command: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	// Tail-scan for completion markers: avoids O(n²) re-stringifying on each
	// chunk. Markers are short (tag+" OK/NO/BAD"), so scanning the last ~128
	// bytes of the buffer is sufficient once we've written at least that much.
	var response bytes.Buffer
	buf := make([]byte, 8192)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return response.String(), fmt.Errorf("read response: %w", err)
		}
		response.Write(buf[:n])
		tail := response.Bytes()
		if len(tail) > 128 {
			tail = tail[len(tail)-128:]
		}
		if bytes.Contains(tail, markerOK) || bytes.Contains(tail, markerNO) || bytes.Contains(tail, markerBAD) {
			break
		}
	}

	return response.String(), nil
}

// maxMailSizeBytes returns the per-message size cap for IMAP fetches. Beyond
// this limit fetchMessage drops the response with a warn log so a single
// 100MB attachment can't OOM the poller. Override with MAIL_MAX_SIZE_BYTES.
func maxMailSizeBytes() int {
	if v := envconfig.GetOr("MAIL_MAX_SIZE_BYTES", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 25 * 1024 * 1024
}

func fetchMessage(conn net.Conn, uid string) (*thread.RawInbound, error) {
	tag := "A003"
	// BODY.PEEK[] fetches full RFC822 (incl. all MIME parts) without setting
	// \Seen. Required by mail-client-fidelity S1.2 — the MIME parser (S1.3)
	// consumes the raw bytes from RawInbound.RawBytes downstream.
	cmd := fmt.Sprintf("%s FETCH %s (BODY.PEEK[])\r\n", tag, uid)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("write fetch: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	// Tail-scan: 200KB message bodies make O(n²) re-stringify murderous.
	var response bytes.Buffer
	buf := make([]byte, 32768)
	markerOK := []byte(tag + " OK")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			break
		}
		response.Write(buf[:n])
		tail := response.Bytes()
		if len(tail) > 128 {
			tail = tail[len(tail)-128:]
		}
		if bytes.Contains(tail, markerOK) {
			break
		}
	}

	raw := response.String()

	// ── Parse headers and body via net/mail ──
	// Extract just the header block from the IMAP FETCH response so net/mail
	// can parse it cleanly. The response contains interleaved IMAP framing; we
	// pull the header section by finding the first double-CRLF boundary.
	msg := parseFetchResponse(raw)
	return msg, nil
}

// fetchMessageByUID fetches a single message by its IMAP UID using UID FETCH
// (RFC 3501 §6.4.8). Unlike SEQ FETCH, UID FETCH addresses messages by their
// persistent identifier so the result is stable even if another client
// concurrently expunges messages from the mailbox (fixes #878).
//
// The UID item is included in the FETCH request so the server echoes it back
// in the response, confirming we received the correct message.
func fetchMessageByUID(conn net.Conn, uid string) (*thread.RawInbound, error) {
	tag := "A003"
	// "UID FETCH <uid> (UID BODY.PEEK[])" — UID prefix selects by UID,
	// UID in item list makes the server echo the UID in the response.
	cmd := fmt.Sprintf("%s UID FETCH %s (UID BODY.PEEK[])\r\n", tag, uid)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("write uid fetch: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	// Tail-scan: 200KB message bodies make O(n²) re-stringify murderous.
	var response bytes.Buffer
	buf := make([]byte, 32768)
	markerOK := []byte(tag + " OK")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			break
		}
		response.Write(buf[:n])
		tail := response.Bytes()
		if len(tail) > 128 {
			tail = tail[len(tail)-128:]
		}
		if bytes.Contains(tail, markerOK) {
			break
		}
	}

	raw := response.String()
	msg := parseFetchResponse(raw)
	// body_len=0 diagnostic (RCA 2026-06-01: some fetched replies arrive with an
	// empty body, so there is nothing to mine). PII-SAFE: logs only lengths +
	// booleans, never header/body content. Gated behind DEBUG_IMAP_BODY=1 so it
	// is silent in normal operation — flip it on to capture which stage drops the
	// body (read truncated? no BODY[] marker? literal parsed but body empty?).
	if msg != nil && msg.MessageID != "" && msg.BodyPlain == "" &&
		envconfig.GetOr("DEBUG_IMAP_BODY", "") == "1" {
		slog.Warn("imap: fetched message has empty body — structural diagnostic",
			"op", "imap.fetchMessageByUID/emptyBody",
			"uid", uid,
			"raw_len", len(raw),
			"has_body_marker", strings.Contains(raw, "BODY[]"),
			"raw_bytes_len", len(msg.RawBytes),
			"has_double_crlf", strings.Contains(raw, "\r\n\r\n"),
		)
	}
	return msg, nil
}

// parseFetchResponse converts a raw IMAP FETCH response into a RawInbound.
//
// Two literal patterns are supported:
//   - Full RFC822 via BODY[] (mail-client-fidelity S1.2). Headers are parsed
//     by net/mail; the entire literal is preserved in RawInbound.RawBytes for
//     the downstream MIME parser (S1.3).
//   - Legacy split BODY[HEADER.FIELDS] + BODY[TEXT]. Kept as fallback so any
//     test or transitional path still parses; remove once S1.4 ships.
//
// Drops messages exceeding maxMailSizeBytes() to bound peak memory use —
// returns nil so the caller can advance the UID watermark and skip the giant
// blob (real-world dumps with malformed FETCH literals or 50MB attachments
// must not OOM the poller).
func parseFetchResponse(raw string) *thread.RawInbound {
	result := &thread.RawInbound{
		ReceivedAt: time.Now(),
	}

	// Prefer the full-RFC822 path. extractIMAPLiteral matches the longest
	// marker prefix that resolves first, so we check BODY[] before any other
	// candidate. Note: "BODY[" matches both BODY[] and BODY[TEXT]; we anchor
	// on a closing-bracket-immediately-after-bracket to avoid that.
	fullBytes := extractFullBodyLiteral(raw)
	if len(fullBytes) > maxMailSizeBytes() {
		slog.Warn("imap: oversized message, skipping",
			"op", "imap.parseFetchResponse/oversize",
			"size_bytes", len(fullBytes),
			"limit_bytes", maxMailSizeBytes())
		return nil
	}

	if len(fullBytes) > 0 {
		result.RawBytes = fullBytes
		// Parse headers + plain body from the full RFC822 source. net/mail
		// handles header decoding; body extraction here intentionally does
		// not descend into multipart — that is the MIME parser's job (S1.3).
		// We keep BodyPlain for back-compat until S1.4 wires the parser.
		if m, err := mail.ReadMessage(bytes.NewReader(fullBytes)); err == nil {
			fillHeadersFromMail(result, m)
			if b, err := io.ReadAll(m.Body); err == nil {
				body := strings.TrimSpace(string(b))
				if len(body) > 2000 {
					body = body[:2000]
				}
				result.BodyPlain = body
			}
		}
		return result
	}

	// ── Legacy two-literal fallback ──
	headerBlock := extractIMAPLiteral(raw, "BODY[HEADER.FIELDS")
	bodyText := extractIMAPLiteral(raw, "BODY[TEXT]")

	if headerBlock == "" && bodyText == "" {
		headerBlock, bodyText = splitByDoubleCRLF(raw)
	}

	if headerBlock != "" {
		mailInput := headerBlock + "\r\n\r\n"
		if m, err := mail.ReadMessage(strings.NewReader(mailInput)); err == nil {
			fillHeadersFromMail(result, m)
		} else {
			result.MessageID = extractHeader(headerBlock, "Message-ID")
			result.InReplyTo = extractHeader(headerBlock, "In-Reply-To")
			result.References = extractHeader(headerBlock, "References")
			result.From = extractHeader(headerBlock, "From")
			result.Subject = decodeSubjectRFC2047(extractHeader(headerBlock, "Subject"))
			parseDateFallback(result, extractHeader(headerBlock, "Date"))
		}
	}

	if bodyText != "" {
		result.BodyPlain = strings.TrimSpace(bodyText)
		if len(result.BodyPlain) > 2000 {
			result.BodyPlain = result.BodyPlain[:2000]
		}
	}

	return result
}

// fillHeadersFromMail sets MessageID/InReplyTo/References/From/Subject/ReceivedAt
// on result from a parsed *mail.Message. Common to both fetch paths so the
// header-extraction logic stays in one place.
//
// G3.3 (2026-05-29): Subject is decoded through decodeSubjectRFC2047 so that
// MIME-encoded headers (=?utf-8?Q?Re:_Popt=C3=A1vka?= or Base64 variant) are
// stored as readable text. Fallback to raw on error — never lossy.
func fillHeadersFromMail(result *thread.RawInbound, m *mail.Message) {
	result.MessageID = strings.TrimSpace(m.Header.Get("Message-Id"))
	if result.MessageID == "" {
		result.MessageID = strings.TrimSpace(m.Header.Get("Message-ID"))
	}
	result.InReplyTo = strings.TrimSpace(m.Header.Get("In-Reply-To"))
	result.References = strings.TrimSpace(m.Header.Get("References"))
	result.From = strings.TrimSpace(m.Header.Get("From"))
	result.Subject = decodeSubjectRFC2047(strings.TrimSpace(m.Header.Get("Subject")))

	if t, err := mail.ParseDate(strings.TrimSpace(m.Header.Get("Date"))); err == nil {
		result.ReceivedAt = t
	}
}

// decodeSubjectRFC2047 decodes MIME RFC 2047 encoded-word sequences in an
// email Subject header (=?utf-8?Q?...?= and =?utf-8?B?...?= forms).
// Also handles non-UTF-8 charsets (e.g. iso-8859-2, windows-1250) via the
// golang.org/x/net/html/charset reader so Czech diacritics survive.
// Already-plain subjects are returned unchanged. On decode error the raw
// value is returned so no subject is silently lost.
func decodeSubjectRFC2047(raw string) string {
	if raw == "" {
		return raw
	}
	dec := &mime.WordDecoder{
		CharsetReader: charset.NewReaderLabel,
	}
	decoded, err := dec.DecodeHeader(raw)
	if err != nil {
		// Warn but fall through — store raw rather than drop the subject.
		slog.Warn("imap: subject RFC2047 decode failed, storing raw",
			"op", "imap.decodeSubjectRFC2047/decodeFail",
			"error", err,
		)
		return raw
	}
	return decoded
}

// extractFullBodyLiteral finds a `BODY[]` marker and returns the literal
// bytes that follow. It rejects `BODY[TEXT]` / `BODY[HEADER.FIELDS]` etc by
// requiring the bracket to close immediately.
func extractFullBodyLiteral(raw string) []byte {
	marker := "BODY[]"
	idx := strings.Index(raw, marker)
	if idx < 0 {
		return nil
	}
	// Reuse extractIMAPLiteral's literal-count logic by feeding it the marker.
	s := extractIMAPLiteral(raw, marker)
	if s == "" {
		return nil
	}
	return []byte(s)
}

// extractIMAPLiteral finds a section marker (e.g. "BODY[TEXT]") in raw, reads
// its IMAP literal byte count {N}, and returns the N bytes that follow.
// The search for {N} is anchored to the same line as the marker to avoid
// matching stray braces in header values or URLs.
func extractIMAPLiteral(raw, marker string) string {
	idx := strings.Index(raw, marker)
	if idx < 0 {
		return ""
	}
	// Scan only the remainder of the marker's line for {N}.
	rest := raw[idx:]
	lineEnd := strings.Index(rest, "\r\n")
	if lineEnd < 0 {
		lineEnd = strings.Index(rest, "\n")
	}
	if lineEnd < 0 {
		lineEnd = len(rest)
	}
	markerLine := rest[:lineEnd]

	braceStart := strings.Index(markerLine, "{")
	if braceStart < 0 {
		return ""
	}
	closingOffset := strings.Index(markerLine[braceStart:], "}")
	if closingOffset < 0 {
		return ""
	}
	countStr := markerLine[braceStart+1 : braceStart+closingOffset]
	count, err := strconv.Atoi(countStr)
	if err != nil || count < 0 {
		return ""
	}
	if count == 0 {
		return ""
	}
	// Literal data starts after "}\r\n"
	dataStart := braceStart + closingOffset + 1
	if dataStart+2 <= len(rest) && rest[dataStart:dataStart+2] == "\r\n" {
		dataStart += 2
	} else if dataStart+1 <= len(rest) && rest[dataStart:dataStart+1] == "\n" {
		dataStart += 1
	}
	if dataStart+count > len(rest) {
		return rest[dataStart:]
	}
	return rest[dataStart : dataStart+count]
}

// splitByDoubleCRLF is the legacy fallback: splits on the first double-CRLF
// to separate headers from body (works when servers deliver headers first).
func splitByDoubleCRLF(raw string) (headerBlock, bodySection string) {
	sep := "\r\n\r\n"
	headerEnd := strings.Index(raw, sep)
	if headerEnd < 0 {
		sep = "\n\n"
		headerEnd = strings.Index(raw, sep)
	}
	if headerEnd < 0 {
		return "", ""
	}
	headerStart := findHeaderStart(raw[:headerEnd])
	return raw[headerStart:headerEnd], raw[headerEnd+len(sep):]
}

// findHeaderStart skips IMAP framing lines to find where the RFC 2822 headers begin.
func findHeaderStart(s string) int {
	for _, line := range strings.SplitAfter(s, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		// IMAP untagged responses begin with '*', tagged with 'A0xx'
		if strings.HasPrefix(trimmed, "*") || strings.HasPrefix(trimmed, "A0") {
			continue
		}
		// This looks like a real header line
		idx := strings.Index(s, line)
		if idx >= 0 {
			return idx
		}
	}
	return 0
}

// extractMailBody uses net/mail to read the body from a raw message section.
func extractMailBody(raw string) (string, error) {
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("parse mail body: %w", err)
	}
	b, err := io.ReadAll(m.Body)
	if err != nil {
		return "", fmt.Errorf("read mail body: %w", err)
	}
	body := strings.TrimSpace(string(b))
	if len(body) > 2000 {
		body = body[:2000]
	}
	return body, nil
}

// parseDateFallback tries multiple date layouts on dateStr and sets ReceivedAt.
func parseDateFallback(msg *thread.RawInbound, dateStr string) {
	if dateStr == "" {
		return
	}
	for _, layout := range []string{
		"Mon, 02 Jan 2006 15:04:05 -0700",
		"Mon, 2 Jan 2006 15:04:05 -0700",
		"02 Jan 2006 15:04:05 -0700",
		time.RFC1123Z,
	} {
		if t, err := time.Parse(layout, dateStr); err == nil {
			msg.ReceivedAt = t
			return
		}
	}
}

// ── Parsing helpers ──

func parseSearchResponse(response string) []string {
	var uids []string
	for _, line := range strings.Split(response, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "* SEARCH") {
			parts := strings.Fields(line)
			if len(parts) > 2 {
				uids = append(uids, parts[2:]...)
			}
		}
	}
	return uids
}

func extractHeader(raw, name string) string {
	lower := strings.ToLower(raw)
	prefix := strings.ToLower(name) + ":"
	idx := strings.Index(lower, prefix)
	if idx < 0 {
		return ""
	}
	rest := raw[idx+len(prefix):]
	end := strings.IndexAny(rest, "\r\n")
	if end < 0 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:end])
}

func extractBody(raw string) string {
	// IMAP BODY[TEXT] is between the header fetch and the closing tag
	// Look for double CRLF (end of headers) or BODY[TEXT] marker
	markers := []string{"\r\n\r\n", "\n\n"}
	for _, m := range markers {
		idx := strings.LastIndex(raw, m)
		if idx > 0 {
			body := raw[idx+len(m):]
			// Trim IMAP fetch suffix
			if closeIdx := strings.LastIndex(body, ")"); closeIdx > 0 {
				body = body[:closeIdx]
			}
			body = strings.TrimSpace(body)
			if len(body) > 2000 {
				body = body[:2000]
			}
			return body
		}
	}
	return ""
}
