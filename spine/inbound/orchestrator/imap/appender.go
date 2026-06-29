package imap

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"time"

	"common/audit"
	"common/config"
)

// AW7-7 — Post-send IMAP APPEND to the sender's Sent folder.
//
// Motivation: the relay's drain performs an SMTP transaction (sender →
// recipient mailserver) but never writes the message back to the sender's
// IMAP "Sent" mailbox. From the operator's perspective the Seznam webmail
// "Odeslaná pošta" stays empty even after hundreds of campaign sends —
// they cannot audit what went out. Independently, an empty Sent folder is
// a behavioural bot-signal for reputation engines: a real human's webmail
// session always touches Sent on every outbound, so a long-running
// mailbox with zero Sent rows looks like an automated relay account.
//
// This helper performs the missing APPEND step (RFC 3501 §6.3.11) over the
// same SOCKS5 path used by the poller. It is invoked best-effort by the
// engine's onSent callback (see services/orchestrator/cmd/outreach/main.go);
// failures never propagate to the send path because the message has already
// been delivered to the recipient — losing the Sent-folder record is purely
// a recordkeeping/visibility regression, not a delivery failure.
//
// HARD RULE (memory feedback_no_direct_smtp): IMAP traffic MUST traverse
// the relay's SOCKS5 layer. This file delegates the dial to connect() in
// poller.go, which fail-fasts with ErrIMAPSOCKSUnavailable when no SOCKS5
// endpoint can be resolved (except when the explicit ALLOW_IMAP_DIRECT
// dev escape hatch is set). The audit ratchet
// no_direct_imap_audit_test.go enforces this at AST level — the AppendToSent
// code path uses connect() exclusively and never reaches into raw dial APIs.
//
// HARD RULE (memory feedback_anti_trace_full_stack): the production send
// path goes through Engine.WithAntiTrace().Run(); APPEND is wired AFTER
// the engine returns success and is independent of the engine's send
// pipeline. The engine is never blocked or skewed by APPEND outcomes.

// ErrEmptyWireMIME is returned by AppendToSent when the caller passes an
// empty payload. The helper is best-effort but it does refuse to APPEND
// an empty literal — Seznam (and most servers) reject `{0}` with BAD and
// the resulting failure mode would just pollute logs without explaining
// the root cause.
var ErrEmptyWireMIME = errors.New("imap.AppendToSent: wireMIME is empty")

// sentFolderCandidates lists IMAP mailbox names commonly used for the
// Sent folder, ordered by likelihood for the CZ/SK mailbox pool. The
// helper tries each in order and uses the first one the server accepts.
//
// Names sourced from observed SELECT responses:
//   - "Sent"             — RFC 6154 \Sent recommended (default many servers).
//   - "Odeslaná pošta"   — Seznam webmail default (cs_CZ).
//   - "Odeslané"         — alternative Czech localization.
//   - "INBOX.Sent"       — Cyrus-style hierarchical layout.
//
// The list is intentionally not exhaustive; if a server uses a different
// localization (e.g. "Sent Items" for some Exchange-bridged accounts) the
// final attempt fails and the caller logs a warn. We do not run LIST to
// auto-discover because the goal here is best-effort and an extra round
// trip per send is not worth the marginal coverage.
var sentFolderCandidates = []string{
	"Sent",
	"Odeslaná pošta",
	"Odeslané",
	"INBOX.Sent",
}

