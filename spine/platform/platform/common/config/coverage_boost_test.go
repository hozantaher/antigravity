package config

// coverage_boost_test.go — targeted tests to close the remaining gaps in
// Validate, validateTrackingBaseURL, and isDevSafeMailbox.
// Each test is self-contained, uses t.Setenv for safe env isolation, and
// covers a specific uncovered branch identified by go tool cover.

import (
	"strings"
	"testing"
	"testing/quick"
)

// ─── Validate: DEV_MODE with no mailboxes → nil (return nil branch) ──────────

// TestValidate_DevMode_NoMailboxes verifies that DEV_MODE=1 with an empty
// mailbox list returns nil without iterating (covers the "return nil" at
// the bottom of the DEV_MODE block).
func TestValidate_DevMode_NoMailboxes(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{Mailboxes: nil}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected nil for empty mailboxes in DEV_MODE, got: %v", err)
	}
}

// TestValidate_DevMode_EmptyMailboxSlice is the same contract but with an
// explicitly allocated empty slice (not nil) — both paths collapse to the
// for-loop doing zero iterations and hitting return nil.
func TestValidate_DevMode_EmptyMailboxSlice(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{Mailboxes: []MailboxConfig{}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("empty slice in DEV_MODE: %v", err)
	}
}

// TestValidate_DevMode_IMAPHostNotSandbox covers the isDevSafeMailbox branch
// where the IMAP host fails the sandbox check (Email host + SMTP host are fine,
// only IMAPHost is a production host).
func TestValidate_DevMode_IMAPHostNotSandbox(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "robot@sandbox.test",
				SMTPHost: "localhost",
				SMTPPort: 1025,
				IMAPHost: "imap.seznam.cz", // production IMAP host
				IMAPPort: 993,
			},
		},
	}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("DEV_MODE=1 with production IMAP host must return error")
	}
	if !strings.Contains(err.Error(), "DEV_MODE=1") {
		t.Errorf("error should mention DEV_MODE, got: %v", err)
	}
}

// TestValidate_DevMode_MultipleMailboxes_FirstBad ensures the error is reported
// for the first failing mailbox (not a panic or silent skip).
func TestValidate_DevMode_MultipleMailboxes_FirstBad(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "ok@sandbox.test",
				SMTPHost: "localhost",
				IMAPHost: "localhost",
			},
			{
				Address:  "bad@real-company.cz", // fails address host check
				SMTPHost: "localhost",
				IMAPHost: "localhost",
			},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected error when second mailbox has non-sandbox address")
	}
}

// TestValidate_DevMode_MultipleMailboxes_AllSafe verifies that all-sandbox
// mailbox lists pass when DEV_MODE=1.
func TestValidate_DevMode_MultipleMailboxes_AllSafe(t *testing.T) {
	t.Setenv("DEV_MODE", "1")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{
				Address:  "a@sandbox.test",
				SMTPHost: "localhost",
				IMAPHost: "localhost",
			},
			{
				Address:  "b@sandbox.test",
				SMTPHost: "mailpit",
				IMAPHost: "mailpit",
			},
		},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("all-sandbox mailboxes should pass DEV_MODE, got: %v", err)
	}
}

// ─── validateTrackingBaseURL: url.Parse error branch ─────────────────────────

// TestValidateTrackingBaseURL_UnparsableURL exercises the url.Parse error path.
// Go's url.Parse is quite lenient, but a URL with a literal control character
// (0x7f) triggers the "invalid character" error path.
func TestValidateTrackingBaseURL_UnparsableURL(t *testing.T) {
	// A URL containing ASCII DEL (0x7f) cannot be parsed by net/url.
	badURL := "https://host\x7f.example.com"
	err := validateTrackingBaseURL(badURL)
	if err == nil {
		t.Skip("url.Parse accepted the control-char URL — Go version may differ; skipping")
	}
	// If url.Parse rejects it, we expect our "not a valid URL" message.
	if !strings.Contains(err.Error(), "not a valid URL") {
		t.Errorf("unexpected error message: %v", err)
	}
}

// TestValidateTrackingBaseURL_PathOnly covers the case where the trimmed input
// is non-empty but has no scheme, so url.Parse succeeds but u.Scheme == "".
func TestValidateTrackingBaseURL_PathOnly(t *testing.T) {
	err := validateTrackingBaseURL("/just/a/path")
	if err == nil {
		t.Error("expected error for path-only URL")
	}
}

// TestValidateTrackingBaseURL_FTPScheme covers a non-https scheme that is
// fully parseable but rejected by the scheme check.
func TestValidateTrackingBaseURL_FTPScheme(t *testing.T) {
	err := validateTrackingBaseURL("ftp://track.example.com")
	if err == nil {
		t.Error("expected error for ftp:// scheme")
	}
}

// TestValidateTrackingBaseURL_WSScheme — websocket scheme is parseable but invalid.
func TestValidateTrackingBaseURL_WSScheme(t *testing.T) {
	if err := validateTrackingBaseURL("ws://track.example.com"); err == nil {
		t.Error("ws:// should be rejected")
	}
}

// ─── isDevSafeMailbox: direct unit tests for all branch combinations ──────────

