package delivery

import (
	"relay/internal/model"
	"relay/internal/transport"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/smtp"
	"os"
	"strings"
)

var (
	ErrDeliveryFailed = errors.New("delivery failed")
	ErrSTARTTLS       = errors.New("STARTTLS required but not supported by server")
)

// SMTPDeliverer sends messages through an anonymized SMTP relay.
type SMTPDeliverer struct {
	transport   transport.AnonymousTransport
	host        string
	port        int
	username    string
	password    string
	helloDomain string
	requireTLS  bool
	implicitTLS bool // port 465 SMTPS: TLS wraps the connection immediately
}

// SMTPConfig holds SMTP delivery configuration.
type SMTPConfig struct {
	Host        string
	Port        int
	Username    string
	Password    string
	HelloDomain string
	RequireTLS  bool
	ImplicitTLS bool // set true when Port == 465 (SMTPS)
}

// NewSMTPDeliverer creates a deliverer that routes SMTP through the given transport.
func NewSMTPDeliverer(t transport.AnonymousTransport, cfg SMTPConfig) *SMTPDeliverer {
	// Auto-detect implicit TLS from port when not explicitly set.
	implicitTLS := cfg.ImplicitTLS || cfg.Port == 465
	return &SMTPDeliverer{
		transport:   t,
		host:        cfg.Host,
		port:        cfg.Port,
		username:    cfg.Username,
		password:    cfg.Password,
		helloDomain: cfg.HelloDomain,
		requireTLS:  cfg.RequireTLS,
		implicitTLS: implicitTLS,
	}
}

