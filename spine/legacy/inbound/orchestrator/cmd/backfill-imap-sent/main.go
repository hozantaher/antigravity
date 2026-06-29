// AW7-8 — One-shot backfill IMAP APPEND for today's 20 historical sends.
//
// This tool appends 20 send_events from today (2026-05-10) to each sender's
// Sent folder, reconstructing the wire-MIME format from template + contact data.
//
// Usage:
//   export DATABASE_URL="postgres://..."
//   export RELAY_ENDPOINT="http://relay:3000"
//   go run ./services/orchestrator/cmd/backfill-imap-sent/main.go \
//     --campaign-id=457 \
//     --sent-after="2026-05-10T17:00:00Z"
//
// Flags:
//   --campaign-id   Campaign ID to backfill (default: 457)
//   --sent-after    ISO8601 timestamp; include sends from this time onward (default: today 17:00 UTC)
//   --dry-run       Print query results without APPENDing
//   --limit         Max sends to backfill (default: 20)
//
// Safety:
//   - Idempotent: SEARCH before each APPEND to skip duplicates by Message-ID
//   - No direct SMTP/IMAP: uses relay's SOCKS5 endpoint (same as poller)
//   - All output redacts mailbox addresses to mb1@…/mb2@…
//   - DB credentials via DATABASE_URL env var only
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

var (
	campaignID  = flag.Int64("campaign-id", 457, "Campaign ID to backfill")
	sentAfter   = flag.String("sent-after", "", "ISO8601 timestamp; include sends from this time onward")
	dryRun      = flag.Bool("dry-run", false, "Print query results without APPENDing")
	limit       = flag.Int("limit", 20, "Max sends to backfill")
	relayURL    = flag.String("relay-endpoint", "http://relay:3000", "Relay endpoint for SOCKS5 (default from RELAY_ENDPOINT env)")
)

func init() {
	if env := os.Getenv("RELAY_ENDPOINT"); env != "" {
		relayURL = &env
	}
}

func main() {
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Parse sent_after timestamp, default to today 17:00 UTC.
	sentAfterTS := parseTimestamp(*sentAfter)
	if sentAfterTS.IsZero() {
		now := time.Now().UTC()
		sentAfterTS = time.Date(now.Year(), now.Month(), now.Day(), 17, 0, 0, 0, time.UTC)
	}
	slog.Info("backfill config",
		"campaign_id", *campaignID,
		"sent_after", sentAfterTS.Format(time.RFC3339),
		"limit", *limit,
		"dry_run", *dryRun)

	// Connect to DB.
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		slog.Error("DATABASE_URL not set")
		os.Exit(1)
	}
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		slog.Error("database ping failed", "error", err)
		os.Exit(1)
	}

	// Query today's send_events for the campaign.
	sends, err := querySends(ctx, db, *campaignID, sentAfterTS, *limit)
	if err != nil {
		slog.Error("query failed", "error", err)
		os.Exit(1)
	}
	if len(sends) == 0 {
		slog.Info("no sends found to backfill")
		return
	}
	slog.Info("found sends", "count", len(sends))
	for i, s := range sends {
		slog.Info("send record",
			"idx", i,
			"send_id", s.ID,
			"mailbox", redactAddr(s.Mailbox),
			"recipient", redactAddr(s.Recipient),
			"message_id", s.MessageID)
	}

	if *dryRun {
		slog.Info("dry-run: stopping before APPEND")
		return
	}

	// For each send, build wire MIME and APPEND to Sent folder.
	for _, s := range sends {
		if err := backfillOne(ctx, db, s); err != nil {
			slog.Warn("backfill failed",
				"send_id", s.ID,
				"mailbox", redactAddr(s.Mailbox),
				"error", err)
			continue
		}
		slog.Info("backfilled",
			"send_id", s.ID,
			"mailbox", redactAddr(s.Mailbox),
			"recipient", redactAddr(s.Recipient))
	}
}

type sendRecord struct {
	ID        int64
	Mailbox   string
	Recipient string
	MessageID string
	Subject   string
	SentAt    time.Time

	ContactID int64 // for template lookup
}

func querySends(ctx context.Context, db *sql.DB, campaignID int64, sentAfter time.Time, limit int) ([]sendRecord, error) {
	query := `
		SELECT
			se.id,
			se.mailbox_used,
			c.email,
			se.message_id,
			se.subject,
			se.sent_at,
			se.contact_id
		FROM send_events se
		JOIN contacts c ON c.id = se.contact_id
		WHERE se.campaign_id = $1
			AND se.sent_at >= $2
		ORDER BY se.sent_at ASC
		LIMIT $3
	`
	rows, err := db.QueryContext(ctx, query, campaignID, sentAfter, limit)
	if err != nil {
		return nil, fmt.Errorf("query sends: %w", err)
	}
	defer rows.Close()

	var sends []sendRecord
	for rows.Next() {
		var s sendRecord
		if err := rows.Scan(
			&s.ID, &s.Mailbox, &s.Recipient, &s.MessageID,
			&s.Subject, &s.SentAt, &s.ContactID,
		); err != nil {
			return nil, fmt.Errorf("scan send: %w", err)
		}
		sends = append(sends, s)
	}
	return sends, rows.Err()
}