// TestIsDevSafeMailbox_WithPassword — any password present → false.
func TestIsDevSafeMailbox_WithPassword(t *testing.T) {
	mb := MailboxConfig{
		Address:  "robot@sandbox.test",
		SMTPHost: "localhost",
		IMAPHost: "localhost",
		Password: "secret",
	}
	if isDevSafeMailbox(mb) {
		t.Error("mailbox with password should NOT be dev-safe")
	}
}

// TestIsDevSafeMailbox_NonSandboxAddress — address domain is production → false.
func TestIsDevSafeMailbox_NonSandboxAddress(t *testing.T) {
	mb := MailboxConfig{
		Address:  "robot@real.cz",
		SMTPHost: "localhost",
		IMAPHost: "localhost",
	}
	if isDevSafeMailbox(mb) {
		t.Error("production address domain should NOT be dev-safe")
	}
}

// TestIsDevSafeMailbox_NonSandboxSMTP — SMTP host is production → false.
func TestIsDevSafeMailbox_NonSandboxSMTP(t *testing.T) {
	mb := MailboxConfig{
		Address:  "robot@sandbox.test",
		SMTPHost: "smtp.seznam.cz",
		IMAPHost: "localhost",
	}
	if isDevSafeMailbox(mb) {
		t.Error("production SMTP host should NOT be dev-safe")
	}
}

// TestIsDevSafeMailbox_NonSandboxIMAP — IMAP host is production → false.
// This specifically covers the third branch (IMAP check) which was at 88.9%.
func TestIsDevSafeMailbox_NonSandboxIMAP(t *testing.T) {
	mb := MailboxConfig{
		Address:  "robot@sandbox.test",
		SMTPHost: "localhost",
		IMAPHost: "imap.google.com", // production
	}
	if isDevSafeMailbox(mb) {
		t.Error("production IMAP host should NOT be dev-safe")
	}
}

// TestIsDevSafeMailbox_AllSandbox — all three criteria pass → true.
func TestIsDevSafeMailbox_AllSandbox(t *testing.T) {
	mb := MailboxConfig{
		Address:  "robot@sandbox.test",
		SMTPHost: "mailpit",
		IMAPHost: "mailpit",
	}
	if !isDevSafeMailbox(mb) {
		t.Error("all-sandbox mailbox should be dev-safe")
	}
}

// TestIsDevSafeMailbox_ExampleDomain — example.com address is sandbox → true.
func TestIsDevSafeMailbox_ExampleDomain(t *testing.T) {
	mb := MailboxConfig{
		Address:  "robot@sandbox.example.com",
		SMTPHost: "localhost",
		IMAPHost: "localhost",
	}
	if !isDevSafeMailbox(mb) {
		t.Error("example.com domain should be treated as sandbox")
	}
}

// ─── Property: isDevSafeMailbox never panics ─────────────────────────────────

// TestProperty_IsDevSafeMailbox_NoPanic runs quick.Check to verify the function
// never panics regardless of input.
func TestProperty_IsDevSafeMailbox_NoPanic(t *testing.T) {
	f := func(addr, smtpHost, imapHost, password string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic: addr=%q smtp=%q imap=%q pass=%q: %v", addr, smtpHost, imapHost, password, r)
			}
		}()
		_ = isDevSafeMailbox(MailboxConfig{
			Address:  addr,
			SMTPHost: smtpHost,
			IMAPHost: imapHost,
			Password: password,
		})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestProperty_IsDevSafeMailbox_PasswordAlwaysBlocks verifies the invariant:
// any non-empty password → isDevSafeMailbox returns false, regardless of hosts.
func TestProperty_IsDevSafeMailbox_PasswordAlwaysBlocks(t *testing.T) {
	f := func(addr, smtpHost, imapHost string, password string) bool {
		if password == "" {
			return true // skip empty passwords (those can still be safe)
		}
		return !isDevSafeMailbox(MailboxConfig{
			Address:  addr,
			SMTPHost: smtpHost,
			IMAPHost: imapHost,
			Password: password,
		})
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ─── Validate: production port 587 is valid (covers the 587 branch) ──────────

// TestValidate_ProductionPort587_OK verifies that port 587 (STARTTLS) is
// accepted just like 465 (implicit TLS).
func TestValidate_ProductionPort587_OK(t *testing.T) {
	t.Setenv("DEV_MODE", "")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{Address: "prod@firma.cz", SMTPPort: 587, IMAPPort: 993, Username: "u", Password: "p"},
		},
		Tracking: TrackingConfig{BaseURL: "https://track.example.com"},
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("port 587 should be accepted: %v", err)
	}
}

// TestValidate_MissingTrackingURL_WhenAuthMailbox verifies the tracking URL
// check fires when there is at least one authenticated mailbox.
func TestValidate_MissingTrackingURL_WhenAuthMailbox(t *testing.T) {
	t.Setenv("DEV_MODE", "")
	cfg := &Config{
		Mailboxes: []MailboxConfig{
			{Address: "prod@firma.cz", SMTPPort: 465, IMAPPort: 993, Username: "u", Password: "p"},
		},
		Tracking: TrackingConfig{BaseURL: ""}, // missing
	}
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error when TRACKING_BASE_URL is empty with authenticated mailbox")
	}
}