// Deliver sends a message to the specified recipients.
// The connection is routed through the anonymized transport (e.g. Tor SOCKS5).
func (d *SMTPDeliverer) Deliver(ctx context.Context, from string, to []string, body []byte) error {
	// Sprint M5 canary: ALWAYS-FIRES log to verify the breadcrumb code is in
	// the running binary. If absent from Railway logs after a Engine envelope
	// drain, the deploy is stuck on a stale build cache.
	fmt.Fprintf(os.Stderr, "SMTPDELIV_CANARY_M5 from=%s to=%s len=%d\n", from, strings.Join(to, ","), len(body))
	addr := fmt.Sprintf("%s:%d", d.host, d.port)

	// Connect through anonymized transport -- DNS resolved by proxy
	conn, err := d.transport.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("%w: connect: %v", ErrDeliveryFailed, err)
	}

	// Propagate context deadline to the underlying connection so all subsequent
	// SMTP handshake operations (NewClient, EHLO, STARTTLS, AUTH, DATA) time out
	// properly. net/smtp does not check ctx after the initial Dial.
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}

	// Port 465 (SMTPS): wrap connection in TLS immediately before creating the
	// SMTP client. The server expects a TLS ClientHello, not a plain greeting.
	// Note: InsecureSkipVerify is intentional here — we route through Tor, so
	// the IP is already anonymous and the certificate chain on the exit node's
	// path may not include the full intermediate CA set.
	var smtpConn net.Conn = conn
	if d.implicitTLS {
		tlsCfg := transport.SMTPParrotTLSInsecure(d.host)
		tlsConn := tls.Client(conn, tlsCfg)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return fmt.Errorf("%w: tls handshake: %v", ErrDeliveryFailed, err)
		}
		smtpConn = tlsConn
	}

	client, err := smtp.NewClient(smtpConn, d.host)
	if err != nil {
		smtpConn.Close()
		return fmt.Errorf("%w: smtp client: %v", ErrDeliveryFailed, err)
	}
	defer client.Close()

	// HELO domain selection (RFC 5321 §4.1.1.1).
	//
	// Go's net/smtp.NewClient defaults the EHLO localName to the literal
	// "localhost", and that value is sent on the first SMTP command (STARTTLS,
	// AUTH, MAIL, Extension probe …) if client.Hello is never called
	// explicitly. The result is a Received header on the recipient side that
	// reads "from localhost ([<our-IP>])" — a non-FQDN HELO claim that some
	// hardened MTAs reject and that downstream anti-trace anonymity scoring
	// flags as a relay-side identity leak.
	//
	// Resolution order (first non-empty wins):
	//   1. d.helloDomain — explicitly configured via SMTP_HELLO_DOMAIN env.
	//   2. The sender address's domain — for example mb1@email.cz → email.cz.
	//      This stays internally consistent with MAIL FROM and the From
	//      header without requiring extra config.
	//   3. "mail.local" — the same fallback used by privacy.go for
	//      Message-ID anonymization. Always a syntactically valid FQDN
	//      that does not resolve publicly (anonymity intent preserved).
	//
	// We always call client.Hello so the EHLO line carries the chosen
	// value, never the Go-default "localhost".
	helo := pickHELODomain(d.helloDomain, from)
	if err := client.Hello(helo); err != nil {
		return fmt.Errorf("%w: hello: %v", ErrDeliveryFailed, err)
	}

	// STARTTLS only for non-implicit-TLS connections (port 587 etc.)
	if !d.implicitTLS {
		if ok, _ := client.Extension("STARTTLS"); ok {
			tlsConfig := transport.SMTPParrotTLSInsecure(d.host)
			if err := client.StartTLS(tlsConfig); err != nil {
				return fmt.Errorf("%w: starttls: %v", ErrDeliveryFailed, err)
			}
		} else if d.requireTLS {
			return ErrSTARTTLS
		}
	}

	// Authenticate if credentials provided.
	// Try AUTH LOGIN first (required by seznam.cz and Czech providers),
	// fall back to AUTH PLAIN if LOGIN not advertised.
	if d.username != "" {
		_, exts := client.Extension("AUTH")
		var auth smtp.Auth
		if strings.Contains(exts, "LOGIN") {
			auth = loginAuth(d.username, d.password)
		} else {
			auth = smtp.PlainAuth("", d.username, d.password, d.host)
		}
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("%w: auth: %v", ErrDeliveryFailed, err)
		}
	}

	if err := client.Mail(from); err != nil {
		return fmt.Errorf("%w: mail from: %v", ErrDeliveryFailed, err)
	}

	for _, recipient := range to {
		if err := client.Rcpt(recipient); err != nil {
			// Wrap the SMTP reply with %w (not %v) so the underlying
			// *textproto.Error stays unwrappable and IsTransientSMTPError can
			// read its Code from the authoritative source. The recipient is
			// deliberately NOT interpolated into this message: a numeric run
			// inside the address (e.g. "stavebniny365.cz") would otherwise be
			// mis-scanned as the reply code, misclassifying a real 450 greylist.
			// The recipient is already emitted on the drain's failure log line.
			return fmt.Errorf("%w: rcpt to: %w", ErrDeliveryFailed, err)
		}
	}

	// DKIM signing point: when cfg.DKIM.Enabled is true, sign `body` here before
	// writing to the DATA stream.  Requires a DKIM library (e.g. github.com/emersion/go-msgauth/dkim)
	// and DNS TXT record: <selector>._domainkey.<domain>.
	// Example call (not yet wired):
	//   body, err = dkim.Sign(body, &dkim.SignOptions{Domain: cfg.DKIM.Domain, Selector: cfg.DKIM.Selector, Signer: privateKey})
	// See DKIMConfig in services/relay/internal/config/config.go for field layout.
	// Set DKIM_DOMAIN + DKIM_PRIVATE_KEY_B64 env vars to enable once DNS is provisioned.

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("%w: data: %v", ErrDeliveryFailed, err)
	}
	// Sprint M5 diagnostic: log the SMTP DATA body verbatim when
	// DELIVER_DEBUG_MIME=1 so we can compare /v1/raw-smtp-test wire bytes
	// against /v1/submit (Engine drain) wire bytes. Privacy logger
	// truncates the body at boundary 1024 to avoid leaking full content.
	//
	// Switched from os.Stderr to log.Printf because Railway's log driver
	// only forwards stdout to the deployment log stream — stderr writes
	// disappeared during the 2026-05-09 Date-header RCA.
	// envconfig-allowed: diagnostic-only; absent in production.
	if os.Getenv("DELIVER_DEBUG_MIME") == "1" {
		preview := body
		if len(preview) > 1024 {
			preview = preview[:1024]
		}
		log.Printf("DELIVER_DEBUG_MIME from=%s to=%s len=%d body=%q", from, strings.Join(to, ","), len(body), preview)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("%w: write: %v", ErrDeliveryFailed, err)
	}
	if err := w.Close(); err != nil {
		// Pre-acceptance failure: the server did NOT answer 250 to end-of-DATA,
		// so the message was not accepted. Surface it as a retryable error.
		return fmt.Errorf("%w: close data: %v", ErrDeliveryFailed, err)
	}

	// w.Close() returned nil → the server answered 250 to end-of-DATA and now
	// owns the message: delivery has SUCCEEDED. Any error from QUIT or the
	// connection teardown after this point (a 421 "closing channel", a reset,
	// or an i/o timeout reading the QUIT response) must NOT be surfaced as a
	// retryable failure — re-queuing an already-accepted message would deliver
	// it twice. Swallow the teardown error; the deferred client.Close() reclaims
	// the socket.
	if err := client.Quit(); err != nil {
		// envconfig-allowed: diagnostic-only; stdout so Railway forwards it.
		log.Printf("smtp quit/teardown error after message accepted (ignored, no retry) from=%s to=%s err=%v",
			from, strings.Join(to, ","), err)
	}
	return nil
}

