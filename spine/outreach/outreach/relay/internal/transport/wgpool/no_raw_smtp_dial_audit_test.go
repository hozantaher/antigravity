package wgpool_test

// AO5 audit ratchet: no raw smtp.Dial / net.Dial to email-provider hostnames
// outside the delivery layer.
//
// Rule: production Go files in services/relay/ must not call smtp.Dial,
// smtp.NewClient with a raw net.Conn, or net.DialContext targeting known email
// provider hosts (seznam.cz, gmail.com, email.cz) outside the designated
// delivery package (internal/delivery/smtp.go).
//
// Whitelisted paths (relative to relay root → reason):
//   - internal/delivery/smtp.go: canonical SMTP delivery; uses transport.AnonymousTransport.DialContext (wgpool-routed)
//   - web/raw_smtp_diag.go: operator diagnostics only — direct-dial intentional for connectivity triage
//
// Ratchet target: 0 new violations outside whitelist.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var smtpAllowedCallSites = map[string]string{
	"internal/delivery/smtp.go": "canonical delivery — routes through transport.AnonymousTransport (wgpool-routed); smtp.Dial is not called; net/smtp.NewClient receives a proxy-dialled conn",
	"web/raw_smtp_diag.go":      "operator diagnostic endpoint — intentional direct dial for connectivity triage, not a send path",
	"web/probe.go":              "verify probe (VERIFY_VIA_DIRECT_EGRESS policy) — intentional Railway native egress to preserve CZ SMTP reputation + avoid VPN blocks; probes only check deliverability, not part of send pipeline",
}

// rawSmtpDialPat matches smtp.Dial, smtp.NewClient, or net.Dial/DialContext
// calls that could directly open an SMTP connection.
var rawSmtpDialPat = regexp.MustCompile(`(?:smtp\.Dial\b|smtp\.NewClient\b.*net\.Conn|net\.Dial(?:Context)?\s*\(.*(?:587|465|25)\b)`)

// emailSMTPHostPat catches calls targeting known provider SMTP endpoints.
var emailSMTPHostPat = regexp.MustCompile(`(?i)(?:smtp\.seznam\.cz|smtp\.gmail\.com|smtp\.email\.cz|mail\.google\.com)`)

func TestAuditRatchet_NoRawSMTPDialOutsideDelivery(t *testing.T) {
	root := repoRelayRoot(t)

	type violation struct {
		rel  string
		line int
		text string
	}
	var violations []violation

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}

		rel, _ := filepath.Rel(root, path)
		if _, ok := smtpAllowedCallSites[rel]; ok {
			return nil
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		// Slide a 5-line window to catch multi-line dial+host patterns.
		var window [5]string
		lineNum := 0
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 1024*1024), 4*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			lineNum++
			window[lineNum%5] = line
			combined := strings.Join(window[:], "\n")
			if rawSmtpDialPat.MatchString(combined) && emailSMTPHostPat.MatchString(combined) {
				violations = append(violations, violation{
					rel:  rel,
					line: lineNum,
					text: strings.TrimSpace(line),
				})
			}
		}
		return scanner.Err()
	})
	if err != nil {
		t.Fatalf("walk relay tree: %v", err)
	}

	if len(violations) > 0 {
		lines := make([]string, 0, len(violations))
		for _, v := range violations {
			lines = append(lines, v.rel+":"+fmt.Sprintf("%d", v.line)+": "+v.text)
		}
		t.Fatalf("AO5 SMTP ratchet: %d raw SMTP dial(s) to email hosts outside whitelist:\n%s\n\nAdd the file to smtpAllowedCallSites with a one-line justification, or route through wgpool.Transport.",
			len(violations), strings.Join(lines, "\n"))
	}
}

// TestAuditRatchet_DeliveryUsesTransportDialContext verifies that the
// canonical delivery package calls transport.DialContext (not smtp.Dial or a
// raw net.Dial) — so the wgpool egress path is always engaged.
func TestAuditRatchet_DeliveryUsesTransportDialContext(t *testing.T) {
	root := repoRelayRoot(t)
	deliveryPath := filepath.Join(root, "internal", "delivery", "smtp.go")

	data, err := os.ReadFile(deliveryPath)
	if err != nil {
		t.Fatalf("cannot read delivery/smtp.go: %v", err)
	}
	src := string(data)

	// Must use transport.DialContext (wgpool-routed).
	if !strings.Contains(src, ".transport.DialContext(") {
		t.Error("AO5: delivery/smtp.go must call d.transport.DialContext(ctx, ...) to route through wgpool")
	}
	// Must NOT call smtp.Dial directly.
	if regexp.MustCompile(`\bsmtp\.Dial\s*\(`).MatchString(src) {
		t.Error("AO5: delivery/smtp.go must not call smtp.Dial — raw SMTP dial bypasses wgpool")
	}
}

// TestAuditRatchet_SMTPWhitelistFilesExist ensures whitelisted files actually
// exist so stale entries are caught at CI time.
func TestAuditRatchet_SMTPWhitelistFilesExist(t *testing.T) {
	root := repoRelayRoot(t)
	for rel, reason := range smtpAllowedCallSites {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if _, err := os.Stat(full); os.IsNotExist(err) {
			t.Errorf("AO5: SMTP whitelist entry %q does not exist (reason: %s) — remove or update path", rel, reason)
		}
	}
}

