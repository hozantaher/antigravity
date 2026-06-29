package delivery

// imap_fetch.go — IMAP SEARCH UNSEEN + UID FETCH for inbound polling.
//
// Why this lives in services/relay and not services/orchestrator/imap:
// Same architectural reason as sent_appender.go — wgsocks bridges bind
// to 127.0.0.1:108x INSIDE the relay container. Any other Railway service
// dialing relay's loopback gets ECONNREFUSED (memory
// project_bff_imap_cross_service_broken). Co-locating IMAP poll with
// the working transport eliminates the cross-namespace gap.
//
// HTTP wrapper: services/relay/web/imap_fetch.go (POST /v1/imap-fetch)
// invokes FetchInboxHeaders with creds + UID watermark; returns parsed
// envelope headers. BFF's runImapPollCron calls the HTTP endpoint instead
// of dialing IMAP itself, and writes reply_inbox / outreach_messages
// downstream using existing pairing logic.
//
// Compliance:
//   - feedback_no_direct_smtp (HARD): every dial routes through
//     transport.AnonymousTransport.DialContext (wgsocks-aware).
//   - feedback_no_pii_in_commands: from/to/subject only echoed in the
//     HTTP response; never slog'd at info level. Errors slog'd with
//     mailbox label (operator already knows that PII).
//   - feedback_extreme_testing: companion imap_fetch_test.go (≥10 cases).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	"relay/internal/transport"
)

// FetchParams carries IMAP creds + the slice of state needed to do a
// single delta poll of an inbox.
type FetchParams struct {
	// MailboxAddress is the from_address column; used for slog labels.
	MailboxAddress string

	// IMAPHost / IMAPPort identify the IMAPS endpoint.
	IMAPHost string
	IMAPPort int

	// Username / Password — sender's IMAP credentials. Identical to the
	// SMTP creds in 99% of cases (same provider account).
	Username string
	Password string

	// Folder defaults to "INBOX" when empty.
	Folder string

	// SinceUID is the high-water-mark from the previous poll. The fetch
	// returns only UIDs > SinceUID (within the UNSEEN set). 0 means
	// "fetch all unseen" (first poll OR UIDVALIDITY changed).
	SinceUID uint32

	// Limit caps the number of messages returned in one call. Hard
	// upper bound 200 (server-side); 0 means default 50. When
	// IncludeBody is true, the upper bound drops to 30 because each
	// message can be hundreds of KB.
	Limit int

	// IncludeBody asks for the full raw RFC 5322 byte stream
	// (BODY.PEEK[]) in addition to the parsed header envelope.
	// Required by callers that pass the message into
	// orchestrator/thread.InboundProcessor.ProcessReply (MIME parsing
	// + attachment extraction). When false the fetch stays cheap and
	// only headers come back.
	IncludeBody bool
}

// FetchedMessage is the parsed envelope of one inbound IMAP message.
// RawBody is populated only when FetchParams.IncludeBody is true.
type FetchedMessage struct {
	UID        uint32 `json:"uid"`
	From       string `json:"from"`
	To         string `json:"to"`
	Subject    string `json:"subject"`
	Date       string `json:"date"`
	MessageID  string `json:"message_id"`
	InReplyTo  string `json:"in_reply_to"`
	References string `json:"references"`
	// RawBody is the full RFC 5322 byte stream (header + body) when
	// IncludeBody is requested. Empty otherwise. Wire format is base64
	// over JSON because the bytes can include arbitrary CTE-encoded
	// binary attachments. Caller decodes once.
	RawBody []byte `json:"raw_body,omitempty"`
}

// FetchResult is the typed return of FetchInboxHeaders.
type FetchResult struct {
	UIDValidity uint32           `json:"uid_validity"`
	UnseenTotal int              `json:"unseen_total"`
	Messages    []FetchedMessage `json:"messages"`
}

// ErrFetchNoIMAPCreds mirrors ErrNoIMAPCreds for the fetch path. Both
// surface the missing-config case to callers; tests assert on this
// sentinel.
var ErrFetchNoIMAPCreds = errors.New("delivery.FetchInboxHeaders: missing IMAP credentials")