// AppendToSent appends the given wire MIME bytes to the sender mailbox's
// Sent folder over SOCKS5-tunneled IMAP. Best-effort: on any error the
// helper returns it but the caller (engine onSent callback) is expected
// to slog-warn and continue — the send itself has already succeeded by
// the time AppendToSent is invoked.
//
// Behaviour summary:
//   - Skips silently (returns nil) when the mailbox has no IMAP credentials.
//   - Returns ErrEmptyWireMIME when wireMIME is zero-length.
//   - Dials via connect() — same SOCKS5 path as the poller.
//   - LOGIN + try SELECT against sentFolderCandidates in order.
//   - APPEND with the \Seen flag and INTERNALDATE = now in
//     RFC 3501 §6.3.11 format ("02-Jan-2006 15:04:05 -0700").
//   - LOGOUT regardless of APPEND outcome; close conn.
//
// The audit row (when auditDB is non-nil) is recorded by the caller using
// audit.LogChannel — kept in main.go so AppendToSent stays a pure transport
// helper with no DB dependency.
func AppendToSent(ctx context.Context, mb config.MailboxConfig, wireMIME []byte) error {
	return appendToSentWithDial(ctx, mb, wireMIME, connect, time.Now)
}

// appendToSentWithDial is the dial-injectable + clock-injectable variant
// used by the tests. nowFn supplies the INTERNALDATE timestamp so unit
// tests can assert a deterministic wire format without flake.
func appendToSentWithDial(
	ctx context.Context,
	mb config.MailboxConfig,
	wireMIME []byte,
	dial func(context.Context, config.MailboxConfig) (net.Conn, error),
	nowFn func() time.Time,
) error {
	// Skip mailboxes that have no IMAP wiring — same guard the poller uses.
	// Returning nil (not an error) keeps the engine callback simple: the
	// "no IMAP creds" case is the operator's intent for SMTP-only mailboxes
	// and is not a failure mode worth alerting on.
	if mb.IMAPHost == "" || mb.IMAPPort == 0 {
		slog.Debug("imap append skipped — mailbox has no IMAP creds",
			"op", "imap.AppendToSent/skipNoCreds",
			"mailbox", mb.Address)
		return nil
	}
	if len(wireMIME) == 0 {
		return ErrEmptyWireMIME
	}

	conn, err := dial(ctx, mb)
	if err != nil {
		slog.Warn("imap append dial failed",
			"op", "imap.AppendToSent/dialFail",
			"mailbox", mb.Address,
			"error", err)
		return fmt.Errorf("imap append dial: %w", err)
	}
	defer conn.Close()

	if err := command(conn, fmt.Sprintf("LOGIN %s %s", mb.Username, mb.Password)); err != nil {
		slog.Warn("imap append login failed",
			"op", "imap.AppendToSent/loginFail",
			"mailbox", mb.Address,
			"error", err)
		return fmt.Errorf("imap append login: %w", err)
	}
	// LOGOUT is best-effort; we ignore its result because the caller has
	// no use for a logout error after a successful APPEND.
	defer func() { _ = command(conn, "LOGOUT") }()

	folder, err := pickSentFolder(conn)
	if err != nil {
		slog.Warn("imap append could not select any Sent folder",
			"op", "imap.AppendToSent/noSentFolder",
			"mailbox", mb.Address,
			"tried", sentFolderCandidates,
			"error", err)
		return fmt.Errorf("imap append: no Sent folder accepted: %w", err)
	}

	if err := appendMessage(conn, folder, wireMIME, nowFn()); err != nil {
		slog.Warn("imap append failed",
			"op", "imap.AppendToSent/appendFail",
			"mailbox", mb.Address,
			"folder", folder,
			"rfc822_size", len(wireMIME),
			"error", err)
		return fmt.Errorf("imap append %q: %w", folder, err)
	}

	slog.Info("imap append ok",
		"op", "imap.AppendToSent/ok",
		"mailbox", mb.Address,
		"folder", folder,
		"rfc822_size", len(wireMIME))
	return nil
}

// pickSentFolder issues SELECT against each candidate name in turn and
// returns the first one the server accepts. The selectInbox helper in
// poller.go expects literally "INBOX" so we open-code the SELECT here
// against an arbitrary mailbox name.
func pickSentFolder(conn net.Conn) (string, error) {
	var lastErr error
	for _, name := range sentFolderCandidates {
		if err := selectFolder(conn, name); err != nil {
			lastErr = err
			continue
		}
		return name, nil
	}
	if lastErr == nil {
		// Should not happen — the candidate list is non-empty — but defend
		// against a future refactor that empties it.
		lastErr = errors.New("no candidate folders configured")
	}
	return "", lastErr
}

