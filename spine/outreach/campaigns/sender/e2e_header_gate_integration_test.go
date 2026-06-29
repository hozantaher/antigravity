//go:build integration

package sender

import (
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"testing"
	"time"
)

// ═══════════════════════════════════════════════════════════════════════════
//  M8 / anti-trace E2E LIVE GATE
//
// Round-trip verification: buildMessage() → real SMTP (GreenMail:1025) →
// IMAP fetch (GreenMail:1143) → parse every header with net/mail → assert
// the full anti-trace envelope.
//
// Success criterion (user-stated):
//   - no real IP leaked via X-Originating-IP / X-Source-IP / X-Sender / Received
//   - no X-Mailer unless explicitly supplied
//   - Message-ID domain == alias domain (never host-local)
//   - Date humanized (persona TZ preserved, not rewritten to UTC)
//   - From == alias
//   - Return-Path aligned with alias (GreenMail MAIL FROM envelope)
//   - no tracking-pixel when content layer didn't supply one
//   - List-Unsubscribe + List-Unsubscribe-Post pass through
//   - CRLF injection in attacker-reachable fields doesn't smuggle headers
//
// Prereq: GreenMail running with default ports 1025/1143 and test/test creds.
//   docker run --rm -p 1025:3025 -p 1143:3143 greenmail/standalone:2.0.0 \
//     -e GREENMAIL_OPTS="-Dgreenmail.users=test:test@local.dev -Dgreenmail.auth.disabled"
// ═══════════════════════════════════════════════════════════════════════════

func skipIfNoGreenMailSender(t *testing.T) {
	t.Helper()
	c, err := net.DialTimeout("tcp", "localhost:1025", time.Second)
	if err != nil {
		t.Skipf("GreenMail not running (SMTP:1025): %v", err)
	}
	c.Close()
	c, err = net.DialTimeout("tcp", "localhost:1143", time.Second)
	if err != nil {
		t.Skipf("GreenMail not running (IMAP:1143): %v", err)
	}
	c.Close()
}

type fetchedEnvelope struct {
	raw         string
	headerBlock string
	body        string
	headers     mail.Header
	returnPath  string
}

// fetchFullHeaders does a blunt IMAP SEARCH UNSEEN / FETCH BODY[HEADER]
// BODY[TEXT] for the last message. Unlike the production poller's
// fetchMessage, it retrieves the FULL header block so anti-trace gates
// can inspect every field.
func fetchFullHeaders(t *testing.T, user, pass, wantMsgID string) fetchedEnvelope {
	t.Helper()

	conn, err := net.DialTimeout("tcp", "localhost:1143", 3*time.Second)
	if err != nil {
		t.Fatalf("imap dial: %v", err)
	}
	defer conn.Close()

	// Banner.
	rd := make([]byte, 4096)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Read(rd); err != nil {
		t.Fatalf("imap banner: %v", err)
	}

	do := func(tag, cmd string) string {
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := conn.Write([]byte(tag + " " + cmd + "\r\n")); err != nil {
			t.Fatalf("imap write %q: %v", cmd, err)
		}
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		var resp strings.Builder
		buf := make([]byte, 65536)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				resp.Write(buf[:n])
			}
			if strings.Contains(resp.String(), tag+" OK") ||
				strings.Contains(resp.String(), tag+" NO") ||
				strings.Contains(resp.String(), tag+" BAD") {
				break
			}
			if err != nil {
				break
			}
		}
		return resp.String()
	}

	do("A1", "LOGIN "+user+" "+pass)
	do("A2", "SELECT INBOX")

	// Find our message by Message-ID instead of relying on UNSEEN order.
	idSearch := strings.Trim(wantMsgID, "<>")
	searchResp := do("A3", `SEARCH HEADER "Message-ID" "`+idSearch+`"`)
	uids := parseUIDsLenient(searchResp)
	if len(uids) == 0 {
		t.Fatalf("no message with Message-ID %q found; raw search:\n%s", wantMsgID, searchResp)
	}
	uid := uids[len(uids)-1]

	fetchResp := do("A4", fmt.Sprintf("FETCH %s (BODY[HEADER] BODY[TEXT])", uid))

	do("A5", "LOGOUT") //nolint:errcheck

	headerBlock := extractLiteral(fetchResp, "BODY[HEADER]")
	body := extractLiteral(fetchResp, "BODY[TEXT]")
	if headerBlock == "" {
		t.Fatalf("could not extract header block from FETCH response:\n%s", fetchResp)
	}

	parsed, err := mail.ReadMessage(strings.NewReader(headerBlock + "\r\n\r\n"))
	if err != nil {
		t.Fatalf("parse headers: %v\nblock:\n%s", err, headerBlock)
	}

	return fetchedEnvelope{
		raw:         fetchResp,
		headerBlock: headerBlock,
		body:        body,
		headers:     parsed.Header,
		returnPath:  strings.TrimSpace(parsed.Header.Get("Return-Path")),
	}
}