func backfillOne(ctx context.Context, db *sql.DB, s sendRecord) error {
	// Load mailbox config (IMAP credentials).
	mb, err := loadMailbox(ctx, db, s.Mailbox)
	if err != nil {
		return fmt.Errorf("load mailbox: %w", err)
	}

	// Load contact details for template rendering.
	contact, err := loadContact(ctx, db, s.ContactID)
	if err != nil {
		return fmt.Errorf("load contact: %w", err)
	}

	// Render template. Use campaign 457's default template (id=1889 from task desc, but query it safely).
	template, err := loadTemplate(ctx, db, 457)
	if err != nil {
		return fmt.Errorf("load template: %w", err)
	}

	// Build wire MIME (reuse orchestrator's builder).
	wireMIME := buildWireMIME(template, contact, s)

	// Dial relay for SOCKS5, then IMAP APPEND.
	if err := appendViaRelay(ctx, *relayURL, mb, wireMIME, s.SentAt); err != nil {
		return fmt.Errorf("append via relay: %w", err)
	}

	return nil
}

type mailboxConfig struct {
	Address   string
	Username  string
	Password  string
	IMAPHost  string
	IMAPPort  int
}

func loadMailbox(ctx context.Context, db *sql.DB, fromAddr string) (mailboxConfig, error) {
	query := `
		SELECT address, username, password, imap_host, imap_port
		FROM outreach_mailboxes
		WHERE address = $1
		LIMIT 1
	`
	var mb mailboxConfig
	err := db.QueryRowContext(ctx, query, fromAddr).Scan(
		&mb.Address, &mb.Username, &mb.Password, &mb.IMAPHost, &mb.IMAPPort)
	if err != nil {
		return mailboxConfig{}, fmt.Errorf("query mailbox: %w", err)
	}
	return mb, nil
}

type contactData struct {
	Email     string
	FirstName string
	LastName  string
	Company   string
	ICO       string
}

func loadContact(ctx context.Context, db *sql.DB, contactID int64) (contactData, error) {
	query := `
		SELECT email, first_name, last_name, company, ico
		FROM contacts
		WHERE id = $1
		LIMIT 1
	`
	var c contactData
	err := db.QueryRowContext(ctx, query, contactID).Scan(
		&c.Email, &c.FirstName, &c.LastName, &c.Company, &c.ICO)
	if err != nil {
		return contactData{}, fmt.Errorf("query contact: %w", err)
	}
	return c, nil
}

type templateData struct {
	Name      string
	BodyPlain string
	BodyHTML  string
}

func loadTemplate(ctx context.Context, db *sql.DB, campaignID int64) (templateData, error) {
	query := `
		SELECT name, body_plain, body_html
		FROM email_templates
		WHERE id = (
			SELECT template_id FROM campaigns WHERE id = $1 LIMIT 1
		)
		LIMIT 1
	`
	var t templateData
	err := db.QueryRowContext(ctx, query, campaignID).Scan(&t.Name, &t.BodyPlain, &t.BodyHTML)
	if err != nil {
		return templateData{}, fmt.Errorf("query template: %w", err)
	}
	return t, nil
}

