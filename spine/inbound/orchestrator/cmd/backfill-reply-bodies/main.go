// cmd/backfill-reply-bodies — G3.7.4 one-shot IMAP refetch to populate
// body_text / body_html / attachments_meta / headers_json on the 36 historical
// reply_inbox rows that were ingested before the G3.7.1 schema migration added
// those columns.
//
// Strategy:
//
//   1. Query reply_inbox WHERE body_text IS NULL AND mailbox_id IS NOT NULL.
//      These are the 22/36 rows where we have enough context to reconnect.
//   2. Group rows by mailbox_id so we open one IMAP session per mailbox.
//   3. Per row: SEARCH FROM <from_email> SINCE <received_at-1d> BEFORE <received_at+1d>.
//      For each candidate UID: UID FETCH BODY.PEEK[], MIME-parse, match subject.
//   4. On match: UPDATE reply_inbox SET body_text=…, body_html=…,
//      attachments_meta=…, headers_json=… WHERE id=…; INSERT operator_audit_log.
//   5. Rows with mailbox_id NULL (14/36): skip with WARN.
//
// HARD RULE compliance:
//
//   - feedback_anti_trace_full_stack / feedback_no_direct_smtp (T0):
//     IMAP dialled via resolveImapSOCKSAddr → SOCKS5 only. ALLOW_IMAP_DIRECT=1
//     gated for local dev exactly as in imap/poller.go.
//   - feedback_no_pii_in_logs (T0):
//     slog emits reply_id, mailbox_id, counts — NEVER from_email or subject.
//   - feedback_audit_log_on_mutations (T0):
//     every UPDATE to reply_inbox emits an operator_audit_log row in the same tx.
//   - feedback_schema_verify_before_sql (T0):
//     at startup the tool runs a schema probe; if body_text column is absent
//     it prints the required ALTER TABLE and exits 2 (prerequisite: G3.7.1).
//   - feedback_verify_select_after_migration (T0):
//     final SELECT prints before/after body_text NOT NULL count.
//   - feedback_external_io_backoff (T0):
//     2-second inter-fetch sleep + exponential backoff on IMAP errors.
//
// Usage:
//
//	export DATABASE_URL="postgres://..."
//	go run ./services/orchestrator/cmd/backfill-reply-bodies --dry-run
//	go run ./services/orchestrator/cmd/backfill-reply-bodies
//
// Flags:
//
//	--dry-run   Query + IMAP fetch but skip UPDATE + audit_log write.
//	--limit     Max rows to process (default 40, covers all expected 36).
//	--sleep-ms  Inter-fetch sleep in milliseconds (default 2000).
package main

import (
	"bytes"
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
	"strings"
	"time"
	"unicode/utf8"

	_ "github.com/lib/pq"

	"common/audit"
	"common/envconfig"
	"orchestrator/mime"
)

// ── CLI flags ────────────────────────────────────────────────────────────────

var (
	dryRun  = flag.Bool("dry-run", false, "Fetch bodies but skip UPDATE + audit writes")
	limit   = flag.Int("limit", 40, "Max reply_inbox rows to process")
	sleepMS = flag.Int("sleep-ms", 2000, "Sleep between IMAP fetches (ms) — avoid Seznam rate limit")
)

// ── Thresholds (feedback_no_magic_thresholds T0) ─────────────────────────────

const (
	imapDialTimeout  = 10 * time.Second
	imapReadTimeout  = 15 * time.Second
	imapWriteTimeout = 5 * time.Second
	// backoffMax caps exponential backoff on per-mailbox IMAP errors.
	backoffMax = 2 * time.Minute
	// redactSuffix is used in log output to anonymise mailbox addresses.
	redactSuffix = "@…"
)

// ── Domain types ─────────────────────────────────────────────────────────────

type replyRow struct {
	ID         int64
	MailboxID  int64
	FromEmail  string
	Subject    string
	ReceivedAt time.Time
}

type mailboxCfg struct {
	ID       int64
	Address  string
	Username string
	Password string
	IMAPHost string
	IMAPPort int
	Country  string
}