// FetchInboxHeaders dials IMAP via the wgsocks-aware transport, runs
// LOGIN → SELECT → UID SEARCH UNSEEN → UID FETCH, and returns parsed
// envelope headers for each unseen message above the UID watermark.
// Best-effort body parsing is deliberately omitted — body is fetched
// separately when a reply is matched to a send_event downstream.
func FetchInboxHeaders(ctx context.Context, t transport.AnonymousTransport, p FetchParams) (FetchResult, error) {
	if p.IMAPHost == "" || p.IMAPPort == 0 || p.Username == "" || p.Password == "" {
		return FetchResult{}, ErrFetchNoIMAPCreds
	}
	if t == nil {
		return FetchResult{}, errors.New("delivery.FetchInboxHeaders: transport is nil")
	}
	folder := p.Folder
	if folder == "" {
		folder = "INBOX"
	}
	limit := p.Limit
	if limit <= 0 {
		limit = 50
	}
	// Body fetch is heavy — each message can be 50-500 KB and a 200-msg
	// batch easily overruns the 32 MB body cap on the HTTP wrapper.
	// Cap at 30 when body is requested.
	if p.IncludeBody && limit > 30 {
		limit = 30
	}
	if limit > 200 {
		limit = 200
	}

	addr := fmt.Sprintf("%s:%d", p.IMAPHost, p.IMAPPort)
	rawConn, err := t.DialContext(ctx, "tcp", addr)
	if err != nil {
		slog.Warn("imap fetch dial failed",
			"op", "delivery.FetchInboxHeaders/dialFail",
			"mailbox", p.MailboxAddress,
			"imap_addr", addr,
			"error", err)
		return FetchResult{}, fmt.Errorf("imap fetch dial: %w", err)
	}

	var conn net.Conn = rawConn
	if p.IMAPPort == 993 {
		tlsConn := tls.Client(rawConn, transport.SMTPParrotTLS(p.IMAPHost))
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = rawConn.Close()
			slog.Warn("imap fetch tls handshake failed",
				"op", "delivery.FetchInboxHeaders/tlsFail",
				"mailbox", p.MailboxAddress,
				"error", err)
			return FetchResult{}, fmt.Errorf("imap fetch tls: %w", err)
		}
		conn = tlsConn
	}
	defer conn.Close()

	// Greeting.
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return FetchResult{}, fmt.Errorf("set greeting deadline: %w", err)
	}
	if err := readUntagged(conn); err != nil {
		return FetchResult{}, fmt.Errorf("imap fetch greeting: %w", err)
	}

	// LOGIN. Same tag-isolation as sent_appender (A100..A103 reserved
	// there) — use B-prefix to avoid collision when the relay ever
	// stacks fetch + append on the same connection.
	if err := imapCommand(conn, "B100",
		fmt.Sprintf("LOGIN %s %s", quoteIMAPString(p.Username), quoteIMAPString(p.Password))); err != nil {
		slog.Warn("imap fetch login failed",
			"op", "delivery.FetchInboxHeaders/loginFail",
			"mailbox", p.MailboxAddress,
			"error", err)
		return FetchResult{}, fmt.Errorf("imap login: %w", err)
	}
	defer func() {
		_ = imapCommand(conn, "B199", "LOGOUT")
	}()

	// SELECT — capture UIDVALIDITY from untagged response. Use SELECT
	// (not EXAMINE) because we may want to ack \\Seen flag in a later
	// pass; harmless for read-only polling.
	uidValidity, selectErr := selectFolder(conn, folder)
	if selectErr != nil {
		slog.Warn("imap fetch select failed",
			"op", "delivery.FetchInboxHeaders/selectFail",
			"mailbox", p.MailboxAddress,
			"folder", folder,
			"error", selectErr)
		return FetchResult{}, fmt.Errorf("select %q: %w", folder, selectErr)
	}

	// UID SEARCH by watermark — returns ALL messages above SinceUID,
	// regardless of \\Seen flag. Operator dashboard pairs every inbound
	// with a send_event, not only those unread in webmail. `UNSEEN`
	// filter would silently lose messages the operator already opened
	// (Seznam webmail sets \\Seen on view; AppendToSent also writes
	// outbound copies as \\Seen).
	//
	// Server-side range query reduces wire load on large inboxes vs.
	// SEARCH ALL + client-side filtering. RFC 3501 §6.4.4 — UID range
	// "N:*" is "from N up to the largest UID in the folder".
	//
	// UnseenTotal field name kept for API stability but semantically
	// reports "messages above watermark" in this implementation.
	rangeStart := p.SinceUID + 1
	if p.SinceUID == 0 {
		// First poll or UIDVALIDITY reset — fetch every UID from 1.
		rangeStart = 1
	}
	allUIDs, searchErr := uidSearchRange(conn, rangeStart)
	if searchErr != nil {
		return FetchResult{UIDValidity: uidValidity}, fmt.Errorf("uid search: %w", searchErr)
	}

	// Server already filtered by watermark; just apply the limit cap.
	newUIDs := allUIDs
	if len(newUIDs) > limit {
		newUIDs = newUIDs[:limit]
	}

	if len(newUIDs) == 0 {
		return FetchResult{
			UIDValidity: uidValidity,
			UnseenTotal: len(allUIDs),
			Messages:    nil,
		}, nil
	}

	// UID FETCH. Two paths:
	//   - IncludeBody=false → BODY.PEEK[HEADER.FIELDS (...)] returns just
	//     parsed envelope fields (cheap; ~1-2 KB per msg)
	//   - IncludeBody=true  → BODY.PEEK[]  returns the full RFC 5322
	//     stream (50-500 KB per msg) so caller can run MIME parsing +
	//     attachment extraction downstream.
	var msgs []FetchedMessage
	var fetchErr error
	if p.IncludeBody {
		msgs, fetchErr = uidFetchFull(conn, newUIDs)
	} else {
		msgs, fetchErr = uidFetchHeaders(conn, newUIDs)
	}
	if fetchErr != nil {
		return FetchResult{
			UIDValidity: uidValidity,
			UnseenTotal: len(allUIDs),
		}, fmt.Errorf("uid fetch: %w", fetchErr)
	}

	slog.Info("imap fetch ok",
		"op", "delivery.FetchInboxHeaders/ok",
		"mailbox", p.MailboxAddress,
		"folder", folder,
		"uid_validity", uidValidity,
		"unseen_total", len(allUIDs),
		"returned", len(msgs))

	return FetchResult{
		UIDValidity: uidValidity,
		UnseenTotal: len(allUIDs),
		Messages:    msgs,
	}, nil
}

