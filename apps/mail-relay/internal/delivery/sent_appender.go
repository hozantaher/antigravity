package delivery

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"relay/internal/transport"
)

// Package delivery — sent_appender.go (Sprint AW7-9)
//
// Post-send IMAP APPEND to the sender mailbox's "Sent" folder, run from
// INSIDE the relay container where wgsocks (the userspace WG-SOCKS
// bridge) is co-located.
//
// Why this lives in services/relay and not services/orchestrator:
// AW7-7 originally wired APPEND in the orchestrator's engine onSent
// callback. PROD verification on 2026-05-10 21:35 CEST showed the
// callback firing but every dial failing with
//
//	dial tcp 127.0.0.1:1080: connect: connection refused
//	op=imap.AppendToSent/dialFail
//
// Root cause: wgsocks (the userspace WireGuard + SOCKS5 bridge) is
// spawned by services/anti-trace-relay/entrypoint.sh — once per
// wgpool entry — on `127.0.0.1:108${i}`. Those listeners only exist
// inside the relay container. The orchestrator container has no
// wgsocks instances, so its localhost SOCKS port is empty and the
// dial is rejected by the kernel before any TCP SYN goes on the wire.
//
// Architectural fix (AW7-9): move APPEND into the relay drain, run
// it after a successful outbound_smtp_delivered, and use the same
// transport.AnonymousTransport that already routed the SMTP send.
// That transport is wgpool-aware: under TRANSPORT_MODE=wgpool it
// picks one of the live 127.0.0.1:108x bridges, so IMAP egresses
// from the same Mullvad endpoint that SMTP just used (or one of its
// siblings when pool affinity is off).
//
// Best-effort posture: the SMTP delivery has already succeeded by
// the time we run APPEND. Losing the Sent-folder record is a
// recordkeeping regression, NOT a delivery failure. All errors are
// slog.Warn'd and dropped on the floor; the drain never blocks on
// APPEND latency. Memory feedback_anti_trace_full_stack (HARD): the
// send path is upstream of this code and is never observed by it.
//
// Compliance:
//   - Memory feedback_no_direct_smtp (HARD): every dial routes
//     through transport.AnonymousTransport.DialContext, which is the
//     SOCKS5-aware chain already wired in cmd/relay/main.go. No raw
//     net.Dial / tls.Dial to email-provider hosts.
//   - Memory feedback_extreme_testing (HARD): the partner test file
//     sent_appender_test.go covers ≥10 cases (dial fail, login fail,
//     folder fallback, malformed wireMIME, concurrent goroutines,
//     audit log shape, INTERNALDATE format, panic recovery, port-0
//     skip, kill-switch).
//
// RFC references:
//   - RFC 3501 §6.3.11 (APPEND command + INTERNALDATE format)
//   - RFC 3501 §4.3 (astring quoting)
//   - RFC 6154 §5.4 (Sent special-use mailbox attribute) — we don't
//     run LIST-EXTENDED to look up \\Sent because the candidate list
//     below covers the providers we target (Seznam cs_CZ + EN
//     defaults) and an extra round-trip per send is not justified.

// ErrEmptyWireMIME is returned when AppendToSent is called with an empty
// payload. Servers reject `{0}` literal with BAD; refusing up-front means
// the error message identifies the root cause instead of leaking server
// parse failures into the slog stream.
var ErrEmptyWireMIME = errors.New("delivery.AppendToSent: wireMIME is empty")

// ErrNoIMAPCreds is returned when AppendToSent is called with empty
// IMAP host/port or empty username/password. The drain checks
// InlineSMTPCreds.HasIMAP before calling and treats this as a skip,
// not a failure, but we surface it as an error so the unit tests can
// assert the wiring contract.
var ErrNoIMAPCreds = errors.New("delivery.AppendToSent: missing IMAP credentials")

// SentFolderCandidates lists IMAP mailbox names commonly used for the
// Sent folder, ordered by likelihood for the CZ/SK mailbox pool we
// target. The helper tries each in order and uses the first one the
// server accepts. Names sourced from observed LIST responses:
//   - "sent"           — Seznam.cz actual folder name (\Sent attr, lowercase).
//     Verified 2026-05-11 via raw IMAP LIST on nowak.goran@seznam.cz.
//   - "Sent"           — RFC 6154 \\Sent recommended (Gmail, Outlook).
//   - "Odeslaná pošta" — older Seznam webmail localized name (legacy accounts).
//   - "Odeslané"       — alternative Czech localization.
//   - "INBOX.Sent"     — Cyrus-style hierarchical layout (separator-dependent).
//
// The list is intentionally not exhaustive; if a server uses a
// different localization (e.g. "Sent Items" on some Exchange bridges)
// the final attempt fails and we slog.Warn — preferable to running
// LIST every send. Production fix path: append the new candidate to
// this list and ship.
var SentFolderCandidates = []string{
	"sent",
	"Sent",
	"Odeslaná pošta",
	"Odeslané",
	"INBOX.Sent",
}