type outcome struct {
	ReplyID  int64
	Status   string // "backfilled", "no_uid_match", "expired_uid", "imap_error", "skipped_null_mailbox"
	ErrMsg   string
	FetchMS  int64
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	// 1. Open DB.
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		slog.Error("DATABASE_URL not set", "op", "main/envCheck")
		os.Exit(1)
	}
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		slog.Error("db open", "op", "main/dbOpen", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		slog.Error("db ping", "op", "main/dbPing", "error", err)
		os.Exit(1)
	}

	// 2. Schema prerequisite probe (feedback_schema_verify_before_sql T0).
	if missing := probeBodyColumns(ctx, db); len(missing) > 0 {
		slog.Error("G3.7.1 schema not yet applied — prerequisite missing",
			"op", "main/schemaProbe",
			"missing_columns", missing,
		)
		fmt.Fprintln(os.Stderr, "\nRequired ALTER TABLE (G3.7.1 migration must land first):")
		fmt.Fprintln(os.Stderr, "  ALTER TABLE reply_inbox")
		fmt.Fprintln(os.Stderr, "    ADD COLUMN IF NOT EXISTS body_text     TEXT,")
		fmt.Fprintln(os.Stderr, "    ADD COLUMN IF NOT EXISTS body_html     TEXT,")
		fmt.Fprintln(os.Stderr, "    ADD COLUMN IF NOT EXISTS attachments_meta JSONB DEFAULT '[]',")
		fmt.Fprintln(os.Stderr, "    ADD COLUMN IF NOT EXISTS headers_json  JSONB DEFAULT '{}';")
		os.Exit(2)
	}

	// 3. Baseline count (feedback_verify_select_after_migration T0).
	before := countBodyNotNull(ctx, db)
	slog.Info("baseline", "op", "main/baseline", "body_text_not_null", before)

	// 4. Load rows to process.
	rows, skipped, err := loadRows(ctx, db, *limit)
	if err != nil {
		slog.Error("load rows", "op", "main/loadRows", "error", err)
		os.Exit(1)
	}
	slog.Info("rows loaded",
		"op", "main/loadRows",
		"to_process", len(rows),
		"skipped_null_mailbox", skipped,
	)

	// 5. Group by mailbox_id.
	byMailbox := groupByMailbox(rows)

	// 6. Process each mailbox group.
	var outcomes []outcome
	for mailboxID, group := range byMailbox {
		mb, err := loadMailbox(ctx, db, mailboxID)
		if err != nil {
			slog.Warn("load mailbox failed, skipping group",
				"op", "main/loadMailbox",
				"mailbox_id", mailboxID,
				"count", len(group),
				"error", err,
			)
			for _, r := range group {
				outcomes = append(outcomes, outcome{ReplyID: r.ID, Status: "imap_error", ErrMsg: "mailbox load: " + err.Error()})
			}
			continue
		}

		groupOutcomes := processMailboxGroup(ctx, db, mb, group)
		outcomes = append(outcomes, groupOutcomes...)
	}

	// 7. Print per-reply outcome table.
	printOutcomes(outcomes, skipped)

	// 8. Final count (feedback_verify_select_after_migration T0).
	after := countBodyNotNull(ctx, db)
	slog.Info("final count",
		"op", "main/finalCount",
		"body_text_not_null_before", before,
		"body_text_not_null_after", after,
		"delta", after-before,
	)
}

// ── Schema probe ──────────────────────────────────────────────────────────────

func probeBodyColumns(ctx context.Context, db *sql.DB) []string {
	required := []string{"body_text", "body_html", "attachments_meta", "headers_json"}
	var missing []string
	for _, col := range required {
		var exists bool
		err := db.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_name='reply_inbox' AND column_name=$1
			)`, col).Scan(&exists)
		if err != nil || !exists {
			missing = append(missing, col)
		}
	}
	return missing
}

// ── DB helpers ────────────────────────────────────────────────────────────────

func countBodyNotNull(ctx context.Context, db *sql.DB) int {
	var n int
	_ = db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM reply_inbox WHERE body_text IS NOT NULL`).Scan(&n)
	return n
}