// selectFolder runs SELECT and parses the UIDVALIDITY from the response.
// IMAP SELECT response includes an untagged line like:
//
//	* OK [UIDVALIDITY 1404935089] UIDs valid
//
// before the tagged OK. We read the whole response buffer and grep for
// the bracketed UIDVALIDITY token.
func selectFolder(conn net.Conn, folder string) (uint32, error) {
	tag := "B101"
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return 0, fmt.Errorf("set write deadline: %w", err)
	}
	cmd := tag + " SELECT " + quoteIMAPString(folder) + "\r\n"
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return 0, fmt.Errorf("write SELECT: %w", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return 0, fmt.Errorf("set read deadline: %w", err)
	}
	var buf bytes.Buffer
	tmp := make([]byte, 4096)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0, fmt.Errorf("connection closed during SELECT")
			}
			return 0, fmt.Errorf("read SELECT: %w", err)
		}
		buf.Write(tmp[:n])
		raw := buf.Bytes()
		if bytes.Contains(raw, markerOK) {
			return parseUIDValidity(raw), nil
		}
		if bytes.Contains(raw, markerNO) || bytes.Contains(raw, markerBAD) {
			return 0, fmt.Errorf("imap rejected SELECT: %s", strings.TrimSpace(buf.String()))
		}
		// Safety cap on response buffer.
		if buf.Len() > 64*1024 {
			return 0, errors.New("SELECT response exceeded 64KB without tagged completion")
		}
	}
}

// parseUIDValidity scans for "[UIDVALIDITY N]" in the SELECT response
// and returns N. Returns 0 if the token is absent (some servers omit
// it, in which case the caller treats every poll as a first poll).
func parseUIDValidity(raw []byte) uint32 {
	const needle = "[UIDVALIDITY "
	idx := bytes.Index(raw, []byte(needle))
	if idx < 0 {
		return 0
	}
	tail := raw[idx+len(needle):]
	end := bytes.IndexByte(tail, ']')
	if end < 0 {
		return 0
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(tail[:end])), 10, 32)
	if err != nil {
		return 0
	}
	return uint32(v)
}