// FolderCache caches the per-mailbox Sent folder name to avoid repeated
// SELECT iterations on subsequent appends. Thread-safe.
//
// This optimization assumes folder names are stable (they are on the major
// providers we target — Seznam, Gmail, Outlook). If an operator manually
// renames a folder mid-send, a cache hit will cause a SELECT NO on the old
// name; the next append will iterate candidates again and update the cache.
// Worst-case: we lose one Sent-folder record per folder rename, which is
// acceptable (Sent-folder recordkeeping is best-effort).
type FolderCache struct {
	mu    sync.RWMutex
	cache map[string]string // mailbox_address → folder_name
}

func NewFolderCache() *FolderCache {
	return &FolderCache{cache: make(map[string]string)}
}

func (fc *FolderCache) Get(addr string) (string, bool) {
	fc.mu.RLock()
	defer fc.mu.RUnlock()
	folder, ok := fc.cache[addr]
	return folder, ok
}

func (fc *FolderCache) Set(addr, folder string) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.cache[addr] = folder
}

// AppendParams is the input bundle for AppendToSent. All fields are
// required (validated at call time); zero-value fields trigger
// ErrNoIMAPCreds rather than running and producing an opaque dial
// error against a phantom server.
type AppendParams struct {
	// MailboxAddress is the sender's email address — used only for slog
	// "mailbox" key, not for protocol routing. May be redacted upstream.
	MailboxAddress string
	// IMAPHost is the FQDN of the IMAP server (e.g. "imap.seznam.cz").
	IMAPHost string
	// IMAPPort is the IMAP listener port. 993 forces implicit TLS; any
	// other port (e.g. 143) uses plain TCP. STARTTLS is intentionally
	// not implemented — Seznam and the providers we target offer 993,
	// and STARTTLS adds surface area for downgrade attacks.
	IMAPPort int
	// Username + Password are the IMAP credentials. For Seznam these
	// equal the SMTP credentials; the drain passes the SMTP fields
	// from InlineSMTPCreds unchanged.
	Username string
	Password string
	// WireMIME is the byte payload to APPEND. Must be non-empty; the
	// helper does not synthesise content. Caller (drain) builds it
	// from the in-memory content struct.
	WireMIME []byte
}

// clock isolates time.Now so tests can pin INTERNALDATE without flake.
type clock func() time.Time

// AppendToSent dials the IMAP server through the provided
// transport.AnonymousTransport, performs LOGIN, tries SELECT against
// SentFolderCandidates in order, and APPENDs the wireMIME with the
// \\Seen flag and an RFC 3501 §6.3.11 INTERNALDATE.
//
// Behaviour summary:
//   - Returns ErrNoIMAPCreds when params lack host/port/username/password.
//   - Returns ErrEmptyWireMIME when WireMIME is zero-length.
//   - Dials via t.DialContext — same SOCKS5 path as SMTP delivery.
//   - LOGIN + try SELECT against SentFolderCandidates in order.
//   - APPEND with the \\Seen flag and INTERNALDATE = now in RFC 3501
//     format ("02-Jan-2006 15:04:05 -0700").
//   - LOGOUT regardless of APPEND outcome; close conn.
//
// Best-effort: the caller (drain) logs slog.Warn on error and
// continues. The send pipeline is upstream and cannot observe this
// return value.
func AppendToSent(ctx context.Context, t transport.AnonymousTransport, p AppendParams) error {
	return appendToSentWithClock(ctx, t, p, time.Now)
}