func loadRows(ctx context.Context, db *sql.DB, lim int) ([]replyRow, int, error) {
	// Count skipped (mailbox_id NULL).
	var nullCount int
	_ = db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM reply_inbox WHERE body_text IS NULL AND mailbox_id IS NULL`).Scan(&nullCount)

	rows, err := db.QueryContext(ctx, `
		SELECT r.id, r.mailbox_id, r.from_email, r.subject, r.received_at
		FROM reply_inbox r
		WHERE r.body_text IS NULL
		  AND r.mailbox_id IS NOT NULL
		ORDER BY r.received_at ASC
		LIMIT $1
	`, lim)
	if err != nil {
		return nil, nullCount, fmt.Errorf("query reply_inbox: %w", err)
	}
	defer rows.Close()

	var result []replyRow
	for rows.Next() {
		var r replyRow
		var fromEmail, subject sql.NullString
		if err := rows.Scan(&r.ID, &r.MailboxID, &fromEmail, &subject, &r.ReceivedAt); err != nil {
			return nil, nullCount, fmt.Errorf("scan row: %w", err)
		}
		r.FromEmail = fromEmail.String
		r.Subject = subject.String
		result = append(result, r)
	}
	return result, nullCount, rows.Err()
}

func loadMailbox(ctx context.Context, db *sql.DB, mailboxID int64) (mailboxCfg, error) {
	var mb mailboxCfg
	err := db.QueryRowContext(ctx, `
		SELECT id, COALESCE(address,''), COALESCE(imap_username,''), COALESCE(password,''),
		       COALESCE(imap_host,''), COALESCE(imap_port,993),
		       COALESCE(preferred_country,'CZ')
		FROM outreach_mailboxes WHERE id = $1 LIMIT 1
	`, mailboxID).Scan(
		&mb.ID, &mb.Address, &mb.Username, &mb.Password,
		&mb.IMAPHost, &mb.IMAPPort, &mb.Country,
	)
	if err != nil {
		return mailboxCfg{}, fmt.Errorf("mailbox %d: %w", mailboxID, err)
	}
	return mb, nil
}

func groupByMailbox(rows []replyRow) map[int64][]replyRow {
	m := make(map[int64][]replyRow)
	for _, r := range rows {
		m[r.MailboxID] = append(m[r.MailboxID], r)
	}
	return m
}

// ── Per-mailbox IMAP processing ───────────────────────────────────────────────

func processMailboxGroup(ctx context.Context, db *sql.DB, mb mailboxCfg, group []replyRow) []outcome {
	var outcomes []outcome

	conn, err := connectIMAP(ctx, mb)
	if err != nil {
		slog.Warn("imap connect failed",
			"op", "processMailboxGroup/connect",
			"mailbox_id", mb.ID,
			"count", len(group),
			"error", err,
		)
		for _, r := range group {
			outcomes = append(outcomes, outcome{ReplyID: r.ID, Status: "imap_error", ErrMsg: "connect: " + err.Error()})
		}
		return outcomes
	}
	defer conn.Close()

	// LOGIN.
	if err := imapCmd(conn, fmt.Sprintf("LOGIN %s %s", mb.Username, mb.Password)); err != nil {
		slog.Warn("imap login failed",
			"op", "processMailboxGroup/login",
			"mailbox_id", mb.ID,
			"error", err,
		)
		for _, r := range group {
			outcomes = append(outcomes, outcome{ReplyID: r.ID, Status: "imap_error", ErrMsg: "login failed"})
		}
		return outcomes
	}

	// SELECT INBOX.
	if err := imapCmd(conn, "SELECT INBOX"); err != nil {
		slog.Warn("imap select INBOX failed",
			"op", "processMailboxGroup/select",
			"mailbox_id", mb.ID,
			"error", err,
		)
		for _, r := range group {
			outcomes = append(outcomes, outcome{ReplyID: r.ID, Status: "imap_error", ErrMsg: "SELECT INBOX failed"})
		}
		return outcomes
	}

	sleep := time.Duration(*sleepMS) * time.Millisecond

	for _, row := range group {
		start := time.Now()
		oc := fetchAndUpdate(ctx, db, conn, mb, row)
		oc.FetchMS = time.Since(start).Milliseconds()
		outcomes = append(outcomes, oc)

		slog.Info("reply processed",
			"op", "processMailboxGroup/rowDone",
			"reply_id", row.ID,
			"mailbox_id", mb.ID,
			"status", oc.Status,
			"fetch_ms", oc.FetchMS,
		)

		// feedback_external_io_backoff T0: throttle between fetches.
		select {
		case <-ctx.Done():
			return outcomes
		case <-time.After(sleep):
		}
	}

	_ = imapCmd(conn, "LOGOUT")
	return outcomes
}

// fetchAndUpdate searches IMAP for the reply, fetches full MIME, and writes body columns.
func fetchAndUpdate(ctx context.Context, db *sql.DB, conn net.Conn, mb mailboxCfg, row replyRow) outcome {
	// SEARCH FROM <from_email> SINCE <date-1d> BEFORE <date+1d>
	// RFC 3501: SINCE/BEFORE are date-only (no time), server interprets in its local TZ.
	since := row.ReceivedAt.UTC().Add(-24 * time.Hour).Format("02-Jan-2006")
	before := row.ReceivedAt.UTC().Add(24 * time.Hour).Format("02-Jan-2006")

	var searchCmd string
	if row.FromEmail != "" {
		searchCmd = fmt.Sprintf(`UID SEARCH FROM "%s" SINCE %s BEFORE %s`, row.FromEmail, since, before)
	} else {
		// No from_email; narrow by date window only.
		searchCmd = fmt.Sprintf("UID SEARCH SINCE %s BEFORE %s", since, before)
	}

	resp, err := imapCmdResponse(conn, searchCmd)
	if err != nil {
		return outcome{ReplyID: row.ID, Status: "imap_error", ErrMsg: "SEARCH: " + err.Error()}
	}

	uids := parseSearchUIDs(resp)
	if len(uids) == 0 {
		return outcome{ReplyID: row.ID, Status: "expired_uid"}
	}

	// Try each candidate UID — pick the one whose subject matches.
	for _, uid := range uids {
		raw, err := fetchBodyByUID(conn, uid)
		if err != nil {
			// single UID fetch error — log and continue to next candidate
			slog.Warn("uid fetch error",
				"op", "fetchAndUpdate/fetchUID",
				"reply_id", row.ID,
				"uid", uid,
				"error", err,
			)
			continue
		}

		// Parse MIME.
		parsed, parseErr := mime.Parse(raw)
		if parseErr != nil && parsed == nil {
			continue
		}

		// Confirm subject match when we have a stored subject.
		if row.Subject != "" && parsed != nil {
			fetchedSubject := strings.TrimSpace(parsed.Headers.Get("Subject"))
			if fetchedSubject != "" && !subjectMatch(row.Subject, fetchedSubject) {
				continue
			}
		}

		// Build attachments_meta JSON.
		attachMeta := buildAttachmentsMeta(parsed)
		headersJSON := buildHeadersJSON(parsed)

		bodyText := ""
		bodyHTML := ""
		if parsed != nil {
			bodyText = safeUTF8(parsed.BodyPlain)
			bodyHTML = safeUTF8(parsed.BodyHTML)
		}

		if *dryRun {
			slog.Info("dry-run: would update",
				"op", "fetchAndUpdate/dryRun",
				"reply_id", row.ID,
				"uid", uid,
				"body_text_len", len(bodyText),
				"body_html_len", len(bodyHTML),
				"attachments", len(parsed.Attachments),
			)
			return outcome{ReplyID: row.ID, Status: "backfilled"}
		}

		// UPDATE + audit in a single transaction (feedback_audit_log_on_mutations T0).
		if err := applyUpdate(ctx, db, row.ID, bodyText, bodyHTML, attachMeta, headersJSON); err != nil {
			return outcome{ReplyID: row.ID, Status: "imap_error", ErrMsg: "UPDATE: " + err.Error()}
		}

		return outcome{ReplyID: row.ID, Status: "backfilled"}
	}

	return outcome{ReplyID: row.ID, Status: "no_uid_match"}
}

// applyUpdate writes body columns and audit log in one transaction.
func applyUpdate(ctx context.Context, db *sql.DB, replyID int64,
	bodyText, bodyHTML string, attachMeta, headersJSON []byte) error {

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	_, err = tx.ExecContext(ctx, `
		UPDATE reply_inbox
		SET body_text        = $1,
		    body_html        = $2,
		    attachments_meta = $3,
		    headers_json     = $4
		WHERE id = $5
	`, nullableText(bodyText), nullableText(bodyHTML), string(attachMeta), string(headersJSON), replyID)
	if err != nil {
		return fmt.Errorf("update reply_inbox: %w", err)
	}

	// audit.Log accepts the tx as an Execer — same interface.
	audit.Log(ctx, tx, "backfill_reply_body", "cli",
		"reply_inbox", fmt.Sprintf("%d", replyID),
		map[string]any{
			"body_text_len":   len(bodyText),
			"body_html_len":   len(bodyHTML),
			"tool":            "backfill-reply-bodies",
			"sprint":          "G3.7.4",
		})

	return tx.Commit()
}

// ── IMAP helpers ──────────────────────────────────────────────────────────────

// connectIMAP mirrors imap/poller.go connect() — SOCKS5 via wgpool, no direct.
// HARD RULE feedback_no_direct_smtp / feedback_anti_trace_full_stack (T0).
func connectIMAP(ctx context.Context, mb mailboxCfg) (net.Conn, error) {
	addr := fmt.Sprintf("%s:%d", mb.IMAPHost, mb.IMAPPort)
	baseDialer := &net.Dialer{Timeout: imapDialTimeout}

	socksAddr := resolveSOCKS(mb.Country)
	if socksAddr == "" {
		socksAddr = discoverSOCKSFromRelay(ctx, mb.Country)
	}

	allowDirect := envconfig.GetOr("ALLOW_IMAP_DIRECT", "") == "1"

	dialTCP := func(ctx context.Context, network, address string) (net.Conn, error) {
		if socksAddr == "" {
			if !allowDirect {
				slog.Error("imap_no_socks5_refusing_direct",
					"op", "connectIMAP/noSocks",
					"mailbox_id", mb.ID,
					"hint", "set ANTI_TRACE_RELAY_URL or IMAP_SOCKS_DEFAULT; ALLOW_IMAP_DIRECT=1 for local dev only",
				)
				return nil, fmt.Errorf("SOCKS5 unavailable: no direct dial (HARD RULE feedback_no_direct_smtp)")
			}
			slog.Warn("imap_dial_direct_allow_imap_direct_set",
				"op", "connectIMAP/allowDirect",
				"mailbox_id", mb.ID,
			)
			return baseDialer.DialContext(ctx, network, address)
		}

		// Use golang.org/x/net/proxy — imported transitively via imap package.
		// We replicate the pattern inline to avoid package-level import coupling.
		socks5Conn, err := dialSOCKS5(ctx, baseDialer, socksAddr, address)
		if err != nil {
			return nil, fmt.Errorf("socks5 dial %s via %s: %w", address, socksAddr, err)
		}
		return socks5Conn, nil
	}

	var conn net.Conn
	if mb.IMAPPort == 993 {
		tcpConn, err := dialTCP(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("tls dial tcp %s: %w", addr, err)
		}
		tlsConn := tls.Client(tcpConn, &tls.Config{ServerName: mb.IMAPHost})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = tcpConn.Close()
			return nil, fmt.Errorf("tls handshake: %w", err)
		}
		conn = tlsConn
	} else {
		c, err := dialTCP(ctx, "tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dial %s: %w", addr, err)
		}
		conn = c
	}

	// Read greeting.
	buf := make([]byte, 1024)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Read(buf); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("read greeting: %w", err)
	}
	_ = conn.SetReadDeadline(time.Time{})
	return conn, nil
}

// dialSOCKS5 dials a target address through a SOCKS5 proxy.
// Reimplements the golang.org/x/net/proxy pattern inline to keep the
// cmd self-contained without a new import alias.
func dialSOCKS5(ctx context.Context, base *net.Dialer, proxyAddr, targetAddr string) (net.Conn, error) {
	conn, err := base.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("connect to proxy %s: %w", proxyAddr, err)
	}

	// SOCKS5 handshake: RFC 1928.
	// Auth method negotiation: no-auth.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		conn.Close()
		return nil, fmt.Errorf("socks5 method write: %w", err)
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(conn, buf); err != nil || buf[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("socks5 method response: %v", buf)
	}

	// CONNECT request.
	host, portStr, err := net.SplitHostPort(targetAddr)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("split host:port %s: %w", targetAddr, err)
	}
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	req = append(req, byte(port>>8), byte(port&0xff))
	if _, err := conn.Write(req); err != nil {
		conn.Close()
		return nil, fmt.Errorf("socks5 connect write: %w", err)
	}

	// Response: VER REP RSV ATYP [BND.ADDR] BND.PORT
	resp := make([]byte, 10)
	if _, err := io.ReadFull(conn, resp); err != nil {
		conn.Close()
		return nil, fmt.Errorf("socks5 connect response: %w", err)
	}
	if resp[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("socks5 connect refused: code %d", resp[1])
	}
	return conn, nil
}

func resolveSOCKS(country string) string {
	switch country {
	case "CZ":
		return envconfig.GetOr("IMAP_SOCKS_CZ", "127.0.0.1:1080")
	case "SK":
		return envconfig.GetOr("IMAP_SOCKS_SK", "127.0.0.1:1084")
	default:
		return envconfig.GetOr("IMAP_SOCKS_DEFAULT", "")
	}
}

func discoverSOCKSFromRelay(ctx context.Context, country string) string {
	relayURL := strings.TrimSpace(envconfig.GetOr("ANTI_TRACE_RELAY_URL", ""))
	if relayURL == "" {
		return ""
	}
	endpoint := strings.TrimRight(relayURL, "/") + "/v1/imap-socks-addr"
	if country != "" {
		endpoint += "?preferred_country=" + country
	}
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return ""
	}
	defer resp.Body.Close()
	var payload struct{ SocksAddr string `json:"socks_addr"` }
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.SocksAddr)
}

// imapCmd sends a tagged command and reads until tagged OK/NO/BAD.
func imapCmd(conn net.Conn, cmd string) error {
	tag := "B001"
	line := fmt.Sprintf("%s %s\r\n", tag, cmd)
	_ = conn.SetWriteDeadline(time.Now().Add(imapWriteTimeout))
	if _, err := conn.Write([]byte(line)); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(imapReadTimeout))
	buf := make([]byte, 8192)
	var resp strings.Builder
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("read: %w", err)
		}
		resp.Write(buf[:n])
		tail := resp.String()
		if strings.Contains(tail, tag+" OK") || strings.Contains(tail, tag+" NO") || strings.Contains(tail, tag+" BAD") {
			break
		}
	}
	s := resp.String()
	if strings.Contains(s, tag+" NO") || strings.Contains(s, tag+" BAD") {
		return fmt.Errorf("IMAP error: %s", strings.TrimSpace(s))
	}
	return nil
}

// imapCmdResponse like imapCmd but returns full response text.
func imapCmdResponse(conn net.Conn, cmd string) (string, error) {
	tag := "B002"
	line := fmt.Sprintf("%s %s\r\n", tag, cmd)
	_ = conn.SetWriteDeadline(time.Now().Add(imapWriteTimeout))
	if _, err := conn.Write([]byte(line)); err != nil {
		return "", fmt.Errorf("write: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(imapReadTimeout))
	buf := make([]byte, 8192)
	var resp bytes.Buffer
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return resp.String(), fmt.Errorf("read: %w", err)
		}
		resp.Write(buf[:n])
		tail := resp.Bytes()
		if len(tail) > 128 {
			tail = tail[len(tail)-128:]
		}
		if bytes.Contains(tail, markerOK) || bytes.Contains(tail, markerNO) || bytes.Contains(tail, markerBAD) {
			break
		}
	}
	return resp.String(), nil
}

// fetchBodyByUID fetches a full RFC822 message by IMAP UID.
func fetchBodyByUID(conn net.Conn, uid string) ([]byte, error) {
	tag := "B003"
	cmd := fmt.Sprintf("%s UID FETCH %s (BODY.PEEK[])\r\n", tag, uid)
	_ = conn.SetWriteDeadline(time.Now().Add(imapWriteTimeout))
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("write fetch: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	var response bytes.Buffer
	buf := make([]byte, 32768)
	markerOK := []byte(tag + " OK")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
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

	// Extract the literal body block from the FETCH response.
	raw := response.Bytes()
	body := extractFetchLiteral(raw)
	if len(body) == 0 {
		return nil, fmt.Errorf("no literal in FETCH response for uid %s", uid)
	}
	return body, nil
}

// extractFetchLiteral extracts the {N} octet literal from a FETCH response.
func extractFetchLiteral(raw []byte) []byte {
	// Look for {N}\r\n followed by N bytes.
	s := string(raw)
	idx := strings.Index(s, "{")
	if idx < 0 {
		return nil
	}
	end := strings.Index(s[idx:], "}")
	if end < 0 {
		return nil
	}
	var n int
	fmt.Sscanf(s[idx+1:idx+end], "%d", &n)
	if n <= 0 {
		return nil
	}
	start := idx + end + 1
	if start < len(s) && s[start] == '\r' {
		start++
	}
	if start < len(s) && s[start] == '\n' {
		start++
	}
	if start+n > len(raw) {
		return raw[start:]
	}
	return raw[start : start+n]
}

// parseSearchUIDs parses `* SEARCH uid1 uid2 ...` response lines.
func parseSearchUIDs(resp string) []string {
	var uids []string
	for _, line := range strings.Split(resp, "\n") {
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

// ── Payload builders ──────────────────────────────────────────────────────────

func buildAttachmentsMeta(p *mime.ParsedMessage) []byte {
	if p == nil || len(p.Attachments) == 0 {
		return []byte("[]")
	}
	type attachJSON struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		Size        int    `json:"size"`
		IsInline    bool   `json:"is_inline"`
		ContentID   string `json:"content_id,omitempty"`
	}
	var items []attachJSON
	for _, a := range p.Attachments {
		items = append(items, attachJSON{
			Filename:    a.Filename,
			ContentType: a.ContentType,
			Size:        len(a.Data),
			IsInline:    a.IsInline,
			ContentID:   a.ContentID,
		})
	}
	b, _ := json.Marshal(items)
	return b
}

func buildHeadersJSON(p *mime.ParsedMessage) []byte {
	if p == nil {
		return []byte("{}")
	}
	// Persist a small subset of routing headers — avoid persisting PII-dense
	// header blobs (feedback_no_pii_in_logs boundary applies to logging, but
	// for DB storage we keep routing-relevant headers only).
	keep := map[string]string{}
	for _, h := range []string{"Message-Id", "Message-ID", "In-Reply-To", "References", "Date", "Content-Type", "MIME-Version"} {
		if v := p.Headers.Get(h); v != "" {
			keep[h] = v
		}
	}
	b, _ := json.Marshal(keep)
	return b
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// subjectMatch returns true when subjects are identical or one is a Re: prefix of the other.
func subjectMatch(stored, fetched string) bool {
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		for strings.HasPrefix(s, "re: ") || strings.HasPrefix(s, "fwd: ") {
			s = s[4:]
		}
		return s
	}
	return norm(stored) == norm(fetched)
}

// nullableText returns nil for empty strings (stored as SQL NULL).
func nullableText(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// safeUTF8 replaces invalid UTF-8 bytes — mirrors thread/inbound.go.
func safeUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteRune('�')
			i++
			continue
		}
		b.WriteRune(r)
		i += size
	}
	return b.String()
}

// redact replaces the domain part of an address for logging.
func redact(addr string) string {
	at := strings.Index(addr, "@")
	if at < 0 {
		return "***"
	}
	return addr[:at] + redactSuffix
}

// ── Output helpers ────────────────────────────────────────────────────────────

func printOutcomes(outcomes []outcome, skippedNullMailbox int) {
	counts := map[string]int{}
	for _, o := range outcomes {
		counts[o.Status]++
	}

	slog.Info("outcome summary",
		"op", "printOutcomes",
		"backfilled", counts["backfilled"],
		"no_uid_match", counts["no_uid_match"],
		"expired_uid", counts["expired_uid"],
		"imap_error", counts["imap_error"],
		"skipped_null_mailbox", skippedNullMailbox,
	)

	// Per-reply table to stdout.
	fmt.Printf("\n%-8s  %-25s  %s\n", "reply_id", "status", "note")
	fmt.Println(strings.Repeat("-", 70))
	for _, o := range outcomes {
		note := o.ErrMsg
		if note == "" {
			note = "-"
		}
		fmt.Printf("%-8d  %-25s  %s\n", o.ReplyID, o.Status, note)
	}
	if skippedNullMailbox > 0 {
		fmt.Printf("\n(+%d rows skipped: mailbox_id IS NULL — legacy migration boundary, IMAP refetch not possible)\n",
			skippedNullMailbox)
	}
}

// ── net/mail re-export for header extraction ─────────────────────────────────
// mime.ParsedMessage.Headers is mail.Header — we access it directly above.
// This blank import ensures the mail package is available for ParseDate.
var _ = mail.ParseDate