// selectFolder issues SELECT against an arbitrary mailbox name and returns
// nil on tagged OK. Tag "A100" is unique to this helper so it cannot collide
// with the poller's "A001/A002/A003" tag space when both are run against the
// same connection (they aren't — but the explicit isolation costs nothing).
//
// Name is quoted per RFC 3501 §4.3 (astring); folder names with non-ASCII
// like "Odeslaná pošta" go on the wire as-is because Seznam (and most
// servers we target) accept UTF-8 quoted-strings even though strict
// 3501 mandates mUTF-7 (RFC 3501 §5.1.3). Real-world tests against Seznam
// 2026-05-09 confirmed UTF-8 acceptance; if a future server rejects it we
// fall through to the next candidate.
func selectFolder(conn net.Conn, name string) error {
	tag := "A100"
	cmd := fmt.Sprintf("%s SELECT %s\r\n", tag, quoteIMAPString(name))
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return fmt.Errorf("set write deadline: %w", err)
	}
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return fmt.Errorf("write select %s: %w", name, err)
	}

	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return fmt.Errorf("set read deadline: %w", err)
	}

	var response bytes.Buffer
	buf := make([]byte, 4096)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("read select: %w", err)
		}
		response.Write(buf[:n])
		tail := response.Bytes()
		if len(tail) > 128 {
			tail = tail[len(tail)-128:]
		}
		if bytes.Contains(tail, markerOK) {
			return nil
		}
		if bytes.Contains(tail, markerNO) || bytes.Contains(tail, markerBAD) {
			return fmt.Errorf("IMAP %s: %s", name, strings.TrimSpace(response.String()))
		}
	}
	// Reached EOF without any tagged response — treat as error so the caller
	// moves on to the next candidate.
	return fmt.Errorf("IMAP select %s: connection closed before tagged response", name)
}

// appendMessage performs the IMAP APPEND command for one message.
// Wire format per RFC 3501 §6.3.11:
//
//	C: A101 APPEND "Sent" (\Seen) "02-Jan-2006 15:04:05 -0700" {N}\r\n
//	S: + Ready for literal data\r\n
//	C: <N bytes of RFC822 message>\r\n
//	S: A101 OK APPEND completed\r\n
//
// The \Seen flag is included so the message appears as already-read in the
// operator's webmail (matches the behavior of native webmail clients which
// write Sent items as Seen by default).
//
// INTERNALDATE is the timestamp the server records as the message's
// internal date; we set it to the actual send time so the folder is
// chronologically ordered. Format per §6.3.11: `"02-Jan-2006 15:04:05 -0700"`.
func appendMessage(conn net.Conn, folder string, wireMIME []byte, now time.Time) error {
	tag := "A101"
	internalDate := now.Format(`"02-Jan-2006 15:04:05 -0700"`)
	cmd := fmt.Sprintf(
		"%s APPEND %s (\\Seen) %s {%d}\r\n",
		tag,
		quoteIMAPString(folder),
		internalDate,
		len(wireMIME),
	)
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return fmt.Errorf("set write deadline: %w", err)
	}
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return fmt.Errorf("write append cmd: %w", err)
	}

	// Wait for "+ ..." continuation response. Some servers return a tagged
	// NO/BAD here instead (e.g. permission denied on Sent folder) — handle
	// both branches.
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return fmt.Errorf("set read deadline: %w", err)
	}
	var preLiteral bytes.Buffer
	buf := make([]byte, 4096)
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("append: connection closed waiting for continuation")
			}
			return fmt.Errorf("read continuation: %w", err)
		}
		preLiteral.Write(buf[:n])
		// Continuation may arrive as the only line, or follow untagged data.
		raw := preLiteral.Bytes()
		// Continuation response starts a line. Scan line-by-line so we don't
		// false-match a "+ " character sequence inside a quoted string from
		// an untagged response.
		if hasContinuationLine(raw) {
			break
		}
		if bytes.Contains(raw, markerNO) || bytes.Contains(raw, markerBAD) {
			return fmt.Errorf("IMAP APPEND rejected: %s", strings.TrimSpace(preLiteral.String()))
		}
	}

	// Write the literal payload + closing CRLF.
	if err := conn.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set literal write deadline: %w", err)
	}
	if _, err := conn.Write(wireMIME); err != nil {
		return fmt.Errorf("write literal: %w", err)
	}
	if _, err := conn.Write([]byte("\r\n")); err != nil {
		return fmt.Errorf("write literal terminator: %w", err)
	}

	// Read the tagged completion. Generous deadline because the server may
	// fsync the message to disk before responding.
	if err := conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set tagged read deadline: %w", err)
	}
	var tail bytes.Buffer
	markerOK := []byte(tag + " OK")
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("append: connection closed before tagged response: %s",
					strings.TrimSpace(tail.String()))
			}
			return fmt.Errorf("read tagged response: %w", err)
		}
		tail.Write(buf[:n])
		t := tail.Bytes()
		if len(t) > 256 {
			t = t[len(t)-256:]
		}
		if bytes.Contains(t, markerOK) {
			return nil
		}
		if bytes.Contains(t, markerNO) || bytes.Contains(t, markerBAD) {
			return fmt.Errorf("IMAP APPEND: %s", strings.TrimSpace(tail.String()))
		}
	}
}