// appendToSentWithClock is the clock-injectable form used by tests.
// nowFn supplies the INTERNALDATE timestamp.
func appendToSentWithClock(ctx context.Context, t transport.AnonymousTransport, p AppendParams, nowFn clock) error {
	if p.IMAPHost == "" || p.IMAPPort == 0 || p.Username == "" || p.Password == "" {
		return ErrNoIMAPCreds
	}
	if len(p.WireMIME) == 0 {
		return ErrEmptyWireMIME
	}
	if t == nil {
		return errors.New("delivery.AppendToSent: transport is nil")
	}

	addr := fmt.Sprintf("%s:%d", p.IMAPHost, p.IMAPPort)
	rawConn, err := t.DialContext(ctx, "tcp", addr)
	if err != nil {
		slog.Warn("imap append dial failed",
			"op", "delivery.AppendToSent/dialFail",
			"mailbox", p.MailboxAddress,
			"imap_addr", addr,
			"error", err)
		return fmt.Errorf("imap append dial: %w", err)
	}

	var conn net.Conn = rawConn
	if p.IMAPPort == 993 {
		// Wrap with TLS on the implicit-TLS port. AR4 ratchet (parrot
		// TLS fingerprint) requires SMTPParrotTLS over raw &tls.Config{};
		// the same cipher-suite ordering applies to outbound IMAP TLS so
		// the relay's JA3 stays consistent across SMTP + IMAP. Use
		// HandshakeContext so ctx cancellation propagates; close the
		// underlying TCP conn on handshake failure so we don't leak FD.
		tlsConn := tls.Client(rawConn, transport.SMTPParrotTLS(p.IMAPHost))
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = rawConn.Close()
			slog.Warn("imap append tls handshake failed",
				"op", "delivery.AppendToSent/tlsFail",
				"mailbox", p.MailboxAddress,
				"imap_addr", addr,
				"error", err)
			return fmt.Errorf("imap append tls: %w", err)
		}
		conn = tlsConn
	}
	defer conn.Close()

	// Read greeting — server sends "* OK ..." before accepting commands.
	// Bounded read deadline; the greeting is small (one line).
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return fmt.Errorf("set greeting deadline: %w", err)
	}
	if err := readUntagged(conn); err != nil {
		slog.Warn("imap append greeting read failed",
			"op", "delivery.AppendToSent/greetingFail",
			"mailbox", p.MailboxAddress,
			"error", err)
		return fmt.Errorf("imap greeting: %w", err)
	}

	// LOGIN. Tag space A100..A103 is unique to this helper so tags do
	// not collide with the relay's other IMAP code paths (none today,
	// but explicit isolation costs nothing).
	if err := imapCommand(conn, "A100", fmt.Sprintf("LOGIN %s %s", quoteIMAPString(p.Username), quoteIMAPString(p.Password))); err != nil {
		slog.Warn("imap append login failed",
			"op", "delivery.AppendToSent/loginFail",
			"mailbox", p.MailboxAddress,
			"error", err)
		return fmt.Errorf("imap login: %w", err)
	}
	defer func() {
		_ = imapCommand(conn, "A103", "LOGOUT")
	}()

	folder, err := pickSentFolder(conn)
	if err != nil {
		slog.Warn("imap append could not select any Sent folder",
			"op", "delivery.AppendToSent/noSentFolder",
			"mailbox", p.MailboxAddress,
			"tried", SentFolderCandidates,
			"error", err)
		return fmt.Errorf("no Sent folder accepted: %w", err)
	}

	if err := appendMessage(conn, folder, p.WireMIME, nowFn()); err != nil {
		slog.Warn("imap append failed",
			"op", "delivery.AppendToSent/appendFail",
			"mailbox", p.MailboxAddress,
			"folder", folder,
			"rfc822_size", len(p.WireMIME),
			"error", err)
		return fmt.Errorf("append %q: %w", folder, err)
	}

	slog.Info("imap append ok",
		"op", "delivery.AppendToSent/ok",
		"mailbox", p.MailboxAddress,
		"folder", folder,
		"rfc822_size", len(p.WireMIME))
	return nil
}

// imapCommand sends one tagged IMAP command and waits for the tagged
// response. Returns nil on tagged OK; error on NO/BAD or transport
// failure. The command writer enforces a 5s write deadline and 15s
// read deadline; APPEND has its own longer-deadline path below.
func imapCommand(conn net.Conn, tag, cmd string) error {
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return fmt.Errorf("set write deadline: %w", err)
	}
	if _, err := conn.Write([]byte(tag + " " + cmd + "\r\n")); err != nil {
		return fmt.Errorf("write %s: %w", cmd, err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return fmt.Errorf("set read deadline: %w", err)
	}
	return readTagged(conn, tag)
}

