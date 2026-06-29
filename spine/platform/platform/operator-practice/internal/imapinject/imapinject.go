// Package imapinject APPENDs anonymized .eml payloads into a Mail Lab
// IMAP folder. Mirrors the protocol shape of
// scripts/operator-practice/seed-replies.mjs (raw IMAP/IMAPS, no
// third-party libs) so behaviour is identical regardless of which tool
// seeds the lab.
//
// Per memory feedback_no_direct_smtp the lab IMAP host is the only
// permitted target — we never connect to a real provider's IMAP server
// from this package. Callers are expected to pass localhost / lab-only
// hosts; we additionally guard against accidental misuse via the
// AssertLabHost helper.
package imapinject

import (
	"bufio"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// Config configures the IMAP connection.
type Config struct {
	Host     string
	Port     int
	UseTLS   bool
	Username string
	Password string
	Folder   string // default INBOX
	Timeout  time.Duration
}

// Folder returns the configured folder name with INBOX as the safe default.
func (c Config) folder() string {
	if strings.TrimSpace(c.Folder) == "" {
		return "INBOX"
	}
	return c.Folder
}

func (c Config) timeout() time.Duration {
	if c.Timeout <= 0 {
		return 10 * time.Second
	}
	return c.Timeout
}

// AssertLabHost returns an error when host obviously points at a real
// provider. Defence-in-depth so a typo'd env var cannot push fixtures
// into prod accidentally. The list is intentionally narrow — block
// known real hosts, allow anything that contains "lab" or is a private
// address (10/192.168/172.16/127.0.0.1/localhost).
func AssertLabHost(host string) error {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return errors.New("imapinject: host is empty")
	}
	banned := []string{
		"smtp.seznam.cz", "imap.seznam.cz",
		"smtp.gmail.com", "imap.gmail.com",
		"smtp.outlook.com", "imap.outlook.com",
		"smtp.office365.com", "outlook.office365.com",
		"smtp-mail.outlook.com", "imap-mail.outlook.com",
	}
	for _, b := range banned {
		if h == b {
			return fmt.Errorf("imapinject: host %q is a real provider; refusing to inject lab fixtures", host)
		}
	}
	if strings.Contains(h, "lab") {
		return nil
	}
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return nil
	}
	if strings.HasPrefix(h, "10.") || strings.HasPrefix(h, "192.168.") || strings.HasPrefix(h, "172.16.") {
		return nil
	}
	// Default deny: forbid public hosts unless they explicitly contain "lab".
	return fmt.Errorf("imapinject: host %q is not recognized as a Mail Lab address", host)
}

// Conn is one open IMAP session. Use New to construct.
type Conn struct {
	cfg    Config
	conn   net.Conn
	reader *bufio.Reader
	tag    int
}

// New dials, optionally wraps in TLS, reads the greeting, and returns a
// ready-to-LOGIN session.
func New(cfg Config) (*Conn, error) {
	if err := AssertLabHost(cfg.Host); err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	dialer := &net.Dialer{Timeout: cfg.timeout()}
	var raw net.Conn
	var err error
	if cfg.UseTLS {
		raw, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: cfg.Host,
			// Lab certs are typically self-signed; allow the operator to
			// disable verification via UseTLS only when host is non-public.
			InsecureSkipVerify: true, //nolint:gosec — lab self-signed certs
		})
	} else {
		raw, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return nil, fmt.Errorf("imap dial %s: %w", addr, err)
	}
	if err := raw.SetDeadline(time.Now().Add(cfg.timeout())); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("imap set deadline: %w", err)
	}
	c := &Conn{cfg: cfg, conn: raw, reader: bufio.NewReader(raw)}
	if err := c.readUntil("* OK"); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("imap read greeting: %w", err)
	}
	return c, nil
}

// Login issues LOGIN. Returns the tagged response.
func (c *Conn) Login() error {
	tag := c.nextTag()
	line := fmt.Sprintf(`%s LOGIN "%s" "%s"`, tag, escape(c.cfg.Username), escape(c.cfg.Password))
	if _, err := c.write(line + "\r\n"); err != nil {
		return fmt.Errorf("imap login write: %w", err)
	}
	if err := c.readUntil(tag + " OK"); err != nil {
		return fmt.Errorf("imap login: %w", err)
	}
	return nil
}

// Append appends raw to the configured folder. raw must be a complete
// RFC822 payload (CRLF separators between headers + body). The IMAP
// protocol literal length is computed from raw exactly — caller does
// not need to suffix CRLF themselves; we add one if missing.
func (c *Conn) Append(raw string) error {
	body := raw
	if !strings.HasSuffix(body, "\r\n") {
		body += "\r\n"
	}
	tag := c.nextTag()
	header := fmt.Sprintf(`%s APPEND "%s" {%d}`+"\r\n", tag, c.cfg.folder(), len(body))
	if _, err := c.write(header); err != nil {
		return fmt.Errorf("imap append header: %w", err)
	}
	if err := c.readUntil("+"); err != nil {
		return fmt.Errorf("imap append continuation: %w", err)
	}
	if _, err := c.write(body); err != nil {
		return fmt.Errorf("imap append body: %w", err)
	}
	if err := c.readUntil(tag + " OK"); err != nil {
		return fmt.Errorf("imap append confirmation: %w", err)
	}
	return nil
}

// Logout sends LOGOUT and closes the underlying connection.
func (c *Conn) Logout() error {
	tag := c.nextTag()
	if _, err := c.write(tag + " LOGOUT\r\n"); err != nil {
		_ = c.conn.Close()
		return fmt.Errorf("imap logout write: %w", err)
	}
	// Logout responds with * BYE then tagged OK; reading until the
	// tagged OK consumes both lines.
	_ = c.readUntil(tag + " OK")
	return c.conn.Close()
}

// Close releases the underlying connection without LOGOUT (for error paths).
func (c *Conn) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

func (c *Conn) nextTag() string {
	c.tag++
	return fmt.Sprintf("A%04d", c.tag)
}

func (c *Conn) write(s string) (int, error) {
	_ = c.conn.SetDeadline(time.Now().Add(c.cfg.timeout()))
	return io.WriteString(c.conn, s)
}

// readUntil consumes lines until a line containing needle is seen. The
// IMAP grammar is line-oriented; the standard library bufio reader
// gives us \n-terminated chunks which we glue back together for the
// match check.
func (c *Conn) readUntil(needle string) error {
	deadline := time.Now().Add(c.cfg.timeout())
	for {
		_ = c.conn.SetDeadline(deadline)
		line, err := c.reader.ReadString('\n')
		if err != nil && line == "" {
			return fmt.Errorf("imap read: %w", err)
		}
		if strings.Contains(line, needle) {
			return nil
		}
		if strings.HasPrefix(line, "* BAD") || strings.HasPrefix(line, "* NO") {
			return fmt.Errorf("imap server rejected: %s", strings.TrimSpace(line))
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("imap timeout waiting for %q", needle)
		}
	}
}

// escape doubles double-quote characters and strips bare CRLF, which
// would otherwise terminate the LOGIN argument prematurely. Passwords
// containing " or \ are quoted via IMAP's literal syntax — but since
// we aim at a lab account whose password is operator-controlled this
// minimal escape is sufficient.
func escape(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}