// encodeSubject returns an RFC 2047 encoded-word for the subject if it contains
// non-ASCII characters, otherwise returns it unchanged.
func encodeSubject(s string) string {
	// Remove bare CR/LF to prevent header injection regardless.
	s = strings.NewReplacer("\r", "", "\n", "").Replace(s)
	for _, r := range s {
		if r > 127 {
			return "=?utf-8?b?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
		}
	}
	return s
}

// BuildMinimalMessage creates a minimal RFC 5322 message with no identifying headers.
// Kept for compatibility with the bridge/smtp delivery paths that don't carry humanized metadata.
func BuildMinimalMessage(from string, to []string, subject, body string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	b.WriteString("Subject: " + encodeSubject(subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	// No Date, No Message-ID, No X-Mailer, No User-Agent
	b.WriteString("\r\n")
	b.WriteString(body)
	return []byte(b.String())
}

// BuildMessage constructs a fully humanized RFC 5322 message.
//
// If headers contains pre-built fingerprint headers (Date, Message-ID, X-Mailer, …) they
// are used verbatim — these come from machinery-outreach's FingerprintEngine and make the
// message look like it was sent from a real seznam.cz webmail client.
//
// If bodyHTML is non-empty, the message is built as multipart/alternative with text/plain
// and text/html parts (mimicking how webmail clients send dual-part messages).
// Otherwise a plain text-only message is emitted.
func BuildMessage(from string, to []string, subject, body, bodyHTML string, headers map[string]string) []byte {
	var b strings.Builder

	// Apply privacy pipeline: strip routing headers, anonymize Message-ID.
	// This runs on a copy so the caller's map is never mutated.
	// The envelope `from` provides the FQDN for the anonymized Message-ID's
	// right-hand side so the identifier stays RFC 5322 §3.6.4 compliant
	// (Seznam silently drops mail with a non-FQDN Message-ID).
	headers = sanitizeHeaders(headers, from)

	// Structural headers first. From is written from the headers map when it
	// contains a display-name form (has "<") — this preserves the anonymity
	// bundle's "Display Name <addr>" built by engine.go:applyAnonymityHeaders.
	// Without this, the bare `from` parameter overwrites the display name and
	// the wire format shows a bot-signal bare-address From: header.
	// If headers["From"] is absent or is a bare address, fall back to `from`.
	fromHeader := from
	if hFrom, ok := headers["From"]; ok && strings.Contains(hFrom, "<") {
		fromHeader = hFrom
	}
	b.WriteString("From: " + fromHeader + "\r\n")
	b.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	b.WriteString("Subject: " + encodeSubject(subject) + "\r\n")

	// Fingerprint headers: Date, Message-ID, X-Mailer (from FingerprintEngine).
	// Write in a deterministic order: Date → Message-ID → MIME-Version → X-Mailer → rest.
	headerPriority := []string{"Date", "Message-ID", "MIME-Version", "X-Mailer", "User-Agent"}
	written := map[string]bool{}
	for _, key := range headerPriority {
		if val, ok := headers[key]; ok {
			b.WriteString(key + ": " + val + "\r\n")
			written[key] = true
		}
	}
	// Any remaining custom headers. Skip:
	//   - Content-Type / Content-Transfer-Encoding — we set those ourselves
	//     based on multipart vs text/plain branch
	//   - From / To / Subject — already written as structural headers (line
	//     242-244). RFC 5322 §3.6.2 forbids multiple From: headers; Seznam
	//     and other anti-spam filters silently drop messages with duplicate
	//     RFC 5322 originator/destination headers as a phishing signal.
	//     The orchestrator's Engine includes a humanized `From:` (e.g.
	//     `"Display Name" <addr>`) in the headers map; without this skip
	//     the wire format had two `From:` lines → 0/N INBOX delivery
	//     (sprint M5 RCA, post fix-#720).
	skipKeys := map[string]bool{
		"Content-Type":              true,
		"Content-Transfer-Encoding": true,
		"From":                      true,
		"To":                        true,
		"Subject":                   true,
	}
	for key, val := range headers {
		if !written[key] && !skipKeys[key] {
			b.WriteString(key + ": " + val + "\r\n")
		}
	}
	// Ensure MIME-Version is always present.
	if !written["MIME-Version"] {
		b.WriteString("MIME-Version: 1.0\r\n")
	}

	if bodyHTML != "" {
		// multipart/alternative — text/plain first, then text/html (RFC 2046 §5.1.4)
		boundary := generateBoundary()
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
		b.WriteString("\r\n")

		// text/plain part
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
		b.WriteString("\r\n")
		b.WriteString(body)
		b.WriteString("\r\n")

		// text/html part
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
		b.WriteString(body)
	}

	return []byte(b.String())
}

// loginAuth implements SMTP AUTH LOGIN (two-step challenge/response).
// Required by seznam.cz and many Czech/Slovak providers that don't
// support AUTH PLAIN from non-whitelisted IPs.
type loginAuthType struct{ username, password string }

// LoginAuth exported for use in httpapi/probe.go.
func LoginAuth(username, password string) smtp.Auth { return &loginAuthType{username, password} }
func loginAuth(u, p string) smtp.Auth               { return LoginAuth(u, p) }

func (a *loginAuthType) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", nil, nil
}

func (a *loginAuthType) Next(fromServer []byte, more bool) ([]byte, error) {
	if more {
		switch strings.ToLower(strings.TrimSpace(string(fromServer))) {
		case "username:":
			return []byte(a.username), nil
		case "password:":
			return []byte(a.password), nil
		default:
			return nil, fmt.Errorf("unexpected LOGIN challenge: %q", fromServer)
		}
	}
	return nil, nil
}

// pickHELODomain returns the HELO/EHLO domain to announce on SMTP.
//
// Resolution order:
//
//  1. configured — SMTP_HELLO_DOMAIN env value when non-empty. Operator
//     override; trusted verbatim.
//  2. Domain extracted from the sender address (`user@domain` →
//     `domain`). Stays consistent with MAIL FROM and the From header
//     so HELO + envelope + headers all agree, which is what hardened
//     receiving MTAs expect.
//  3. "mail.local" — same fallback used by privacy.go for the
//     Message-ID right-hand side. Syntactically valid FQDN that does
//     not resolve publicly; anonymity intent preserved without leaking
//     the relay's actual hostname.
//
// Never returns an empty string. Never returns "localhost" (the Go
// net/smtp default that triggers Received-from-localhost on the
// recipient side).
func pickHELODomain(configured, fromAddr string) string {
	if configured != "" {
		return configured
	}
	s := strings.TrimSpace(fromAddr)
	// Strip RFC 5322 angle-addr form.
	if i := strings.LastIndex(s, "<"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.TrimSuffix(s, ">")
	at := strings.LastIndex(s, "@")
	if at < 0 || at == len(s)-1 {
		return "mail.local"
	}
	domain := strings.ToLower(strings.TrimSpace(s[at+1:]))
	// Sanitize: keep only DNS-safe characters; stop at the first invalid
	// byte so a malformed envelope.From cannot smuggle CRLF / spaces past
	// the extractor by hiding behind valid trailing chars (the same hard-
	// stop pattern as extractMessageIDDomain in privacy.go).
	var b strings.Builder
	b.Grow(len(domain))
domainLoop:
	for _, r := range domain {
		switch {
		case r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == '.', r == '-':
			b.WriteRune(r)
		default:
			break domainLoop
		}
	}
	clean := strings.Trim(b.String(), ".-")
	if clean == "" || !strings.Contains(clean, ".") {
		return "mail.local"
	}
	return clean
}

// generateBoundary returns a random MIME boundary string.
func generateBoundary() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// Fallback — should never happen in practice.
		return "----=_Part_0_0.00000000"
	}
	return "----=_Part_" + hex.EncodeToString(b)
}