// uidSearchRange runs `UID SEARCH UID N:*` and parses the resulting
// "* SEARCH uid1 uid2 ..." untagged line. The range form filters
// server-side so a 50k-message inbox doesn't dump every UID over the
// wire on each poll. Pass rangeStart=1 to fetch everything.
func uidSearchRange(conn net.Conn, rangeStart uint32) ([]uint32, error) {
	tag := "B102"
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, fmt.Errorf("set write deadline: %w", err)
	}
	cmd := fmt.Sprintf("%s UID SEARCH UID %d:*\r\n", tag, rangeStart)
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("write UID SEARCH: %w", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return nil, fmt.Errorf("set read deadline: %w", err)
	}
	var buf bytes.Buffer
	tmp := make([]byte, 4096)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("connection closed during UID SEARCH")
			}
			return nil, fmt.Errorf("read UID SEARCH: %w", err)
		}
		buf.Write(tmp[:n])
		raw := buf.Bytes()
		if bytes.Contains(raw, markerOK) {
			return parseSearchUIDs(raw), nil
		}
		if bytes.Contains(raw, markerNO) || bytes.Contains(raw, markerBAD) {
			return nil, fmt.Errorf("imap rejected UID SEARCH: %s", strings.TrimSpace(buf.String()))
		}
		if buf.Len() > 256*1024 {
			return nil, errors.New("UID SEARCH response exceeded 256KB without tagged completion")
		}
	}
}

// parseSearchUIDs extracts UIDs from "* SEARCH n1 n2 ..." lines. There
// may be multiple SEARCH lines (some servers split long lists); we
// concatenate. Tokens that fail to parse as uint32 are silently
// dropped (defensive — servers do not emit garbage here in practice).
func parseSearchUIDs(raw []byte) []uint32 {
	var out []uint32
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	// Lines can be very long (thousands of UIDs); 1 MB buffer.
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		const prefix = "* SEARCH"
		idx := strings.Index(line, prefix)
		if idx < 0 {
			continue
		}
		fields := strings.Fields(line[idx+len(prefix):])
		for _, f := range fields {
			v, err := strconv.ParseUint(f, 10, 32)
			if err != nil {
				continue
			}
			out = append(out, uint32(v))
		}
	}
	return out
}

// uidFetchHeaders issues
//
//	UID FETCH <uid_list> BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)]
//
// and parses the response into FetchedMessage objects. BODY.PEEK avoids
// setting \\Seen flag — read-only poll discipline.
func uidFetchHeaders(conn net.Conn, uids []uint32) ([]FetchedMessage, error) {
	if len(uids) == 0 {
		return nil, nil
	}
	tag := "B103"
	uidList := make([]string, 0, len(uids))
	for _, u := range uids {
		uidList = append(uidList, strconv.FormatUint(uint64(u), 10))
	}
	cmd := fmt.Sprintf(
		"%s UID FETCH %s BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)]\r\n",
		tag, strings.Join(uidList, ","),
	)
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, fmt.Errorf("set write deadline: %w", err)
	}
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("write UID FETCH: %w", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(60 * time.Second)); err != nil {
		return nil, fmt.Errorf("set read deadline: %w", err)
	}

	var buf bytes.Buffer
	tmp := make([]byte, 8192)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("connection closed during UID FETCH")
			}
			return nil, fmt.Errorf("read UID FETCH: %w", err)
		}
		buf.Write(tmp[:n])
		raw := buf.Bytes()
		if bytes.Contains(raw, markerOK) {
			return parseFetchResponse(raw), nil
		}
		if bytes.Contains(raw, markerNO) || bytes.Contains(raw, markerBAD) {
			return nil, fmt.Errorf("imap rejected UID FETCH: %s", strings.TrimSpace(buf.String()))
		}
		// Total cap: 100 messages × ~2KB headers each = 200KB; 4MB safety.
		if buf.Len() > 4*1024*1024 {
			return nil, errors.New("UID FETCH response exceeded 4MB without tagged completion")
		}
	}
}

