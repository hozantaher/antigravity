package mailsim

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// DSNBuilder produces RFC 3464 compliant Delivery Status Notification
// messages. The resulting RFC 822 text is injected into GreenMail IMAP
// by the bouncer so the production `poll` command consumes it exactly
// like a real mailer-daemon bounce.
type DSNBuilder struct {
	// ReportingMTA is the hostname that claims to have generated this
	// bounce. Matches prod-like "mx1.gw.test" naming so the bounce
	// looks like it came from a real MTA.
	ReportingMTA string
	// MailerDaemonAddress is the From: for the DSN — usually
	// MAILER-DAEMON@<reporting-mta>. Must resolve to an IMAP-deliverable
	// address, otherwise GreenMail rejects it.
	MailerDaemonAddress string
}

// DefaultDSNBuilder returns a builder with sensible localhost defaults.
func DefaultDSNBuilder() *DSNBuilder {
	return &DSNBuilder{
		ReportingMTA:        "mx1.gw.test",
		MailerDaemonAddress: "MAILER-DAEMON@mx1.gw.test",
	}
}

// Build constructs a full RFC 822 message representing a DSN for
// `original` that failed with the given Behavior. The message is a
// multipart/report as specified by RFC 3464 with three parts:
//
//  1. A human-readable description of the failure.
//  2. A message/delivery-status part (the structured DSN fields).
//  3. A message/rfc822 part carrying the first ~1 KiB of the original
//     message so the recipient can identify what bounced.
//
// Returns the complete message ready for IMAP APPEND or SMTP DATA.
func (b *DSNBuilder) Build(original *OriginalMessage, failure Behavior, sentTo string) ([]byte, error) {
	if !failure.IsBounce() {
		return nil, fmt.Errorf("mailsim: behavior %q is not a bounce", failure)
	}

	boundary := randomBoundary()
	now := time.Now().UTC()
	messageID := fmt.Sprintf("<dsn-%s@%s>", randomToken(12), b.ReportingMTA)

	var buf strings.Builder

	// --- Top-level headers ---
	fmt.Fprintf(&buf, "From: Mail Delivery Subsystem <%s>\r\n", b.MailerDaemonAddress)
	fmt.Fprintf(&buf, "To: %s\r\n", original.From)
	fmt.Fprintf(&buf, "Subject: Undelivered Mail Returned to Sender\r\n")
	fmt.Fprintf(&buf, "Date: %s\r\n", now.Format(time.RFC1123Z))
	fmt.Fprintf(&buf, "Message-ID: %s\r\n", messageID)
	if original.MessageID != "" {
		fmt.Fprintf(&buf, "In-Reply-To: %s\r\n", bracketed(original.MessageID))
		fmt.Fprintf(&buf, "References: %s\r\n", bracketed(original.MessageID))
	}
	fmt.Fprintf(&buf, "Auto-Submitted: auto-replied (delivery-status)\r\n")
	fmt.Fprintf(&buf, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&buf, "Content-Type: multipart/report; report-type=delivery-status; boundary=\"%s\"\r\n", boundary)
	fmt.Fprintf(&buf, "X-Failed-Recipients: %s\r\n", sentTo)
	buf.WriteString("\r\n")

	// --- Part 1: human-readable summary ---
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	buf.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	buf.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	buf.WriteString("\r\n")
	fmt.Fprintf(&buf, "This is the mail system at host %s.\r\n", b.ReportingMTA)
	buf.WriteString("\r\n")
	buf.WriteString("I'm sorry to have to inform you that your message could not\r\n")
	buf.WriteString("be delivered to one or more recipients. It's attached below.\r\n")
	buf.WriteString("\r\n")
	buf.WriteString("For further assistance, please send mail to postmaster.\r\n")
	buf.WriteString("\r\n")
	buf.WriteString("If you do so, please include this problem report. You can\r\n")
	buf.WriteString("delete your own text from the attached returned message.\r\n")
	buf.WriteString("\r\n")
	fmt.Fprintf(&buf, "                   The mail system\r\n")
	buf.WriteString("\r\n")
	fmt.Fprintf(&buf, "<%s>: %s\r\n", sentTo, failure.formatDiagnostic(sentTo))
	buf.WriteString("\r\n")

	// --- Part 2: machine-readable delivery-status ---
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	buf.WriteString("Content-Description: Delivery report\r\n")
	buf.WriteString("Content-Type: message/delivery-status\r\n")
	buf.WriteString("\r\n")
	fmt.Fprintf(&buf, "Reporting-MTA: dns; %s\r\n", b.ReportingMTA)
	fmt.Fprintf(&buf, "X-Postfix-Queue-ID: %s\r\n", randomToken(10))
	fmt.Fprintf(&buf, "X-Postfix-Sender: rfc822; %s\r\n", original.From)
	fmt.Fprintf(&buf, "Arrival-Date: %s\r\n", now.Add(-5*time.Minute).Format(time.RFC1123Z))
	buf.WriteString("\r\n")
	fmt.Fprintf(&buf, "Final-Recipient: rfc822; %s\r\n", sentTo)
	fmt.Fprintf(&buf, "Original-Recipient: rfc822; %s\r\n", sentTo)
	actionLine := "Action: failed"
	if failure == BehaviorSoftBounce {
		actionLine = "Action: delayed"
	}
	fmt.Fprintf(&buf, "%s\r\n", actionLine)
	fmt.Fprintf(&buf, "Status: %s\r\n", failure.DSNCode())
	fmt.Fprintf(&buf, "Remote-MTA: dns; %s\r\n", fakeRemoteMTA(sentTo))
	fmt.Fprintf(&buf, "Diagnostic-Code: smtp; %s\r\n", failure.formatDiagnostic(sentTo))
	buf.WriteString("\r\n")

	// --- Part 3: original message (headers + short body snippet) ---
	fmt.Fprintf(&buf, "--%s\r\n", boundary)
	buf.WriteString("Content-Description: Undelivered Message\r\n")
	buf.WriteString("Content-Type: message/rfc822\r\n")
	buf.WriteString("\r\n")
	buf.WriteString(original.HeaderBlock())
	buf.WriteString("\r\n")
	if original.BodySnippet != "" {
		buf.WriteString(original.BodySnippet)
		buf.WriteString("\r\n")
	}

	// --- Closing boundary ---
	fmt.Fprintf(&buf, "--%s--\r\n", boundary)

	return []byte(buf.String()), nil
}

