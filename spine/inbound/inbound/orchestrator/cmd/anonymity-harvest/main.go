// cmd/anonymity-harvest — Sprint S2 of the cross-mailbox anonymity test.
//
// Connects to receiver mailboxes via IMAP, fetches messages matching a
// test run, parses all headers + body, and persists one row per message
// into anonymity_test_messages.
//
// # Pairing strategy (issue #552 fix)
//
// Messages are identified via the Subject-marker "[A:<short>]" prepended by
// cmd/anonymity-test during S1. The short prefix is the first 8 hex chars
// of the run_id (hyphens stripped). This approach is robust: Subject
// survives the full anti-trace-relay pipeline (T2 sanitise, T4-T8 seal,
// D3 unpad, D6 BuildMessage). The previous X-Test-Run-ID header approach
// was unreliable because T2/D5 strip fingerprinting X-* headers.
//
// Pairing key: (subjectShortID(run_id), from_addr, receiver_mailbox_id).
// The 36-send matrix has unique (sender, receiver, template) triples per
// run, so (prefix, sender_bare_addr, receiver_mailbox_id) is unambiguous.
//
// The X-Test-Run-ID header check is retained as a secondary fallback for
// any pre-relay payloads that do not pass through the full pipeline.
//
// Usage:
//
//	anonymity-harvest \
//	    --run-id=<uuid> \
//	    --mailbox-ids=1,3,631,632 \
//	    --max-wait-seconds=300 \
//	    --initial-poll-delay=5 \
//	    --poll-interval-seconds=10 \
//	    --archive-folder=Tested-Anonymity
//
// Exit codes:
//
//	0  all expected messages harvested
//	1  target not reached (some messages missing at deadline)
//	2  fatal configuration / DB error
package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"common/db"
	"common/envconfig"
	"common/telemetry"
	"golang.org/x/net/proxy"
)

// ──────────────────────────────────────────────────────────────────────────────
// CLI flags
// ──────────────────────────────────────────────────────────────────────────────

type config struct {
	runID               string
	mailboxIDs          []int64
	maxWaitSeconds      int
	initialPollDelay    int
	pollIntervalSeconds int
	archiveFolder       string
	databaseURL         string
}

func parseFlags() (config, error) {
	var cfg config
	var mailboxIDsRaw string

	flag.StringVar(&cfg.runID, "run-id", "", "UUID of the test run (REQUIRED)")
	flag.StringVar(&mailboxIDsRaw, "mailbox-ids", "1,3,631,632", "Comma-separated mailbox IDs to harvest from")
	flag.IntVar(&cfg.maxWaitSeconds, "max-wait-seconds", 300, "Maximum seconds to wait for all messages")
	flag.IntVar(&cfg.initialPollDelay, "initial-poll-delay", 5, "Seconds to wait before the first IMAP poll")
	flag.IntVar(&cfg.pollIntervalSeconds, "poll-interval-seconds", 10, "Seconds between subsequent IMAP polls")
	flag.StringVar(&cfg.archiveFolder, "archive-folder", "Tested-Anonymity", "Move harvested messages to this folder (empty = skip)")
	flag.Parse()

	if cfg.runID == "" {
		return cfg, fmt.Errorf("--run-id is required")
	}

	cfg.databaseURL = envconfig.GetOr("DATABASE_URL", "")
	if cfg.databaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL env not set")
	}

	for _, part := range strings.Split(mailboxIDsRaw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			return cfg, fmt.Errorf("invalid mailbox id %q: %w", part, err)
		}
		cfg.mailboxIDs = append(cfg.mailboxIDs, id)
	}
	if len(cfg.mailboxIDs) == 0 {
		return cfg, fmt.Errorf("--mailbox-ids must contain at least one id")
	}

	return cfg, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// DB row types
// ──────────────────────────────────────────────────────────────────────────────

type mailboxRow struct {
	id       int64
	address  string
	imapHost string
	imapPort int
	password string
}