// hasContinuationLine reports whether buf contains an IMAP "+ " continuation
// response at the start of any line. RFC 3501 §7.5 defines the continuation
// as `"+" SP <text> CRLF` arriving instead of a tagged response.
func hasContinuationLine(buf []byte) bool {
	for _, line := range bytes.Split(buf, []byte("\r\n")) {
		if bytes.HasPrefix(line, []byte("+ ")) || bytes.Equal(line, []byte("+")) {
			return true
		}
	}
	return false
}

// quoteIMAPString returns the IMAP astring form of s (RFC 3501 §4.3). We
// wrap unconditionally in double quotes — even folder names without spaces
// — because that path is universally supported. Internal quotes or
// backslashes are backslash-escaped per §4.3 rules; CR/LF would require
// the literal-form encoding instead, but we never pass a folder name
// containing CR/LF.
func quoteIMAPString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// BuildWireMIMEForAppend constructs a minimal RFC 5322 / RFC 2045 wire-format
// MIME message suitable for IMAP APPEND. It mirrors the structural shape of
// the relay's delivery.BuildMessage (services/relay/internal/delivery/smtp.go)
// — From / To / Subject / Date / Message-ID / MIME-Version structural headers,
// then any custom headers, then either text/plain or multipart/alternative
// body. We do NOT cross-import the relay package because services/relay is a
// separate Go module; duplicating ~40 lines of header assembly is cheaper
// than the module wiring.
//
// The wire MIME built here is for record-keeping in the operator's Sent
// folder. It is intentionally NOT identical to the on-the-wire bytes that
// transited SMTP (those carry relay-injected Received headers + DKIM
// signatures the orchestrator never sees). Sent-folder fidelity is "the
// operator can identify what was sent" — exact byte parity with the
// envelope is not a requirement.
//
// Inputs:
//   - from       — already-humanized From header value (display-name form
//                  when available, bare address otherwise). Caller is
//                  responsible for using req.Headers["From"] when set, else
//                  the bare mailbox address.
//   - to         — recipient address (req.ToAddress).
//   - subject    — req.Subject.
//   - bodyPlain  — req.BodyPlain.
//   - bodyHTML   — req.BodyHTML.
//   - headers    — req.Headers (may include Date / Message-ID / In-Reply-To
//                  / References / X-Mailer). Caller is the engine's
//                  applyAnonymityHeaders output so these are already
//                  anonymized.
func BuildWireMIMEForAppend(from, to, subject, bodyPlain, bodyHTML string, headers map[string]string) []byte {
	var b strings.Builder

	// Structural headers first. Mirror delivery.BuildMessage's ordering so
	// the Sent record matches the wire shape as closely as we can without
	// re-running through the relay.
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")

	// Priority headers — emitted in a deterministic order matching the
	// relay's `headerPriority` slice. Skip empty values so a missing
	// Date doesn't produce "Date: \r\n" (which some parsers reject).
	priority := []string{"Date", "Message-ID", "MIME-Version", "X-Mailer", "User-Agent"}
	written := map[string]bool{
		"From": true, "To": true, "Subject": true,
	}
	for _, key := range priority {
		if val, ok := headers[key]; ok && val != "" {
			b.WriteString(key + ": " + val + "\r\n")
			written[key] = true
		}
	}
	// Any remaining custom headers. Skip the structural ones we already
	// wrote (else duplicate From/To/Subject — same RFC 5322 §3.6.2 trap
	// the relay's BuildMessage skip list defends against).
	skipKeys := map[string]bool{
		"Content-Type":              true,
		"Content-Transfer-Encoding": true,
		"From":                      true,
		"To":                        true,
		"Subject":                   true,
	}
	for key, val := range headers {
		if written[key] || skipKeys[key] {
			continue
		}
		if val == "" {
			continue
		}
		b.WriteString(key + ": " + val + "\r\n")
	}
	if !written["MIME-Version"] {
		b.WriteString("MIME-Version: 1.0\r\n")
	}

	if bodyHTML != "" {
		// multipart/alternative — text/plain first, text/html second
		// (RFC 2046 §5.1.4 says the most "faithful" representation comes
		// last; webmail clients render the last understood part).
		boundary := buildAppendBoundary()
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
		b.WriteString("\r\n")

		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
		b.WriteString("\r\n")
		b.WriteString(bodyPlain)
		b.WriteString("\r\n")

		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
		b.WriteString("\r\n")
		b.WriteString(bodyHTML)
		b.WriteString("\r\n")

		b.WriteString("--" + boundary + "--\r\n")
	} else {
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
		b.WriteString("\r\n")
		b.WriteString(bodyPlain)
	}

	return []byte(b.String())
}