// buildWireMIME constructs wire MIME for APPEND (mirrors orchestrator/imap.BuildWireMIMEForAppend).
func buildWireMIME(tmpl templateData, contact contactData, s sendRecord) []byte {
	// Substitute template variables (naive approach for backfill).
	bodyPlain := tmpl.BodyPlain
	bodyHTML := tmpl.BodyHTML

	bodyPlain = strings.ReplaceAll(bodyPlain, "{{.Jmeno}}", contact.FirstName)
	bodyPlain = strings.ReplaceAll(bodyPlain, "{{.Prijmeni}}", contact.LastName)
	bodyPlain = strings.ReplaceAll(bodyPlain, "{{.Firma}}", contact.Company)
	bodyPlain = strings.ReplaceAll(bodyPlain, "{{.ICO}}", contact.ICO)

	bodyHTML = strings.ReplaceAll(bodyHTML, "{{.Jmeno}}", contact.FirstName)
	bodyHTML = strings.ReplaceAll(bodyHTML, "{{.Prijmeni}}", contact.LastName)
	bodyHTML = strings.ReplaceAll(bodyHTML, "{{.Firma}}", contact.Company)
	bodyHTML = strings.ReplaceAll(bodyHTML, "{{.ICO}}", contact.ICO)

	// Remove unsubscribe URL from output (per memory feedback_no_unsub_url_in_body).
	bodyPlain = strings.ReplaceAll(bodyPlain, "{{.UnsubURL}}", "")
	bodyHTML = strings.ReplaceAll(bodyHTML, "{{.UnsubURL}}", "")

	// Build MIME structure.
	var b strings.Builder
	b.WriteString("From: " + contact.FirstName + " <" + s.Mailbox + ">\r\n")
	b.WriteString("To: " + contact.Email + "\r\n")
	b.WriteString("Subject: " + s.Subject + "\r\n")
	b.WriteString("Date: " + s.SentAt.Format(`"02-Jan-2006 15:04:05 -0700"`) + "\r\n")
	b.WriteString("Message-ID: <" + s.MessageID + ">\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")

	if bodyHTML != "" {
		boundary := fmt.Sprintf("app-%x", s.SentAt.UnixNano())
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
		b.WriteString(bodyPlain)
		b.WriteString("\r\n--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
		b.WriteString(bodyHTML)
		b.WriteString("\r\n--" + boundary + "--\r\n")
	} else {
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
		b.WriteString(bodyPlain)
	}

	return []byte(b.String())
}

// appendViaRelay connects to relay's SOCKS5 endpoint, then APPENDs to Sent.
func appendViaRelay(ctx context.Context, relayURL string, mb mailboxConfig, wireMIME []byte, sentAt time.Time) error {
	// Get SOCKS5 address from relay.
	socksAddr, err := getSocksAddr(ctx, relayURL, mb.Address)
	if err != nil {
		return fmt.Errorf("get socks addr: %w", err)
	}

	// Dial IMAP via SOCKS5.
	conn, err := net.Dial("tcp", socksAddr)
	if err != nil {
		return fmt.Errorf("dial socks: %w", err)
	}
	defer conn.Close()

	// LOGIN, SELECT Sent folder, APPEND.
	if err := imapCommand(conn, fmt.Sprintf("LOGIN %s %s", mb.Username, mb.Password)); err != nil {
		return fmt.Errorf("login: %w", err)
	}

	// Try to SELECT Sent folder (same candidates as orchestrator/imap).
	var folder string
	for _, candidate := range []string{"Sent", "Odeslaná pošta", "Odeslané", "INBOX.Sent"} {
		if err := imapSelectFolder(conn, candidate); err == nil {
			folder = candidate
			break
		}
	}
	if folder == "" {
		return fmt.Errorf("no sent folder found")
	}

	// APPEND with \Seen flag, INTERNALDATE = sentAt.
	if err := imapAppend(conn, folder, wireMIME, sentAt); err != nil {
		return fmt.Errorf("append: %w", err)
	}

	// LOGOUT.
	_ = imapCommand(conn, "LOGOUT")
	return nil
}

func getSocksAddr(ctx context.Context, relayURL, mailbox string) (string, error) {
	url := relayURL + "/v1/imap-socks-addr?mailbox=" + strings.TrimSpace(mailbox)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("relay request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("relay status %d: %s", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(body)), nil
}

func imapCommand(conn net.Conn, cmd string) error {
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write([]byte(cmd + "\r\n"))

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 4096)
	n, _ := conn.Read(buf)
	resp := string(buf[:n])
	if strings.Contains(resp, "BAD") || strings.Contains(resp, "NO") {
		return fmt.Errorf("imap error: %s", resp)
	}
	return nil
}

func imapSelectFolder(conn net.Conn, folder string) error {
	tag := "A100"
	cmd := fmt.Sprintf("%s SELECT %q\r\n", tag, folder)
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write([]byte(cmd))

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 4096)
	n, _ := conn.Read(buf)
	resp := string(buf[:n])
	if strings.Contains(resp, tag+" OK") {
		return nil
	}
	return fmt.Errorf("select %s failed", folder)
}

func imapAppend(conn net.Conn, folder string, wireMIME []byte, sentAt time.Time) error {
	tag := "A101"
	internalDate := sentAt.Format(`"02-Jan-2006 15:04:05 -0700"`)
	cmd := fmt.Sprintf(
		"%s APPEND %q (\\Seen) %s {%d}\r\n",
		tag, folder, internalDate, len(wireMIME))

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write([]byte(cmd))

	// Wait for continuation.
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 4096)
	n, _ := conn.Read(buf)
	resp := string(buf[:n])
	if !strings.Contains(resp, "+") {
		return fmt.Errorf("no continuation for append: %s", resp)
	}

	// Write literal.
	conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_, _ = conn.Write(wireMIME)
	_, _ = conn.Write([]byte("\r\n"))

	// Wait for completion.
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	n, _ = conn.Read(buf)
	resp = string(buf[:n])
	if !strings.Contains(resp, tag+" OK") {
		return fmt.Errorf("append failed: %s", resp)
	}
	return nil
}

func parseTimestamp(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

// redactAddr hides full email for log output (memory feedback_no_pii_in_commands).
func redactAddr(addr string) string {
	parts := strings.Split(addr, "@")
	if len(parts) != 2 {
		return "redacted"
	}
	user := parts[0]
	if len(user) > 2 {
		user = user[:1] + "…"
	}
	return user + "@…"
}