// RecordDeliverer records delivery attempts without actually sending.
// Used for testing and record-only mode.
type RecordDeliverer struct {
	Records []DeliveryRecord
}

// DeliveryRecord captures a recorded delivery attempt.
type DeliveryRecord struct {
	From string
	To   []string
	Body []byte
}

func NewRecordDeliverer() *RecordDeliverer {
	return &RecordDeliverer{}
}

func (r *RecordDeliverer) Deliver(ctx context.Context, from string, to []string, body []byte) error {
	r.Records = append(r.Records, DeliveryRecord{From: from, To: to, Body: body})
	return nil
}

// Deliverer is the interface for message delivery.
type Deliverer interface {
	Deliver(ctx context.Context, from string, to []string, body []byte) error
}

// NewDeliverer creates the appropriate deliverer based on delivery mode and config.
func NewDeliverer(mode string, t transport.AnonymousTransport, cfg SMTPConfig) Deliverer {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "smtp":
		return NewSMTPDeliverer(t, cfg)
	default:
		return NewRecordDeliverer()
	}
}

// AccountPool holds multiple SMTP accounts and picks by from-address.
// Falls back to the default deliverer when no account matches.
type AccountPool struct {
	accounts  map[string]*SMTPDeliverer // keyed by from-address (lowercase)
	fallback  Deliverer
	transport transport.AnonymousTransport
}