// parseFetchResponse parses one UID FETCH response buffer. Per-message
// chunks look like:
//
//	* 42 FETCH (UID 123 BODY[HEADER.FIELDS (...)] {123}
//	From: alice@example.com
//	Subject: Re: ...
//	...
//	)
//
// We walk the buffer scanning for each "* N FETCH (UID K BODY[..." line,
// extract the literal-size {N}, slurp exactly N bytes of headers, and
// then parse those headers as a standard RFC 5322 block.
func parseFetchResponse(raw []byte) []FetchedMessage {
	var out []FetchedMessage
	// Walk forward scanning for "FETCH (UID " markers.
	rest := raw
	for {
		idx := bytes.Index(rest, []byte("FETCH (UID "))
		if idx < 0 {
			break
		}
		// Parse the UID number after "FETCH (UID ".
		tail := rest[idx+len("FETCH (UID "):]
		uid, consumed := readDecimal(tail)
		if consumed == 0 {
			// Malformed; advance past this marker to avoid infinite loop.
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		// Find the literal "{N}" right after the BODY[...] tag.
		literalIdx := bytes.IndexByte(tail[consumed:], '{')
		if literalIdx < 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		literalStart := consumed + literalIdx + 1
		literalEnd := bytes.IndexByte(tail[literalStart:], '}')
		if literalEnd < 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		literalSize, err := strconv.Atoi(string(tail[literalStart : literalStart+literalEnd]))
		if err != nil || literalSize <= 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		// Skip past "}<CRLF>" then read literalSize bytes of headers.
		headerStart := literalStart + literalEnd + 1
		// Skip CRLF after }
		for headerStart < len(tail) && (tail[headerStart] == '\r' || tail[headerStart] == '\n') {
			headerStart++
		}
		if headerStart+literalSize > len(tail) {
			// Truncated; stop here so caller can either retry or report
			// partial state. We return what we have parsed so far.
			break
		}
		headers := tail[headerStart : headerStart+literalSize]
		msg := parseHeaders(uid, headers)
		out = append(out, msg)
		rest = tail[headerStart+literalSize:]
	}
	return out
}

// readDecimal scans leading decimal digits and returns the parsed value
// plus how many bytes were consumed. Returns (0, 0) if no digits found.
func readDecimal(b []byte) (uint32, int) {
	i := 0
	for i < len(b) && b[i] >= '0' && b[i] <= '9' {
		i++
	}
	if i == 0 {
		return 0, 0
	}
	v, err := strconv.ParseUint(string(b[:i]), 10, 32)
	if err != nil {
		return 0, 0
	}
	return uint32(v), i
}

// parseHeaders walks an RFC 5322 header block and pulls the fields we
// care about into a FetchedMessage. Folded continuation lines (RFC 5322
// §2.2.3 — leading whitespace) are unfolded into the previous field.
func parseHeaders(uid uint32, headers []byte) FetchedMessage {
	m := FetchedMessage{UID: uid}
	scanner := bufio.NewScanner(bytes.NewReader(headers))
	scanner.Buffer(make([]byte, 4096), 64*1024)

	var lastField *string
	commit := func(name, value string) {
		switch strings.ToLower(name) {
		case "from":
			m.From = value
			lastField = &m.From
		case "to":
			m.To = value
			lastField = &m.To
		case "subject":
			m.Subject = value
			lastField = &m.Subject
		case "date":
			m.Date = value
			lastField = &m.Date
		case "message-id":
			m.MessageID = value
			lastField = &m.MessageID
		case "in-reply-to":
			m.InReplyTo = value
			lastField = &m.InReplyTo
		case "references":
			m.References = value
			lastField = &m.References
		default:
			lastField = nil
		}
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break // end of header block
		}
		// Continuation line — RFC 5322 §2.2.3.
		if line[0] == ' ' || line[0] == '\t' {
			if lastField != nil {
				*lastField += " " + strings.TrimSpace(line)
			}
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			lastField = nil
			continue
		}
		name := strings.TrimSpace(line[:colon])
		value := strings.TrimSpace(line[colon+1:])
		commit(name, value)
	}
	return m
}