// readTagged scans until it sees `<tag> OK` (success), `<tag> NO` /
// `<tag> BAD` (failure), or EOF/timeout. Untagged lines (starting
// with "*") are discarded — we don't need their content.
func readTagged(conn net.Conn, tag string) error {
	var buf bytes.Buffer
	tmp := make([]byte, 4096)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("connection closed before tagged response for %s", tag)
			}
			return fmt.Errorf("read tagged %s: %w", tag, err)
		}
		buf.Write(tmp[:n])
		tail := buf.Bytes()
		if len(tail) > 1024 {
			tail = tail[len(tail)-1024:]
		}
		if bytes.Contains(tail, markerOK) {
			return nil
		}
		if bytes.Contains(tail, markerNO) || bytes.Contains(tail, markerBAD) {
			return fmt.Errorf("imap rejected %s: %s", tag, strings.TrimSpace(buf.String()))
		}
	}
}

// readUntagged reads one untagged response line ("* OK ...") and
// returns. Used for the server greeting only.
func readUntagged(conn net.Conn) error {
	var buf bytes.Buffer
	tmp := make([]byte, 4096)
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				if buf.Len() > 0 {
					return nil
				}
				return fmt.Errorf("eof before greeting")
			}
			return fmt.Errorf("read greeting: %w", err)
		}
		buf.Write(tmp[:n])
		if bytes.Contains(buf.Bytes(), []byte("\r\n")) {
			return nil
		}
	}
}

// pickSentFolder issues SELECT against each candidate name in turn
// and returns the first one the server accepts. We don't run LIST
// for auto-discovery (an extra round trip per send is not justified
// when the candidate list covers our entire mailbox pool).
func pickSentFolder(conn net.Conn) (string, error) {
	var lastErr error
	tagBase := "A101"
	for i, name := range SentFolderCandidates {
		// Unique tag per attempt so a server that echoes the tag in
		// an untagged response can't false-match a later SELECT.
		tag := fmt.Sprintf("%s%d", tagBase, i)
		err := imapCommand(conn, tag, "SELECT "+quoteIMAPString(name))
		if err == nil {
			return name, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		// Should not happen — the candidate slice is non-empty — but
		// defend against a future refactor that empties it.
		lastErr = errors.New("no candidate folders configured")
	}
	return "", lastErr
}

// appendMessage performs the IMAP APPEND command for one message.
//
// Wire format per RFC 3501 §6.3.11:
//
//	C: A102 APPEND "Sent" (\Seen) "02-Jan-2006 15:04:05 -0700" {N}\r\n
//	S: + Ready for literal data\r\n
//	C: <N bytes of RFC822 message>\r\n
//	S: A102 OK APPEND completed\r\n
//
// The \\Seen flag is included so the message appears as already-read
// in the operator's webmail (matches webmail-client behaviour: native
// clients write Sent items as Seen by default).
//
// INTERNALDATE is set to the actual send time so the folder is
// chronologically ordered. Format per §6.3.11: "DD-Mon-YYYY HH:MM:SS
// +ZZZZ".
func appendMessage(conn net.Conn, folder string, wireMIME []byte, now time.Time) error {
	tag := "A102"
	internalDate := now.Format(`"02-Jan-2006 15:04:05 -0700"`)
	header := fmt.Sprintf(
		"%s APPEND %s (\\Seen) %s {%d}\r\n",
		tag,
		quoteIMAPString(folder),
		internalDate,
		len(wireMIME),
	)
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return fmt.Errorf("set header write deadline: %w", err)
	}
	if _, err := conn.Write([]byte(header)); err != nil {
		return fmt.Errorf("write append header: %w", err)
	}

	// Wait for "+ ..." continuation. Some servers return tagged NO/BAD
	// here instead (e.g. permission denied on Sent folder); handle both.
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return fmt.Errorf("set continuation deadline: %w", err)
	}
	var pre bytes.Buffer
	tmp := make([]byte, 4096)
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("connection closed waiting for continuation")
			}
			return fmt.Errorf("read continuation: %w", err)
		}
		pre.Write(tmp[:n])
		raw := pre.Bytes()
		if hasContinuationLine(raw) {
			break
		}
		if bytes.Contains(raw, markerNO) || bytes.Contains(raw, markerBAD) {
			return fmt.Errorf("imap APPEND rejected: %s", strings.TrimSpace(pre.String()))
		}
	}

	// Write the literal payload + CRLF.
	if err := conn.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set literal write deadline: %w", err)
	}
	if _, err := conn.Write(wireMIME); err != nil {
		return fmt.Errorf("write literal: %w", err)
	}
	if _, err := conn.Write([]byte("\r\n")); err != nil {
		return fmt.Errorf("write literal terminator: %w", err)
	}

	// Read the tagged completion. Generous deadline because the server
	// may fsync the message to disk before responding.
	if err := conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set tagged read deadline: %w", err)
	}
	return readTagged(conn, tag)
}