// OriginalMessage captures just enough of the original outbound message
// to reconstruct a useful DSN. Populated from Mailpit's HTTP API.
type OriginalMessage struct {
	From       string
	To         string
	Subject    string
	MessageID  string // includes angle brackets or not — bracketed() normalises
	Date       time.Time
	BodySnippet string // first ~1 KiB of plain-text body
}

// HeaderBlock renders the headers that Part 3 needs so the bouncing
// side can correlate the DSN to an outbound message. We only emit the
// subset of headers needed for matching.
func (o *OriginalMessage) HeaderBlock() string {
	var sb strings.Builder
	if o.MessageID != "" {
		fmt.Fprintf(&sb, "Message-ID: %s\r\n", bracketed(o.MessageID))
	}
	if !o.Date.IsZero() {
		fmt.Fprintf(&sb, "Date: %s\r\n", o.Date.Format(time.RFC1123Z))
	}
	if o.From != "" {
		fmt.Fprintf(&sb, "From: %s\r\n", o.From)
	}
	if o.To != "" {
		fmt.Fprintf(&sb, "To: %s\r\n", o.To)
	}
	if o.Subject != "" {
		fmt.Fprintf(&sb, "Subject: %s\r\n", o.Subject)
	}
	return sb.String()
}

// bracketed ensures a Message-ID carries angle brackets. Accepts either
// "<id>" or "id".
func bracketed(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return ""
	}
	if !strings.HasPrefix(id, "<") {
		id = "<" + id
	}
	if !strings.HasSuffix(id, ">") {
		id += ">"
	}
	return id
}

// randomBoundary returns a unique MIME boundary.
func randomBoundary() string {
	return "_MAILSIM_" + randomToken(16)
}

// randomToken returns a hex token of the given byte length (in hex chars).
func randomToken(n int) string {
	b := make([]byte, (n+1)/2)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

// fakeRemoteMTA returns a plausible-looking hostname for the
// Remote-MTA field of the DSN based on the recipient domain. Real
// bounces include the target MX that refused the message; we mimic
// the format without needing a real DNS lookup.
func fakeRemoteMTA(recipient string) string {
	at := strings.IndexByte(recipient, '@')
	if at < 0 || at == len(recipient)-1 {
		return "unknown.test"
	}
	return "mx." + recipient[at+1:]
}
