package privacygateway_test

// no_raw_imap_socket_test.go — per-module audit ratchet for raw IMAP/SMTP socket usage
// in services/privacy-gateway.
//
// Context: privacy-gateway is architecturally separate from the outreach anti-trace
// pipeline. It implements an inbound privacy alias inbox (privacy-first, alias
// routing, NOT production outreach email). Its IMAP dial in internal/inbox/sync.go
// and SMTP dial in internal/mail/smtp_gateway.go connect to provider mailboxes
// (or a locally configured SMTP relay) as chosen by the operator via DELIVERY_MODE
// and IMAP_HOST env vars — this is deliberate design, not an anti-trace bypass.
//
// Why this is acceptable without SOCKS5 wgpool:
//   - privacy-gateway does NOT touch the outreach send pipeline (anti-trace.md)
//   - The AO5 ratchet in services/orchestrator/imap/ covers the anti-trace IMAP scope
//   - privacy-gateway connects to the operator's chosen inbound mailbox, not to
//     seznam.cz for outbound campaign sending
//   - All DELIVERY_MODE=record-only deployments (the default) never dial any live host
//
// This ratchet documents the two known callsites as explicit baseline entries.
// New callsites require a whitelist entry + justification here.
// Any change in the whitelist count triggers this test to fail.
//
// Ratchet baseline: 2 callsites (inbox/sync.go + mail/smtp_gateway.go).

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// TestNoNewRawSocketDials_PrivacyGateway verifies that no NEW raw socket dials to
// email providers have been added beyond the two whitelisted callsites.
func TestNoNewRawSocketDials_PrivacyGateway(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// This file lives at services/privacy-gateway/no_raw_imap_socket_test.go
	// so modRoot = services/privacy-gateway/
	modRoot := filepath.Dir(thisFile)

	// Explicit whitelist: relative path from modRoot → justification.
	// These are production-acceptable raw dials because privacy-gateway is a
	// standalone inbound alias inbox, not the anti-trace outreach pipeline.
	whitelist := map[string]string{
		"internal/inbox/sync.go":        "PG-IMAP-1: netIMAPSessionFactory.New() dials operator's inbound IMAP host via TLS; DELIVERY_MODE=record-only prevents live dial in prod default",
		"internal/mail/smtp_gateway.go": "PG-SMTP-1: netSMTPClientFactory.DialContext() dials operator's configured SMTP relay host; only active when DELIVERY_MODE=smtp",
	}

	// Patterns that constitute a raw socket dial.
	rawDialPat := regexp.MustCompile(`(?:net\.Dial|net\.DialContext|tls\.Dial|tls\.DialWithDialer)\b`)
	// We don't filter by email host here because privacy-gateway connects to
	// operator-configured hosts (env vars), not hardcoded provider hostnames.
	// Instead we count net.Dialer{} constructions (belt-and-suspenders).
	netDialerPat := regexp.MustCompile(`net\.Dialer\s*\{`)

	type hit struct {
		rel  string
		line int
		text string
	}
	var hits []hit

	err := filepath.Walk(modRoot, func(path string, info os.FileInfo, err error) error {
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

		rel, _ := filepath.Rel(modRoot, path)
		if _, ok := whitelist[rel]; ok {
			return nil
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		scanner := bufio.NewScanner(f)
		lineNum := 0
		for scanner.Scan() {
			line := scanner.Text()
			lineNum++
			if rawDialPat.MatchString(line) || netDialerPat.MatchString(line) {
				hits = append(hits, hit{rel: rel, line: lineNum, text: strings.TrimSpace(line)})
			}
		}
		return scanner.Err()
	})
	if err != nil {
		t.Fatalf("walk privacy-gateway tree: %v", err)
	}

	if len(hits) > 0 {
		t.Errorf("privacy-gateway raw-socket ratchet: %d new dial(s) found outside whitelist:", len(hits))
		for _, h := range hits {
			t.Errorf("  %s:%d: %s", h.rel, h.line, h.text)
		}
		t.Error(`Fix: either route the dial through the service's configurable transport layer,
or add the file to the whitelist above with a one-line justification.
See AO5 ratchet in services/orchestrator/imap/no_raw_imap_hosts_audit_test.go for pattern.`)
	}
}

// TestWhitelistFilesExist_PrivacyGateway verifies that all whitelisted files
// actually exist on disk, so stale entries are caught.
func TestWhitelistFilesExist_PrivacyGateway(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	modRoot := filepath.Dir(thisFile)

	whitelisted := []string{
		"internal/inbox/sync.go",
		"internal/mail/smtp_gateway.go",
	}
	for _, rel := range whitelisted {
		full := filepath.Join(modRoot, rel)
		if _, err := os.Stat(full); os.IsNotExist(err) {
			t.Errorf("privacy-gateway ratchet: whitelisted file does not exist: %s — remove stale entry", rel)
		}
	}
}

// TestBaselineCallsiteCount_PrivacyGateway verifies that exactly the expected
// number of raw dial callsites exist in the whitelisted files. If a developer
// adds new dials to a whitelisted file, this test catches it.
func TestBaselineCallsiteCount_PrivacyGateway(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	modRoot := filepath.Dir(thisFile)

	// file → expected count of net.Dialer{} constructions
	baselines := map[string]int{
		"internal/inbox/sync.go":        1, // one net.Dialer{} in netIMAPSessionFactory.New
		"internal/mail/smtp_gateway.go": 1, // one net.Dialer{} in netSMTPClientFactory.DialContext
	}

	netDialerPat := regexp.MustCompile(`net\.Dialer\s*\{`)

	for rel, expected := range baselines {
		path := filepath.Join(modRoot, rel)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("cannot read %s: %v", rel, err)
			continue
		}
		count := len(netDialerPat.FindAllIndex(data, -1))
		if count != expected {
			t.Errorf("privacy-gateway ratchet baseline mismatch in %s: expected %d net.Dialer{} construction(s), got %d — update whitelist + baseline", rel, expected, count)
		}
	}
}