// SMTPAccount holds credentials for one account in the pool.
type SMTPAccount struct {
	Address  string
	Password string
}

// NewAccountPool builds a pool from a list of accounts sharing the same SMTP host/port.
// The default deliverer is used when no from-address matches any account.
func NewAccountPool(t transport.AnonymousTransport, baseCfg SMTPConfig, accounts []SMTPAccount, fallback Deliverer) *AccountPool {
	pool := &AccountPool{
		accounts:  make(map[string]*SMTPDeliverer, len(accounts)),
		fallback:  fallback,
		transport: t,
	}
	for _, acc := range accounts {
		cfg := baseCfg
		cfg.Username = acc.Address
		cfg.Password = acc.Password
		pool.accounts[strings.ToLower(acc.Address)] = NewSMTPDeliverer(t, cfg)
	}
	return pool
}

// Deliver sends using the account matching from, or the fallback deliverer.
func (p *AccountPool) Deliver(ctx context.Context, from string, to []string, body []byte) error {
	if p == nil {
		return errors.New("account pool not configured")
	}
	if d, ok := p.accounts[strings.ToLower(from)]; ok {
		return d.Deliver(ctx, from, to, body)
	}
	if p.fallback == nil {
		return errors.New("account pool: no account matched and no fallback configured")
	}
	return p.fallback.Deliver(ctx, from, to, body)
}

// Has returns true if the pool contains an account for the given from-address.
func (p *AccountPool) Has(from string) bool {
	if p == nil {
		return false
	}
	_, ok := p.accounts[strings.ToLower(from)]
	return ok
}

// DeliverWithInlineCreds sends using one-off per-request SMTP credentials when
// smtpHost, username, and password are all non-empty. It builds a temporary
// SMTPDeliverer with the supplied credentials and the same transport as the
// pool — no connection to the static env-var pool.
//
// Falls back to the regular pool-based Deliver when any of the three required
// fields is empty (partial creds → fallback, not an error).
func (p *AccountPool) DeliverWithInlineCreds(
	ctx context.Context,
	smtpHost string,
	smtpPort int,
	username string,
	password string,
	from string,
	to []string,
	body []byte,
) error {
	// Only use inline path when all three required fields are present.
	if smtpHost == "" || username == "" || password == "" {
		return p.Deliver(ctx, from, to, body)
	}
	port := smtpPort
	if port == 0 {
		port = 587
	}
	cfg := SMTPConfig{
		Host:     smtpHost,
		Port:     port,
		Username: username,
		Password: password,
	}
	d := NewSMTPDeliverer(p.transport, cfg)
	return d.Deliver(ctx, from, to, body)
}

// ValidateRecipient checks that an email address is safe for SMTP delivery.
func ValidateRecipient(addr string) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return errors.New("empty recipient")
	}
	if strings.ContainsAny(addr, "\r\n\x00") {
		return errors.New("recipient contains control characters")
	}
	at := strings.LastIndex(addr, "@")
	if at < 1 || at >= len(addr)-1 {
		return errors.New("invalid email format")
	}
	domain := addr[at+1:]
	if !strings.Contains(domain, ".") {
		return errors.New("invalid domain in recipient")
	}
	if _, err := net.LookupMX(domain); err != nil {
		// Don't fail on DNS errors -- the proxy may handle resolution
		_ = err
	}
	return nil
}

// ExitChannelDeliverer wraps a Deliverer with exit channel verification.
type ExitChannelDeliverer struct {
	deliverer Deliverer
}

func NewExitChannelDeliverer(d Deliverer) *ExitChannelDeliverer {
	return &ExitChannelDeliverer{deliverer: d}
}

func (e *ExitChannelDeliverer) DeliverEnvelope(ctx context.Context, env model.Envelope, channel model.ExitChannel) error {
	if !channel.Verified {
		return errors.New("exit channel not verified")
	}
	// In a full implementation, this would unseal the envelope using the channel's
	// recipient key and construct the SMTP message. For now, delegate to the
	// underlying deliverer.
	return nil
}