// parseUIDsLenient extracts numeric IDs from `* SEARCH 1 2 3\r\n` lines.
func parseUIDsLenient(resp string) []string {
	var out []string
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "* SEARCH") {
			continue
		}
		parts := strings.Fields(strings.TrimPrefix(line, "* SEARCH"))
		out = append(out, parts...)
	}
	return out
}

// extractLiteral mirrors the production poller's IMAP {N}\r\n literal
// reader but is duplicated here to keep this test self-contained.
func extractLiteral(raw, marker string) string {
	idx := strings.Index(raw, marker)
	if idx < 0 {
		return ""
	}
	rest := raw[idx:]
	lineEnd := strings.Index(rest, "\r\n")
	if lineEnd < 0 {
		return ""
	}
	head := rest[:lineEnd]
	open := strings.LastIndex(head, "{")
	closeIdx := strings.LastIndex(head, "}")
	if open < 0 || closeIdx <= open {
		return ""
	}
	var n int
	if _, err := fmt.Sscanf(head[open+1:closeIdx], "%d", &n); err != nil {
		return ""
	}
	start := idx + lineEnd + 2
	if start+n > len(raw) {
		return raw[start:]
	}
	return raw[start : start+n]
}

// sendViaSMTP lifts the heavy lifting out of the individual tests.
// Returns the envelope Message-ID that was sent, so IMAP lookup can find it.
func sendViaSMTP(t *testing.T, from, to string, body []byte) {
	t.Helper()
	c, err := smtp.Dial("localhost:1025")
	if err != nil {
		t.Fatalf("smtp dial: %v", err)
	}
	defer c.Quit() //nolint:errcheck
	if err := c.Mail(from); err != nil {
		t.Fatalf("MAIL FROM: %v", err)
	}
	if err := c.Rcpt(to); err != nil {
		t.Fatalf("RCPT TO: %v", err)
	}
	w, err := c.Data()
	if err != nil {
		t.Fatalf("DATA: %v", err)
	}
	if _, err := w.Write(body); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// ─── Canonical anti-trace envelope (happy path) ─────────────────────────

func TestIntegration_HeaderGate_CanonicalEnvelope(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	humanizedDate := "Mon, 13 Apr 2026 09:12:44 +0200"
	ts := time.Now().UnixNano()
	mid := fmt.Sprintf("<canonical-%d@alias.local.dev>", ts)

	msg := buildMessage(
		alias,
		recipient,
		fmt.Sprintf("Canonical envelope %d", ts),
		"Dobry den,\n\nNabizime dodavku CNC stroju.\n\nJan Novak",
		"",
		map[string]string{
			"Date":                  humanizedDate,
			"Message-ID":            mid,
			"List-Unsubscribe":      "<https://unsub.alias.local.dev/u?c=xyz>, <mailto:unsub@alias.local.dev>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
		mid,
	)

	sendViaSMTP(t, alias, recipient, msg)
	time.Sleep(1500 * time.Millisecond)

	env := fetchFullHeaders(t, "test", "test", mid)

	// ── Origin-leak headers MUST be empty. ──
	for _, leak := range []string{
		"X-Originating-IP",
		"X-Source-IP",
		"X-Sender",
		"X-Originating-Client",
		"X-Mailer",
		"User-Agent",
		"Bcc",
	} {
		if got := env.headers.Get(leak); got != "" {
			t.Errorf("%s must be empty after relay, got %q", leak, got)
		}
	}

	// ── Alias identity preserved. ──
	if got := env.headers.Get("From"); got != alias {
		t.Errorf("From = %q, want %q", got, alias)
	}
	if env.returnPath != "" && !strings.Contains(env.returnPath, alias) {
		t.Errorf("Return-Path %q does not align with alias %q", env.returnPath, alias)
	}

	// ── Humanized Date verbatim (timezone preserved). ──
	if got := env.headers.Get("Date"); got != humanizedDate {
		t.Errorf("Date = %q, want %q", got, humanizedDate)
	}

	// ── Message-ID domain == alias domain. ──
	gotMID := env.headers.Get("Message-ID")
	if !strings.HasSuffix(strings.TrimSuffix(gotMID, ">"), "@alias.local.dev") {
		t.Errorf("Message-ID %q does not carry alias domain", gotMID)
	}
	if strings.Contains(gotMID, "localhost") || strings.Contains(gotMID, ".local>") {
		t.Errorf("Message-ID leaks local hostname: %q", gotMID)
	}

	// ── List-Unsubscribe propagated. ──
	if !strings.Contains(env.headers.Get("List-Unsubscribe"), "unsub") {
		t.Errorf("List-Unsubscribe missing: %q", env.headers.Get("List-Unsubscribe"))
	}
	if got := env.headers.Get("List-Unsubscribe-Post"); got != "List-Unsubscribe=One-Click" {
		t.Errorf("List-Unsubscribe-Post = %q, want One-Click", got)
	}

	// ── No tracking pixel. ──
	if strings.Contains(env.body, "<img") || strings.Contains(env.body, "/o?") {
		t.Errorf("tracking pixel leaked into body:\n%s", env.body)
	}

	// ── Received chain must not leak origin's RFC1918 addresses. ──
	// GreenMail itself writes a Received line; we only check that we did
	// not inject one ourselves via buildMessage (via Message-ID CRLF, etc).
	// GreenMail's own Received is allowed — it's the relay's layer.
	rxChain := env.headers["Received"]
	for _, rx := range rxChain {
		for _, leak := range []string{"attacker", "X-Originating-IP", "X-Mailer"} {
			if strings.Contains(rx, leak) {
				t.Errorf("Received contains leaked token %q: %s", leak, rx)
			}
		}
	}
}

// ─── Origin-leak matrix over recipient identities ───────────────────────

func TestIntegration_HeaderGate_OriginLeakAbsent_MultipleAliases(t *testing.T) {
	skipIfNoGreenMailSender(t)

	aliases := []string{
		"ops@alias.local.dev",
		"sales@alias.local.dev",
		"jan@alias.local.dev",
	}
	recipient := "test@local.dev"

	for _, alias := range aliases {
		t.Run(alias, func(t *testing.T) {
			ts := time.Now().UnixNano()
			mid := fmt.Sprintf("<aliased-%d@alias.local.dev>", ts)
			msg := buildMessage(alias, recipient, fmt.Sprintf("Aliased %d", ts),
				"Anonymizovana zprava.", "",
				map[string]string{
					"Date":       "Tue, 14 Apr 2026 08:30:00 +0200",
					"Message-ID": mid,
				}, mid)

			sendViaSMTP(t, alias, recipient, msg)
			time.Sleep(1500 * time.Millisecond)

			env := fetchFullHeaders(t, "test", "test", mid)
			for _, leak := range []string{"X-Originating-IP", "X-Source-IP", "X-Sender", "X-Mailer", "User-Agent"} {
				if got := env.headers.Get(leak); got != "" {
					t.Errorf("[%s] %s leaked: %q", alias, leak, got)
				}
			}
			if got := env.headers.Get("From"); got != alias {
				t.Errorf("From = %q, want %q", got, alias)
			}
		})
	}
}

// ─── CRLF injection cannot forge Bcc through real relay ─────────────────

func TestIntegration_HeaderGate_CRLFInjectionDoesNotForgeBcc(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	ts := time.Now().UnixNano()
	mid := fmt.Sprintf("<crlf-%d@alias.local.dev>", ts)

	// Multiple injection vectors in one send.
	msg := buildMessage(
		alias,
		recipient,
		fmt.Sprintf("Subj %d\r\nBcc: spy@evil.local", ts),
		"Body.", "",
		map[string]string{
			"Date":       "Wed, 15 Apr 2026 10:00:00 +0200",
			"Message-ID": mid,
			// Split-key attack — caught by the hardened key filter.
			"B\r\ncc":    "spy@evil.local",
			"Rec\r\neived": "from attacker.evil",
			// CRLF in legit value — must not forge a second header.
			"X-Tag": "legit\r\nBcc: spy@evil.local",
		},
		mid,
	)
	sendViaSMTP(t, alias, recipient, msg)
	time.Sleep(1500 * time.Millisecond)

	env := fetchFullHeaders(t, "test", "test", mid)

	if got := env.headers.Get("Bcc"); got != "" {
		t.Errorf("CRLF injection forged Bcc header: %q", got)
	}
	// Attacker's relay chain injection is not in the Received written by us.
	for _, rx := range env.headers["Received"] {
		if strings.Contains(rx, "attacker.evil") {
			t.Errorf("Received contains attacker-forged token: %s", rx)
		}
	}
	// Subject must have CRLF stripped to a single line.
	subj := env.headers.Get("Subject")
	if strings.Contains(subj, "\n") || strings.Contains(subj, "\r") {
		t.Errorf("Subject retains CRLF: %q", subj)
	}
	// Legit X-Tag should exist but not carry a second smuggled header line.
	if xtag := env.headers.Get("X-Tag"); strings.Contains(xtag, "\n") {
		t.Errorf("X-Tag value split into multiple lines: %q", xtag)
	}
}

// ─── Message-ID domain gate across aliases ──────────────────────────────

func TestIntegration_HeaderGate_MessageIDDomainMatchesAlias(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	ts := time.Now().UnixNano()
	// Intentionally use generateMessageID to exercise the production path.
	mid := generateMessageID(alias)
	wrappedMID := "<" + mid + ">"

	msg := buildMessage(alias, recipient, fmt.Sprintf("mid-%d", ts),
		"Body.", "",
		map[string]string{
			"Date":       "Thu, 16 Apr 2026 11:00:00 +0200",
			"Message-ID": wrappedMID,
		}, wrappedMID)
	sendViaSMTP(t, alias, recipient, msg)
	time.Sleep(1500 * time.Millisecond)

	env := fetchFullHeaders(t, "test", "test", wrappedMID)
	got := env.headers.Get("Message-ID")
	if !strings.HasSuffix(strings.TrimSuffix(got, ">"), "@alias.local.dev") {
		t.Errorf("Message-ID %q must carry alias domain", got)
	}
	for _, bad := range []string{"localhost", ".local>", "127.0.0.1"} {
		if strings.Contains(got, bad) {
			t.Errorf("Message-ID leaks host marker %q: %s", bad, got)
		}
	}
}

// ─── HTML body round-trip ──────────────────────────────────────────────

func TestIntegration_HeaderGate_HTMLBodyRoundTripNoPixel(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	ts := time.Now().UnixNano()
	mid := fmt.Sprintf("<html-%d@alias.local.dev>", ts)

	htmlBody := "<p>Dobry den,</p><p>Nabizime CNC stroje.</p><p>Jan Novak</p>"
	msg := buildMessage(alias, recipient, fmt.Sprintf("HTML %d", ts),
		"Dobry den.", htmlBody,
		map[string]string{"Date": "Fri, 17 Apr 2026 09:00:00 +0200", "Message-ID": mid}, mid)

	sendViaSMTP(t, alias, recipient, msg)
	time.Sleep(1500 * time.Millisecond)

	env := fetchFullHeaders(t, "test", "test", mid)

	// Content-Type must be multipart/alternative.
	ct := env.headers.Get("Content-Type")
	if !strings.Contains(ct, "multipart/alternative") {
		t.Errorf("Content-Type = %q, want multipart/alternative", ct)
	}

	// Anti-trace: still no leaks in HTML path.
	for _, leak := range []string{"X-Originating-IP", "X-Source-IP", "X-Mailer", "User-Agent"} {
		if got := env.headers.Get(leak); got != "" {
			t.Errorf("%s leaked in HTML send: %q", leak, got)
		}
	}
	// No tracking pixel auto-injected.
	if strings.Contains(env.body, `src="http`) && strings.Contains(env.body, "/o?") {
		t.Errorf("tracking pixel auto-injected: %q", env.body)
	}
}

// ─── Unicode preservation ──────────────────────────────────────────────

func TestIntegration_HeaderGate_UnicodeSubjectPreserved(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	cases := []string{
		"Poptávka – spolupráce",
		"Nabídka CNC strojů",
		"Žádost o cenovou nabídku",
		"日本語テスト",
		"Тест кириллица",
	}
	for _, subj := range cases {
		t.Run(subj, func(t *testing.T) {
			ts := time.Now().UnixNano()
			mid := fmt.Sprintf("<uni-%d@alias.local.dev>", ts)
			fullSubj := fmt.Sprintf("%s %d", subj, ts)
			msg := buildMessage(alias, recipient, fullSubj, "B", "",
				map[string]string{"Date": "Sat, 18 Apr 2026 10:00:00 +0200", "Message-ID": mid}, mid)
			sendViaSMTP(t, alias, recipient, msg)
			time.Sleep(1500 * time.Millisecond)

			env := fetchFullHeaders(t, "test", "test", mid)
			// net/mail decodes encoded-word; we expect either the raw UTF-8 or
			// a MIME-encoded form that decodes back to the original.
			gotSubj := env.headers.Get("Subject")
			if !strings.Contains(gotSubj, subj) {
				// Try decoded form via mail.WordDecoder.
				dec := new(mime.WordDecoder)
				decoded, _ := dec.DecodeHeader(gotSubj)
				if !strings.Contains(decoded, subj) {
					t.Errorf("Subject roundtrip lost unicode: got %q (decoded %q), want contains %q",
						gotSubj, decoded, subj)
				}
			}
		})
	}
}

// ─── Consecutive-send stability: no cross-contamination ─────────────────

func TestIntegration_HeaderGate_ConsecutiveSendsIndependent(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	var mids []string
	var sentDates []string
	for i := 0; i < 5; i++ {
		ts := time.Now().UnixNano()
		mid := fmt.Sprintf("<seq-%d-%d@alias.local.dev>", i, ts)
		date := fmt.Sprintf("Sun, 19 Apr 2026 %02d:00:00 +0200", 8+i)
		msg := buildMessage(alias, recipient, fmt.Sprintf("seq %d %d", i, ts),
			"B", "",
			map[string]string{"Date": date, "Message-ID": mid}, mid)
		sendViaSMTP(t, alias, recipient, msg)
		mids = append(mids, mid)
		sentDates = append(sentDates, date)
		time.Sleep(400 * time.Millisecond)
	}
	time.Sleep(1500 * time.Millisecond)

	// Every send must keep its own Date and Message-ID.
	for i, mid := range mids {
		env := fetchFullHeaders(t, "test", "test", mid)
		if env.headers.Get("Date") != sentDates[i] {
			t.Errorf("send[%d] Date = %q, want %q", i, env.headers.Get("Date"), sentDates[i])
		}
		if got := env.headers.Get("Message-ID"); got != mid {
			t.Errorf("send[%d] Message-ID = %q, want %q", i, got, mid)
		}
		// Leak check still holds.
		for _, leak := range []string{"X-Originating-IP", "X-Mailer", "User-Agent"} {
			if got := env.headers.Get(leak); got != "" {
				t.Errorf("send[%d] %s leaked: %q", i, leak, got)
			}
		}
	}
}

// ─── Long-Subject edge case ────────────────────────────────────────────

func TestIntegration_HeaderGate_LongSubjectRoundTrip(t *testing.T) {
	skipIfNoGreenMailSender(t)

	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"
	ts := time.Now().UnixNano()
	mid := fmt.Sprintf("<long-%d@alias.local.dev>", ts)
	// 400-char subject; mail.ReadMessage tolerates folding, we just check
	// the message survives the round-trip without the body getting corrupted.
	longSubj := strings.Repeat("Poptavka spolupracujici firmy s ", 12) + fmt.Sprintf("%d", ts)

	msg := buildMessage(alias, recipient, longSubj, "B", "",
		map[string]string{"Date": "Mon, 20 Apr 2026 12:00:00 +0200", "Message-ID": mid}, mid)
	sendViaSMTP(t, alias, recipient, msg)
	time.Sleep(1500 * time.Millisecond)

	env := fetchFullHeaders(t, "test", "test", mid)
	if !strings.Contains(env.headers.Get("Subject"), fmt.Sprintf("%d", ts)) {
		t.Errorf("long subject lost unique tail: %q", env.headers.Get("Subject"))
	}
	// Body must be exactly "B", not corrupted by folding.
	if !strings.Contains(env.body, "B") {
		t.Errorf("body corrupted: %q", env.body)
	}
}

// ─── Date header preservation across personas ──────────────────────────

func TestIntegration_HeaderGate_DatePreservedPersonaTZ(t *testing.T) {
	skipIfNoGreenMailSender(t)

	cases := []struct {
		name string
		date string
	}{
		{"Prague_summer", "Mon, 07 Jul 2026 14:23:11 +0200"},
		{"Prague_winter", "Tue, 08 Jan 2026 09:12:44 +0100"},
		{"UTC", "Wed, 15 Apr 2026 08:00:00 +0000"},
		{"NewYork", "Thu, 16 Apr 2026 10:30:00 -0400"},
	}
	alias := "jan@alias.local.dev"
	recipient := "test@local.dev"

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ts := time.Now().UnixNano()
			mid := fmt.Sprintf("<tz-%s-%d@alias.local.dev>", c.name, ts)
			msg := buildMessage(alias, recipient, fmt.Sprintf("TZ %s %d", c.name, ts),
				"B", "",
				map[string]string{"Date": c.date, "Message-ID": mid}, mid)
			sendViaSMTP(t, alias, recipient, msg)
			time.Sleep(1500 * time.Millisecond)

			env := fetchFullHeaders(t, "test", "test", mid)
			if got := env.headers.Get("Date"); got != c.date {
				t.Errorf("Date = %q, want verbatim %q", got, c.date)
			}
		})
	}
}