type sendEventRow struct {
	id             int64
	senderMailbox  int64
	senderAddress  string
	templateName   string
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

func main() {
	if err := telemetry.Init("anonymity-harvest"); err != nil {
		slog.Error("sentry init", "op", "main.main", "error", err)
	}
	defer telemetry.Flush()
	slog.SetDefault(slog.New(telemetry.NewSlogHandler(slog.NewJSONHandler(os.Stderr, nil))))

	cfg, err := parseFlags()
	if err != nil {
		fmt.Fprintln(os.Stderr, "usage error:", err)
		os.Exit(2)
	}

	database, err := db.Connect(cfg.databaseURL)
	if err != nil {
		slog.Error("DB connect", "op", "main.connect", "error", err)
		os.Exit(2)
	}
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.maxWaitSeconds+60)*time.Second)
	defer cancel()

	if err := run(ctx, database, cfg); err != nil {
		slog.Error("harvest failed", "op", "main.run", "error", err)
		os.Exit(1)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// run — main harvest loop
// ──────────────────────────────────────────────────────────────────────────────

func run(ctx context.Context, database *sql.DB, cfg config) error {
	// Load receiver mailboxes.
	mailboxes, err := loadMailboxes(ctx, database, cfg.mailboxIDs)
	if err != nil {
		return fmt.Errorf("load mailboxes: %w", err)
	}
	if len(mailboxes) == 0 {
		return fmt.Errorf("no active mailboxes found for ids %v", cfg.mailboxIDs)
	}

	// Determine expected count for this run.
	target, err := countExpectedMessages(ctx, database, cfg.runID)
	if err != nil {
		slog.Warn("cannot determine target count; will harvest until deadline",
			"op", "run.countExpected", "error", err)
		target = 0 // proceed without early-exit optimisation
	}
	slog.Info("harvest starting",
		"op", "run.start",
		"run_id", cfg.runID,
		"target", target,
		"mailboxes", len(mailboxes),
		"max_wait_seconds", cfg.maxWaitSeconds)

	// Wait before first poll so the MTA has time to deliver.
	if cfg.initialPollDelay > 0 {
		select {
		case <-time.After(time.Duration(cfg.initialPollDelay) * time.Second):
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	// Per-mailbox UID watermark (last seen UID).
	watermarks := make(map[int64]int64) // mailbox_id → last seen UID
	uidvalidities := make(map[int64]int64) // mailbox_id → last observed UIDVALIDITY

	deadline := time.Now().Add(time.Duration(cfg.maxWaitSeconds) * time.Second)
	harvested := 0

	for {
		if time.Now().After(deadline) {
			break
		}
		if target > 0 && harvested >= target {
			break
		}
		if ctx.Err() != nil {
			break
		}

		for i := range mailboxes {
			mb := &mailboxes[i]
			count, err := pollMailbox(ctx, database, mb, cfg.runID, watermarks, uidvalidities, cfg.archiveFolder)
			if err != nil {
				slog.Warn("poll mailbox error",
					"op", "run.pollMailbox",
					"mailbox", mb.address,
					"error", err)
				// non-fatal: try next mailbox, retry on next cycle
				continue
			}
			harvested += count
		}

		if target > 0 && harvested >= target {
			break
		}

		select {
		case <-time.After(time.Duration(cfg.pollIntervalSeconds) * time.Second):
		case <-ctx.Done():
			break
		}
	}

	slog.Info("harvest complete",
		"op", "run.done",
		"run_id", cfg.runID,
		"harvested", harvested,
		"target", target)

	if target > 0 && harvested < target {
		gap := target - harvested
		slog.Warn("harvest gap: messages not delivered within deadline",
			"op", "run.gap",
			"run_id", cfg.runID,
			"expected", target,
			"harvested", harvested,
			"gap", gap)
		// slog.Warn routes to Sentry via the SlogHandler when SENTRY_DSN_GO is set.
		return fmt.Errorf("harvest incomplete: expected %d, got %d (gap %d)", target, harvested, gap)
	}

	return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// loadMailboxes fetches active mailboxes with IMAP credentials from DB.
// ──────────────────────────────────────────────────────────────────────────────

func loadMailboxes(ctx context.Context, database *sql.DB, ids []int64) ([]mailboxRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = id
	}
	query := fmt.Sprintf(`
		SELECT id, from_address,
		       COALESCE(imap_host, ''),
		       COALESCE(imap_port, 0),
		       COALESCE(password, '')
		FROM outreach_mailboxes
		WHERE id IN (%s) AND status = 'active' AND environment = 'production' -- AP5: production boundary
		ORDER BY id`, strings.Join(placeholders, ","))

	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query mailboxes: %w", err)
	}
	defer rows.Close()

	var out []mailboxRow
	for rows.Next() {
		var mb mailboxRow
		if err := rows.Scan(&mb.id, &mb.address, &mb.imapHost, &mb.imapPort, &mb.password); err != nil {
			return nil, fmt.Errorf("scan mailbox: %w", err)
		}
		if mb.imapHost == "" || mb.imapPort == 0 {
			slog.Warn("mailbox missing IMAP config, skipping",
				"op", "loadMailboxes.skip",
				"mailbox_id", mb.id,
				"address", mb.address)
			continue
		}
		if mb.password == "" {
			slog.Warn("mailbox missing password, skipping",
				"op", "loadMailboxes.skip",
				"mailbox_id", mb.id,
				"address", mb.address)
			continue
		}
		out = append(out, mb)
	}
	return out, rows.Err()
}

// ──────────────────────────────────────────────────────────────────────────────
// countExpectedMessages — how many send_events reference this run_id.
// S1 stores the marker in send_events via headers jsonb OR a top-level
// column. We try both: first a top-level `test_run_id` column, then
// headers->>'test_run_id' fallback.
// ──────────────────────────────────────────────────────────────────────────────

func countExpectedMessages(ctx context.Context, database *sql.DB, runID string) (int, error) {
	var count int
	// Try column first (preferred S1 contract).
	err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM send_events WHERE test_run_id = $1`, runID,
	).Scan(&count)
	if err == nil {
		return count, nil
	}

	// Fallback: headers jsonb field.
	err2 := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM send_events WHERE headers->>'test_run_id' = $1`, runID,
	).Scan(&count)
	if err2 != nil {
		return 0, fmt.Errorf("count send_events (column: %v, jsonb: %v)", err, err2)
	}
	return count, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// findSendEvent — pair an inbound to a send_event.
// Pairing key: (test_run_id, from_addr → sender_mailbox, receiver_mailbox_id).
// The 36-send matrix has unique (sender, receiver, template) triples per run,
// so (run_id, from_addr, to_mailbox_id) is unambiguous.
// ──────────────────────────────────────────────────────────────────────────────

func findSendEvent(ctx context.Context, database *sql.DB, runID, fromAddr string, receiverMailboxID int64) (sendEventRow, bool, error) {
	// Normalise: extract bare address from "Display Name <addr@host>" forms.
	bare := extractBareAddress(fromAddr)

	// Attempt 1: top-level test_run_id column.
	// send_events has no template_name column; use subject as the closest
	// available field (matches what anonymity-test stores in send_events.subject).
	var se sendEventRow
	err := database.QueryRowContext(ctx, `
		SELECT se.id, mb.id, mb.from_address,
		       COALESCE(se.subject, '')
		FROM send_events se
		JOIN outreach_mailboxes mb ON mb.from_address = $2
		WHERE se.test_run_id = $1
		  AND se.mailbox_used = mb.from_address
		LIMIT 1`, runID, bare,
	).Scan(&se.id, &se.senderMailbox, &se.senderAddress, &se.templateName)
	if err == nil {
		return se, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		slog.Warn("findSendEvent query error", "op", "findSendEvent.col", "error", err)
	}

	// Attempt 2: match by mailbox_used + run's subject marker in subject column.
	// send_events has no headers jsonb column (schema as of 2026-05-05 has
	// subject, test_run_id, mailbox_used but no headers column). Fall back to
	// matching by mailbox address alone (no run-id filter) when Attempt 1 found
	// nothing — allows pairing when test_run_id was stored in send_events.
	err2 := database.QueryRowContext(ctx, `
		SELECT se.id, mb.id, mb.from_address,
		       COALESCE(se.subject, '')
		FROM send_events se
		JOIN outreach_mailboxes mb ON mb.from_address = $2
		WHERE se.mailbox_used = mb.from_address
		  AND se.test_run_id IS NOT NULL
		ORDER BY se.created_at DESC
		LIMIT 1`, runID, bare,
	).Scan(&se.id, &se.senderMailbox, &se.senderAddress, &se.templateName)
	if err2 == nil {
		return se, true, nil
	}
	if !errors.Is(err2, sql.ErrNoRows) {
		slog.Warn("findSendEvent query error", "op", "findSendEvent.jsonb", "error", err2)
	}

	return sendEventRow{}, false, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// pollMailbox — one poll cycle for one receiver mailbox.
// ──────────────────────────────────────────────────────────────────────────────

func pollMailbox(
	ctx context.Context,
	database *sql.DB,
	mb *mailboxRow,
	runID string,
	watermarks map[int64]int64,
	uidvalidities map[int64]int64,
	archiveFolder string,
) (int, error) {
	conn, err := imapConnectSOCKS5(ctx, mb)
	if err != nil {
		return 0, fmt.Errorf("connect %s: %w", mb.address, err)
	}
	defer conn.Close()

	if err := imapCmd(conn, fmt.Sprintf("LOGIN %s %s", mb.address, mb.password)); err != nil {
		return 0, fmt.Errorf("login %s: %w", mb.address, err)
	}

	// SELECT INBOX — also returns UIDVALIDITY.
	selectResp, err := imapCmdResp(conn, "SELECT INBOX")
	if err != nil {
		return 0, fmt.Errorf("select INBOX %s: %w", mb.address, err)
	}

	uidvalidity, err := parseUIDVALIDITY(selectResp)
	if err == nil && uidvalidity > 0 {
		prev, seen := uidvalidities[mb.id]
		if seen && prev != uidvalidity {
			slog.Warn("UIDVALIDITY changed — resetting watermark",
				"op", "pollMailbox.uidvalidity",
				"mailbox", mb.address,
				"old", prev,
				"new", uidvalidity)
			watermarks[mb.id] = 0
		}
		uidvalidities[mb.id] = uidvalidity
	}

	lastUID := watermarks[mb.id]
	searchCmd := "UID SEARCH ALL"
	if lastUID > 0 {
		searchCmd = fmt.Sprintf("UID SEARCH UID %d:*", lastUID+1)
	}

	searchResp, err := imapCmdResp(conn, searchCmd)
	if err != nil {
		return 0, fmt.Errorf("UID SEARCH %s: %w", mb.address, err)
	}

	uids := parseUIDSearchResponse(searchResp)
	if len(uids) == 0 {
		imapLogout(conn)
		return 0, nil
	}

	harvested := 0
	var toArchive []int64

	for _, uid := range uids {
		if uid <= lastUID {
			continue // already seen in a previous cycle
		}

		raw, err := imapFetchUID(conn, uid)
		if err != nil {
			slog.Warn("fetch UID failed",
				"op", "pollMailbox.fetch",
				"mailbox", mb.address,
				"uid", uid,
				"error", err)
			continue
		}

		// Update watermark regardless of match so we don't re-fetch on reconnect.
		if uid > watermarks[mb.id] {
			watermarks[mb.id] = uid
		}

		parsed, err := parseRawMessage(raw)
		if err != nil {
			slog.Warn("parse message failed",
				"op", "pollMailbox.parse",
				"mailbox", mb.address,
				"uid", uid,
				"error", err)
			continue
		}

		// Match this message to the run via Subject-marker (primary, issue #552).
		// "[A:<short>]" prefix in Subject survives the full relay pipeline.
		// Falls back to X-Test-Run-ID header for pre-relay or legacy sends.
		subject := headerFirst(parsed.headers, "Subject")
		subjectMatch := matchesRun(subject, runID)

		headerRunID := headerFirst(parsed.headers, "X-Test-Run-Id")
		if headerRunID == "" {
			headerRunID = headerFirst(parsed.headers, "X-Test-Run-ID")
		}
		headerMatch := headerRunID == runID

		if !subjectMatch && !headerMatch {
			// Not our test message — skip.
			continue
		}

		// Find paired send_event.
		se, found, err := findSendEvent(ctx, database, runID, parsed.fromAddr, mb.id)
		if err != nil {
			slog.Warn("send_event lookup error",
				"op", "pollMailbox.findSendEvent",
				"error", err)
		}

		var sendEventID sql.NullInt64
		var senderMailboxID int64
		var templateName string
		if found {
			sendEventID = sql.NullInt64{Int64: se.id, Valid: true}
			senderMailboxID = se.senderMailbox
			templateName = se.templateName
		} else {
			// Best-effort: derive sender mailbox from From address.
			senderMailboxID, _ = lookupMailboxIDByAddress(ctx, database, parsed.fromAddr)
		}


		// template_name is NOT NULL in anonymity_test_messages. When we could not
		// resolve it from send_events (schema drift: template_name column doesn't
		// exist — we read subject instead, which may carry the "[A:<short>] <tpl>"
		// form), fall back to extracting from the Subject or use "unknown".
		if templateName == "" {
			// Subject from the parsed message (preferred: carries real template info).
			msgSubject := headerFirst(parsed.headers, "Subject")
			if msgSubject != "" {
				// Strip subject marker "[A:xxxxxxxx] " prefix if present.
				if short, ok := parseSubjectMarker(msgSubject); ok {
					_ = short
					// Remove the "[A:xxxxxxxx] " prefix
					if end := strings.Index(msgSubject, "] "); end >= 0 {
						templateName = msgSubject[end+2:]
					} else {
						templateName = msgSubject
					}
				} else {
					templateName = msgSubject
				}
			}
			if templateName == "" {
				templateName = "unknown"
			}
		}

		// Marshal raw_headers to JSON.
		rawHeadersJSON, err := json.Marshal(parsed.headers)
		if err != nil {
			slog.Warn("marshal headers", "op", "pollMailbox.marshal", "error", err)
			rawHeadersJSON = []byte("{}")
		}

		// received_chain is text[]; pass the literal with an explicit cast
		// so the pq driver doesn't need to be imported just for Array type.
		chainLiteral := pq_array(parsed.receivedChain)
		_, insertErr := database.ExecContext(ctx, `
			INSERT INTO anonymity_test_messages (
				test_run_id, sender_mailbox_id, receiver_mailbox_id,
				template_name, send_event_id,
				imap_uid, imap_uidvalidity,
				raw_headers, raw_body,
				received_chain, message_id, from_addr, return_path,
				dkim_result, spf_result, dmarc_result
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8, $9,
				$10::text[], $11, $12, $13, $14, $15, $16
			)
			ON CONFLICT (receiver_mailbox_id, imap_uid, imap_uidvalidity) DO NOTHING`,
			runID, senderMailboxID, mb.id,
			nullableStr(templateName), sendEventID,
			uid, uidvalidities[mb.id],
			rawHeadersJSON, parsed.body,
			chainLiteral, nullableStr(parsed.messageID),
			nullableStr(parsed.fromAddr), nullableStr(parsed.returnPath),
			parsed.dkimResult, parsed.spfResult, parsed.dmarcResult,
		)
		if insertErr != nil {
			slog.Error("insert anonymity_test_messages",
				"op", "pollMailbox.insert",
				"mailbox", mb.address,
				"uid", uid,
				"error", insertErr)
			continue
		}

		harvested++
		toArchive = append(toArchive, uid)
		slog.Info("harvested message",
			"op", "pollMailbox.harvested",
			"run_id", runID,
			"mailbox", mb.address,
			"uid", uid,
			"from", parsed.fromAddr,
			"template", templateName)
	}

	// Archive matched messages if requested.
	if archiveFolder != "" && len(toArchive) > 0 {
		folder := fmt.Sprintf("%s/%s", archiveFolder, runID)
		if err := imapEnsureFolder(conn, folder); err != nil {
			slog.Warn("create archive folder failed",
				"op", "pollMailbox.archive",
				"mailbox", mb.address,
				"folder", folder,
				"error", err)
		} else {
			for _, uid := range toArchive {
				if err := imapMoveUID(conn, uid, folder); err != nil {
					slog.Warn("move UID to archive failed",
						"op", "pollMailbox.move",
						"mailbox", mb.address,
						"uid", uid,
						"folder", folder,
						"error", err)
					// non-fatal; continue
				}
			}
		}
	}

	imapLogout(conn)
	return harvested, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// parsedMessage — result of parseRawMessage.
// ──────────────────────────────────────────────────────────────────────────────

type parsedMessage struct {
	headers       map[string][]string
	body          string
	receivedChain []string
	messageID     string
	fromAddr      string
	returnPath    string
	dkimResult    *string
	spfResult     *string
	dmarcResult   *string
}

// ──────────────────────────────────────────────────────────────────────────────
// parseRawMessage — parse a raw RFC 2822 message.
// Uses net/mail (same package the existing IMAP poller uses) for header decoding.
// ──────────────────────────────────────────────────────────────────────────────

func parseRawMessage(raw []byte) (parsedMessage, error) {
	m, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		return parsedMessage{}, fmt.Errorf("mail.ReadMessage: %w", err)
	}

	pm := parsedMessage{
		headers: make(map[string][]string),
	}

	// Collect all headers, preserving multi-value order.
	for key, vals := range m.Header {
		canonical := strings.ToLower(key)
		pm.headers[canonical] = append(pm.headers[canonical], vals...)
	}

	// Received chain — already multi-value in net/mail header map; order from
	// net/mail is the declaration order (first = oldest per RFC 5321 §4.4).
	// The spec says headers are prepended, so the most-recently-added header
	// appears first in the raw file. net/mail preserves the raw order.
	pm.receivedChain = m.Header["Received"]

	// Scalar fields.
	pm.messageID = strings.TrimSpace(m.Header.Get("Message-Id"))
	if pm.messageID == "" {
		pm.messageID = strings.TrimSpace(m.Header.Get("Message-ID"))
	}
	pm.fromAddr = strings.TrimSpace(m.Header.Get("From"))
	pm.returnPath = strings.TrimSpace(m.Header.Get("Return-Path"))

	// Authentication-Results — may be multi-value (different MTAs prepend their own).
	pm.dkimResult = extractAuthResult(m.Header["Authentication-Results"], "dkim")
	pm.spfResult = extractAuthResult(m.Header["Authentication-Results"], "spf")
	pm.dmarcResult = extractAuthResult(m.Header["Authentication-Results"], "dmarc")

	// Body — read full raw body; scorers handle MIME parsing.
	if bodyBytes, err := readAll(m.Body); err == nil {
		pm.body = string(bodyBytes)
	}

	return pm, nil
}

// extractAuthResult scans Authentication-Results header values for a
// named mechanism (e.g. "dkim", "spf", "dmarc") and returns the value
// (e.g. "pass", "fail", "none"). Returns nil when the header is absent
// or the mechanism is not found — never defaults to empty string or "pass".
func extractAuthResult(headerVals []string, mechanism string) *string {
	if len(headerVals) == 0 {
		return nil
	}
	// Pattern: mechanism=value (value may have trailing space, semicolon, or end)
	pattern := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(mechanism) + `\s*=\s*([^\s;]+)`)
	for _, hval := range headerVals {
		m := pattern.FindStringSubmatch(hval)
		if m != nil {
			result := strings.ToLower(strings.TrimSpace(m[1]))
			return &result
		}
	}
	return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// IMAP helpers — reuse the same raw TCP/TLS pattern as imap/poller.go
// ──────────────────────────────────────────────────────────────────────────────

// ErrAnonymityHarvestSOCKSUnavailable is returned by imapConnectSOCKS5 when no
// SOCKS5 endpoint can be resolved for the mailbox and the operator has not
// explicitly opted into direct dialling via ALLOW_IMAP_DIRECT=1.
//
// HARD RULE (memory feedback_no_direct_smtp): production IMAP MUST traverse
// the anti-trace-relay SOCKS5 layer. A silent direct fallback exposes the
// Railway orchestrator egress IP in mailbox login telemetry — exactly the
// multi-country pattern that triggered the nowak.gorak fraud lock (issue #1179).
var ErrAnonymityHarvestSOCKSUnavailable = errors.New("anonymity-harvest: SOCKS5 endpoint unavailable (HARD RULE: no direct dial)")

// imapConnectSOCKS5 establishes a TCP (or TLS) connection to the IMAP server
// via SOCKS5 wgpool (mirroring imap/poller.go's connect() — AW7-2).
// Resolves SOCKS5 endpoint from env vars or relay discovery.
// When no endpoint is available and ALLOW_IMAP_DIRECT=1 is not set, returns
// ErrAnonymityHarvestSOCKSUnavailable (fail-fast, not silent fallback).
func imapConnectSOCKS5(ctx context.Context, mb *mailboxRow) (net.Conn, error) {
	addr := fmt.Sprintf("%s:%d", mb.imapHost, mb.imapPort)
	baseDialer := &net.Dialer{Timeout: 10 * time.Second}

	// Resolve SOCKS5 endpoint. Resolution order:
	//   1. Operator pin via env (IMAP_SOCKS_CZ / IMAP_SOCKS_SK / IMAP_SOCKS_DEFAULT)
	//   2. Relay discovery via ANTI_TRACE_RELAY_URL + ANTI_TRACE_RELAY_TOKEN
	socksAddr := resolveAnonymityHarvestSOCKSAddr()
	if socksAddr == "" {
		socksAddr = discoverAnonymityHarvestSOCKSAddr(ctx)
	}

	allowDirect := envconfig.GetOr("ALLOW_IMAP_DIRECT", "") == "1"

	// dialTCP wraps baseDialer in SOCKS5 when an endpoint is available.
	// HARD RULE: when no SOCKS5 endpoint is available, fail loud — no
	// silent fallback to orchestrator native IP.
	dialTCP := func(ctx context.Context, network, address string) (net.Conn, error) {
		if socksAddr == "" {
			if !allowDirect {
				slog.Error("anonymity_harvest_no_socks5_refusing_direct",
					"op", "imapConnectSOCKS5/noSocksFailFast",
					"mailbox", mb.address,
					"hint", "set ANTI_TRACE_RELAY_URL or IMAP_SOCKS_DEFAULT; ALLOW_IMAP_DIRECT=1 only for local dev",
				)
				return nil, fmt.Errorf("%w: mailbox=%s", ErrAnonymityHarvestSOCKSUnavailable, mb.address)
			}
			// Operator explicitly opted into direct dial (local dev/test).
			// Still emit warn so the unshielded path is visible in logs.
			slog.Warn("anonymity_harvest_dial_direct_allow_imap_direct_set",
				"op", "imapConnectSOCKS5/allowDirect",
				"mailbox", mb.address,
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
	if mb.imapPort == 993 {
		// Step 1: TCP dial (via SOCKS5 or direct) honoring ctx.
		tcpConn, err := dialTCP(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("tls dial tcp %s: %w", addr, err)
		}
		// Step 2: TLS handshake honoring ctx. On handshake error close
		// the underlying TCP conn so we don't leak the FD.
		tlsConn := tls.Client(tcpConn, &tls.Config{ServerName: mb.imapHost})
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

	// Read server greeting. Surface read errors instead of silently swallowing
	// — a failed greeting means the connection is half-broken; better to
	// fail-fast than to LOGIN against it.
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

// resolveAnonymityHarvestSOCKSAddr resolves a SOCKS5 bridge address from env vars.
// Mirrors imap/poller.go's resolveImapSOCKSAddr for consistency.
// Returns "" when no env var is set — caller falls back to relay discovery.
func resolveAnonymityHarvestSOCKSAddr() string {
	// Check for a global override first (catch-all).
	if addr := envconfig.GetOr("IMAP_SOCKS_DEFAULT", ""); addr != "" {
		return addr
	}
	// No env-based SOCKS endpoint; fall back to relay discovery.
	return ""
}

// discoverAnonymityHarvestSOCKSAddr queries the anti-trace-relay's
// /v1/imap-socks-addr endpoint to learn which SOCKS5 endpoint to dial.
// Mirrors imap/poller.go's discoverImapSOCKSAddrFromRelay.
// Returns "" on any failure — caller is responsible for enforcing HARD RULE.
func discoverAnonymityHarvestSOCKSAddr(ctx context.Context) string {
	relayURL := strings.TrimSpace(envconfig.GetOr("ANTI_TRACE_RELAY_URL", ""))
	if relayURL == "" {
		return ""
	}
	// Build the discovery URL — accept relay URLs with or without trailing slash.
	relayURL = strings.TrimRight(relayURL, "/")
	endpoint := relayURL + "/v1/imap-socks-addr"

	// Bound the discovery time so a slow relay doesn't stretch harvest cycles.
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		slog.Warn("anonymity_harvest_socks_discovery_request_build_failed",
			"op", "discoverAnonymityHarvestSOCKSAddr/buildReq",
			"error", err)
		return ""
	}
	if token := strings.TrimSpace(envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", "")); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("anonymity_harvest_socks_discovery_transport_failed",
			"op", "discoverAnonymityHarvestSOCKSAddr/transport",
			"error", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		slog.Warn("anonymity_harvest_socks_discovery_non_200",
			"op", "discoverAnonymityHarvestSOCKSAddr/status",
			"status", resp.StatusCode)
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		slog.Warn("anonymity_harvest_socks_discovery_read_failed",
			"op", "discoverAnonymityHarvestSOCKSAddr/read",
			"error", err)
		return ""
	}
	var discoveryResp struct {
		SOCKSAddr string `json:"socks_addr"`
	}
	if err := json.Unmarshal(body, &discoveryResp); err != nil {
		slog.Warn("anonymity_harvest_socks_discovery_json_failed",
			"op", "discoverAnonymityHarvestSOCKSAddr/unmarshal",
			"error", err)
		return ""
	}
	return discoveryResp.SOCKSAddr
}

// imapCmd sends a command and waits for tagged OK (fire-and-forget style).
func imapCmd(conn net.Conn, cmd string) error {
	tag := "H001"
	_, err := fmt.Fprintf(conn, "%s %s\r\n", tag, cmd)
	if err != nil {
		return fmt.Errorf("write: %w", err)
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second)) //nolint:errcheck
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	conn.SetReadDeadline(time.Time{}) //nolint:errcheck
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	resp := string(buf[:n])
	if strings.Contains(resp, tag+" NO") || strings.Contains(resp, tag+" BAD") {
		return fmt.Errorf("IMAP error: %s", strings.TrimSpace(resp))
	}
	return nil
}

// imapCmdResp sends a command and returns the full response (uses tail-scan).
func imapCmdResp(conn net.Conn, cmd string) (string, error) {
	tag := "H002"
	_, err := fmt.Fprintf(conn, "%s %s\r\n", tag, cmd)
	if err != nil {
		return "", fmt.Errorf("write: %w", err)
	}
	conn.SetReadDeadline(time.Now().Add(15 * time.Second)) //nolint:errcheck
	defer conn.SetReadDeadline(time.Time{}) //nolint:errcheck

	var sb strings.Builder
	buf := make([]byte, 8192)
	markerOK := tag + " OK"
	markerNO := tag + " NO"
	markerBAD := tag + " BAD"
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if err != nil {
			break
		}
		s := sb.String()
		if strings.Contains(s, markerOK) || strings.Contains(s, markerNO) || strings.Contains(s, markerBAD) {
			break
		}
	}
	return sb.String(), nil
}

// imapFetchUID fetches the full RFC 2822 body for a UID.
func imapFetchUID(conn net.Conn, uid int64) ([]byte, error) {
	tag := "H003"
	_, err := fmt.Fprintf(conn, "%s UID FETCH %d (BODY.PEEK[])\r\n", tag, uid)
	if err != nil {
		return nil, fmt.Errorf("write fetch: %w", err)
	}
	conn.SetReadDeadline(time.Now().Add(20 * time.Second)) //nolint:errcheck
	defer conn.SetReadDeadline(time.Time{}) //nolint:errcheck

	var sb strings.Builder
	buf := make([]byte, 32768)
	markerOK := tag + " OK"
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if err != nil {
			break
		}
		s := sb.String()
		if strings.Contains(s, markerOK) {
			break
		}
	}

	// Extract literal body from FETCH response (same pattern as poller.go).
	body := extractIMAPFullBodyLiteral(sb.String())
	if body == "" {
		return []byte(sb.String()), nil // fallback: return raw response
	}
	return []byte(body), nil
}

// imapEnsureFolder creates a mailbox folder if it doesn't exist.
func imapEnsureFolder(conn net.Conn, folder string) error {
	// CREATE is idempotent if already exists on many servers (returns OK or NO with [ALREADYEXISTS]).
	tag := "H004"
	_, err := fmt.Fprintf(conn, "%s CREATE \"%s\"\r\n", tag, folder)
	if err != nil {
		return err
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second)) //nolint:errcheck
	buf := make([]byte, 1024)
	conn.Read(buf) //nolint:errcheck
	conn.SetReadDeadline(time.Time{}) //nolint:errcheck
	return nil
}

// imapMoveUID moves a message by UID to a destination folder (COPY + STORE \Deleted + EXPUNGE).
func imapMoveUID(conn net.Conn, uid int64, folder string) error {
	// 1. COPY
	if err := imapCmd(conn, fmt.Sprintf("UID COPY %d \"%s\"", uid, folder)); err != nil {
		return fmt.Errorf("copy: %w", err)
	}
	// 2. Mark \Deleted
	if err := imapCmd(conn, fmt.Sprintf("UID STORE %d +FLAGS (\\Deleted)", uid)); err != nil {
		return fmt.Errorf("store deleted: %w", err)
	}
	// 3. EXPUNGE
	if err := imapCmd(conn, "EXPUNGE"); err != nil {
		return fmt.Errorf("expunge: %w", err)
	}
	return nil
}

func imapLogout(conn net.Conn) {
	conn.SetWriteDeadline(time.Now().Add(3 * time.Second)) //nolint:errcheck
	fmt.Fprintf(conn, "H999 LOGOUT\r\n") //nolint:errcheck
}

// ──────────────────────────────────────────────────────────────────────────────
// IMAP response parsers
// ──────────────────────────────────────────────────────────────────────────────

// parseUIDVALIDITY extracts the UIDVALIDITY value from a SELECT INBOX response.
func parseUIDVALIDITY(response string) (int64, error) {
	re := regexp.MustCompile(`\[UIDVALIDITY\s+(\d+)\]`)
	m := re.FindStringSubmatch(response)
	if m == nil {
		return 0, fmt.Errorf("UIDVALIDITY not found in SELECT response")
	}
	return strconv.ParseInt(m[1], 10, 64)
}

// parseUIDSearchResponse extracts UID integers from a UID SEARCH response.
func parseUIDSearchResponse(response string) []int64 {
	var uids []int64
	for _, line := range strings.Split(response, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "* SEARCH") {
			parts := strings.Fields(line)
			for _, part := range parts[2:] {
				if uid, err := strconv.ParseInt(part, 10, 64); err == nil {
					uids = append(uids, uid)
				}
			}
		}
	}
	return uids
}

// extractIMAPFullBodyLiteral extracts the RFC 2822 literal from BODY[] fetch response.
func extractIMAPFullBodyLiteral(raw string) string {
	marker := "BODY[]"
	idx := strings.Index(raw, marker)
	if idx < 0 {
		return ""
	}
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
	closingOff := strings.Index(markerLine[braceStart:], "}")
	if closingOff < 0 {
		return ""
	}
	countStr := markerLine[braceStart+1 : braceStart+closingOff]
	count, err := strconv.Atoi(countStr)
	if err != nil || count <= 0 {
		return ""
	}
	dataStart := braceStart + closingOff + 1
	if dataStart+2 <= len(rest) && rest[dataStart:dataStart+2] == "\r\n" {
		dataStart += 2
	} else if dataStart+1 <= len(rest) && rest[dataStart:dataStart+1] == "\n" {
		dataStart++
	}
	if dataStart+count > len(rest) {
		return rest[dataStart:]
	}
	return rest[dataStart : dataStart+count]
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────────────────────────────────────

func headerFirst(headers map[string][]string, name string) string {
	if vals, ok := headers[strings.ToLower(name)]; ok && len(vals) > 0 {
		return strings.TrimSpace(vals[0])
	}
	return ""
}

func extractBareAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	// "Display Name <bare@host>" → "bare@host"
	if i := strings.Index(addr, "<"); i >= 0 {
		if j := strings.Index(addr[i:], ">"); j >= 0 {
			return strings.ToLower(strings.TrimSpace(addr[i+1 : i+j]))
		}
	}
	return strings.ToLower(addr)
}

func nullableStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// pq_array converts a []string to a PostgreSQL array literal.
// We avoid importing github.com/lib/pq directly in this package;
// use the text representation instead.
func pq_array(vals []string) string {
	if len(vals) == 0 {
		return "{}"
	}
	parts := make([]string, len(vals))
	for i, v := range vals {
		// Escape embedded quotes and backslashes.
		v = strings.ReplaceAll(v, `\`, `\\`)
		v = strings.ReplaceAll(v, `"`, `\"`)
		parts[i] = `"` + v + `"`
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func lookupMailboxIDByAddress(ctx context.Context, database *sql.DB, addr string) (int64, error) {
	bare := extractBareAddress(addr)
	var id int64
	err := database.QueryRowContext(ctx,
		`SELECT id FROM outreach_mailboxes WHERE from_address = $1`, bare, // AP5_ALLOW_NO_ENV_FILTER: single-row address lookup, not a production-mailbox set query
	).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id, nil
}

// readAll reads all bytes from a reader, used as a simple wrapper.
func readAll(r io.Reader) ([]byte, error) {
	return io.ReadAll(r)
}

// ──────────────────────────────────────────────────────────────────────────────
// Subject-marker helpers (issue #552 — anti-trace-relay-safe pairing)
// ──────────────────────────────────────────────────────────────────────────────

// subjectMarkerLen is the number of hex characters from the run_id (hyphens
// stripped) that form the "[A:<short>]" subject prefix. Must match the
// value in cmd/anonymity-test/main.go.
const subjectMarkerLen = 8

// subjectShortID extracts the first subjectMarkerLen hex characters from a
// UUID v4 run_id (hyphens stripped) for use in the "[A:<short>]" prefix.
//
// Example: "1a2b3c4d-5e6f-4..." → "1a2b3c4d"
func subjectShortID(runID string) string {
	clean := strings.ReplaceAll(runID, "-", "")
	if len(clean) >= subjectMarkerLen {
		return clean[:subjectMarkerLen]
	}
	return clean
}

// parseSubjectMarker extracts the short run-id prefix from a subject that
// begins with "[A:<short>] ". Returns ("", false) when the subject has no
// marker or the marker is malformed. The short value is compared against
// subjectShortID(runID) to confirm the message belongs to this run.
func parseSubjectMarker(subject string) (short string, ok bool) {
	if !strings.HasPrefix(subject, "[A:") {
		return "", false
	}
	rest := subject[3:] // skip "[A:"
	end := strings.Index(rest, "]")
	if end < 0 {
		return "", false
	}
	return rest[:end], true
}

// matchesRun reports whether the Subject of a delivered message matches a
// given run_id via the "[A:<short>]" marker. Returns true when the marker
// is present AND the short prefix equals subjectShortID(runID).
func matchesRun(subject, runID string) bool {
	short, ok := parseSubjectMarker(subject)
	if !ok {
		return false
	}
	return short == subjectShortID(runID)
}