// uidFetchFull issues
//
//	UID FETCH <uid_list> BODY.PEEK[]
//
// and returns FetchedMessage with parsed header envelope plus the full
// raw RFC 5322 bytes. Heavier than uidFetchHeaders (50-500 KB per
// message instead of ~1-2 KB) — caller must cap the UID batch.
//
// Read deadline is generous (180s) because Seznam IMAP can spend ~15s
// streaming 500 KB attachments through the wgsocks → Mullvad → SMTP
// chain. The HTTP wrapper imposes its own 90s ceiling, so a stalled
// connection will be cancelled before this deadline fires; it's
// belt-and-suspenders.
func uidFetchFull(conn net.Conn, uids []uint32) ([]FetchedMessage, error) {
	if len(uids) == 0 {
		return nil, nil
	}
	tag := "B104"
	uidList := make([]string, 0, len(uids))
	for _, u := range uids {
		uidList = append(uidList, strconv.FormatUint(uint64(u), 10))
	}
	cmd := fmt.Sprintf("%s UID FETCH %s BODY.PEEK[]\r\n", tag, strings.Join(uidList, ","))
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, fmt.Errorf("set write deadline: %w", err)
	}
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("write UID FETCH BODY[]: %w", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(180 * time.Second)); err != nil {
		return nil, fmt.Errorf("set read deadline: %w", err)
	}

	var buf bytes.Buffer
	tmp := make([]byte, 32*1024)
	markerOK := []byte(tag + " OK")
	markerNO := []byte(tag + " NO")
	markerBAD := []byte(tag + " BAD")
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("connection closed during UID FETCH BODY[]")
			}
			return nil, fmt.Errorf("read UID FETCH BODY[]: %w", err)
		}
		buf.Write(tmp[:n])
		raw := buf.Bytes()
		// Cheap pre-check: tagged completion always lives at the tail.
		// Look only at the last 4 KB to avoid false-positives where
		// the literal payload happens to contain "<tag> OK" inside an
		// attachment.
		tail := raw
		if len(tail) > 4096 {
			tail = tail[len(tail)-4096:]
		}
		if bytes.Contains(tail, markerOK) {
			return parseFetchResponseWithBody(raw), nil
		}
		if bytes.Contains(tail, markerNO) || bytes.Contains(tail, markerBAD) {
			return nil, fmt.Errorf("imap rejected UID FETCH BODY[]: %s", strings.TrimSpace(string(tail)))
		}
		// Total cap: 30 messages × 1 MB safety = 30 MB; double that
		// for protocol overhead and slack.
		if buf.Len() > 64*1024*1024 {
			return nil, errors.New("UID FETCH BODY[] response exceeded 64MB without tagged completion")
		}
	}
}

// parseFetchResponseWithBody is the body-aware sibling of
// parseFetchResponse. Per-message chunks look the same:
//
//	* 42 FETCH (UID 123 BODY[] {15234}
//	From: alice@example.com
//	...
//	<full RFC 5322 stream>
//	)
//
// The only difference vs the header-only variant is the literal size is
// the full message, so we also stash a copy in FetchedMessage.RawBody
// AND run parseHeaders on the same buffer to populate the envelope
// fields. parseHeaders stops at the first blank line so it ignores the
// body payload that follows.
func parseFetchResponseWithBody(raw []byte) []FetchedMessage {
	var out []FetchedMessage
	rest := raw
	for {
		idx := bytes.Index(rest, []byte("FETCH (UID "))
		if idx < 0 {
			break
		}
		tail := rest[idx+len("FETCH (UID "):]
		uid, consumed := readDecimal(tail)
		if consumed == 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		// Find literal "{N}" after BODY[]
		literalIdx := bytes.IndexByte(tail[consumed:], '{')
		if literalIdx < 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		literalStart := consumed + literalIdx + 1
		literalEnd := bytes.IndexByte(tail[literalStart:], '}')
		if literalEnd < 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		literalSize, err := strconv.Atoi(string(tail[literalStart : literalStart+literalEnd]))
		if err != nil || literalSize <= 0 {
			rest = rest[idx+len("FETCH (UID "):]
			continue
		}
		// Skip past "}<CRLF>"
		bodyStart := literalStart + literalEnd + 1
		for bodyStart < len(tail) && (tail[bodyStart] == '\r' || tail[bodyStart] == '\n') {
			bodyStart++
		}
		if bodyStart+literalSize > len(tail) {
			// Truncated; stop here so what we already parsed survives.
			break
		}
		full := tail[bodyStart : bodyStart+literalSize]

		// Parse headers (parseHeaders stops at blank line, ignores body).
		msg := parseHeaders(uid, full)
		// Copy bytes — slice into 'tail' would alias the entire raw
		// buffer and prevent GC. Caller may keep the slice well past
		// this function's lifetime.
		msg.RawBody = make([]byte, literalSize)
		copy(msg.RawBody, full)
		out = append(out, msg)
		rest = tail[bodyStart+literalSize:]
	}
	return out
}