// buildAppendBoundary returns a stable-format multipart boundary string.
// Format: `app-<unix-nanos-base36>` — collision probability inside a
// single message is zero (it's only used as a part separator within one
// MIME envelope); deterministic-enough that tests can substitute the
// clock if they ever need exact bytes.
func buildAppendBoundary() string {
	return fmt.Sprintf("app-%x", time.Now().UnixNano())
}

// AuditAppendOutcome records one channel_audit_log row describing the
// outcome of an AppendToSent attempt. Kept separate from AppendToSent so
// the helper has no DB dependency — callers (orchestrator main.go) wire
// the DB and call this after AppendToSent returns. err==nil → success row.
//
// Best-effort: LogChannel swallows its own DB errors so this never blocks
// the caller.
func AuditAppendOutcome(
	ctx context.Context,
	db audit.Execer,
	mailbox string,
	recipient string,
	messageID string,
	wireSize int,
	folder string,
	err error,
) {
	status := "ok"
	if err != nil {
		status = "fail"
	}
	details := map[string]any{
		"sub_action":  "imap_sent_append",
		"mailbox":     mailbox,
		"folder":      folder,
		"rfc822_size": wireSize,
		"status":      status,
	}
	if err != nil {
		details["error"] = err.Error()
	}
	audit.LogChannel(ctx, db,
		audit.ChannelEmail, audit.DirectionOutbound,
		recipient, messageID, details)
}