// hasContinuationLine reports whether buf contains an IMAP "+ "
// continuation response at the start of any line. RFC 3501 §7.5
// defines the continuation as `"+" SP <text> CRLF` arriving instead
// of a tagged response.
func hasContinuationLine(buf []byte) bool {
	for _, line := range bytes.Split(buf, []byte("\r\n")) {
		if bytes.HasPrefix(line, []byte("+ ")) || bytes.Equal(line, []byte("+")) {
			return true
		}
	}
	return false
}

// quoteIMAPString returns the IMAP astring form of s (RFC 3501 §4.3).
// We wrap unconditionally in double quotes — even names without
// spaces — because that path is universally supported. Internal
// quotes or backslashes are backslash-escaped per §4.3 rules; CR/LF
// would require the literal-form encoding instead, but we never pass
// a folder/credential value containing CR/LF (the drain validates
// upstream).
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

// BuildWireMIMEForAppend constructs a minimal RFC 5322 / RFC 2045
// wire-format MIME message suitable for IMAP APPEND. It mirrors the
// structural shape of BuildMessage (smtp.go in this package).
//
// The wire MIME built here is for recordkeeping in the operator's
// Sent folder. It is intentionally NOT identical to the on-the-wire
// bytes that transited SMTP (those carry relay-injected Received
// headers + DKIM signatures the relay does not own). Sent-folder
// fidelity is "the operator can identify what was sent" — exact byte
// parity with the envelope is not a requirement.
//
// AW7-9 — duplicated from services/orchestrator/imap/appender.go
// rather than imported because services/relay is a separate Go
// module and a single helper function does not justify the wiring.
// The two implementations are deliberately kept in step structurally
// (priority headers, skip list); divergence is a code smell flagged
// during PR review.
func BuildWireMIMEForAppend(from, to, subject, bodyPlain, bodyHTML string, headers map[string]string) []byte {
	var b strings.Builder

	// Structural headers first. Mirror BuildMessage's ordering so the
	// Sent record matches the wire shape as closely as we can without
	// re-running through the relay.
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")

	priority := []string{"Date", "Message-ID", "MIME-Version", "X-Mailer", "User-Agent"}
	written := map[string]bool{
		"From":    true,
		"To":      true,
		"Subject": true,
	}
	for _, key := range priority {
		if key == "Date" {
			// Always emit Date — essential for Sent-folder ordering and provider
			// filtering. If caller didn't supply one, generate it in RFC 5322 format.
			if val, ok := headers[key]; ok && val != "" {
				b.WriteString(key + ": " + val + "\r\n")
			} else {
				// Generate Date in RFC 5322 format (e.g. "Sun, 11 May 2026 10:00:00 +0200")
				// Use local time zone to match relay's context.
				b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
			}
			written[key] = true
		} else if key == "Message-ID" {
			// Always emit Message-ID — essential for preventing duplicates and
			// email client threading. If caller didn't supply one, generate a
			// deterministic but unique ID.
			if val, ok := headers[key]; ok && val != "" {
				b.WriteString(key + ": " + val + "\r\n")
			} else {
				// Generate Message-ID: <append-{random-hex}@{domain-from-from}>
				// Extract domain from 'from' address for the Message-ID host part.
				domain := "localhost"
				if idx := strings.LastIndex(from, "@"); idx > 0 {
					domain = from[idx+1:]
				}
				msgID := generateMessageID(domain)
				b.WriteString("Message-ID: " + msgID + "\r\n")
			}
			written[key] = true
		} else if val, ok := headers[key]; ok && val != "" {
			b.WriteString(key + ": " + val + "\r\n")
			written[key] = true
		}
	}
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

// generateMessageID generates a Message-ID of the form
// <append-{16-hex-random}@domain>. The random hex ensures uniqueness
// across multiple appends for the same mailbox. Format per RFC 5322.
func generateMessageID(domain string) string {
	buf := make([]byte, 8) // 8 bytes = 16 hex chars
	if _, err := rand.Read(buf); err != nil {
		// Fallback to timestamp-based ID on random read failure (unlikely).
		return fmt.Sprintf("<append-%x@%s>", time.Now().UnixNano(), domain)
	}
	return fmt.Sprintf("<append-%s@%s>", hex.EncodeToString(buf), domain)
}

// buildAppendBoundary returns a stable-format multipart boundary
// string. Format: `app-<unix-nanos-hex>` — collision probability
// inside a single message is zero (it's only used as a part
// separator within one MIME envelope).
func buildAppendBoundary() string {
	return fmt.Sprintf("app-%x", time.Now().UnixNano())
}
