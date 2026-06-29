package imap

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// TestNoRawDialToEmailHosts is an AO5 audit ratchet that scans all non-test
// .go files in the orchestrator module for raw net.Dial / net.DialContext /
// tls.Dial / tls.DialWithDialer calls that target known email provider
// hostnames (seznam.cz, gmail.com, email.cz patterns).
//
// Rationale: a raw dial to an email host from the orchestrator bypasses the
// SOCKS5 egress layer and exposes the Railway native IP in IMAP/SMTP login
// surfaces — the root cause of the nowak.gorak fraud lock (feedback_no_direct_smtp).
//
// Whitelisted paths (file path → reason):
//   - cmd/anonymity-harvest/main.go: dedicated test tool that dials TEST
//     mailboxes (not production send path) for the cross-mailbox anonymity
//     measurement suite. Uses its own isolated credentials set. The harvest
//     tool will be migrated to SOCKS5 in AO5.2.
//
// Ratchet target: 0 violations outside the whitelist.
func TestNoRawDialToEmailHosts_OrchestratorScope(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// Climb from services/orchestrator/imap/ → services/orchestrator/
	pkgDir := filepath.Dir(thisFile)
	modRoot := filepath.Dir(pkgDir) // services/orchestrator/

	// Explicit whitelist: relative path from modRoot → comment explaining why.
	whitelist := map[string]string{
		"cmd/anonymity-harvest/main.go": "AO5: deliberate test-tool IMAP dial to measurement mailboxes; production path is via connect() + SOCKS5",
	}

	// Patterns that constitute a raw dial to an email host.
	rawDialPat := regexp.MustCompile(`(?:net\.Dial|net\.DialContext|tls\.Dial|tls\.DialWithDialer)\b`)
	emailHostPat := regexp.MustCompile(`(?i)(?:seznam\.cz|gmail\.com|email\.cz|googlemail\.com|imap\.|smtp\.)`)

	type violation struct {
		rel  string
		line int
		text string
	}
	var violations []violation

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
		// Rolling window of 5 lines so we catch dial + host on adjacent lines.
		var window [5]string
		lineNum := 0
		for scanner.Scan() {
			line := scanner.Text()
			lineNum++
			window[lineNum%5] = line
			combined := strings.Join(window[:], "\n")
			if rawDialPat.MatchString(combined) && emailHostPat.MatchString(combined) {
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
		t.Fatalf("walk orchestrator tree: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf("AO5 ratchet: %d raw dial(s) to email hosts detected outside whitelist:", len(violations))
		for _, v := range violations {
			t.Errorf("  %s:%d: %s", v.rel, v.line, v.text)
		}
		t.Error(`Fix: route IMAP/SMTP dials through connect(ctx, mb) (SOCKS5) or add the
file to the whitelist with a one-line justification (feedback_no_direct_smtp).`)
	}
}

// TestWhitelistFileExists_AnonymityHarvest verifies that the whitelisted
// anonymity-harvest file actually exists so the whitelist entry is not stale.
func TestWhitelistFileExists_AnonymityHarvest(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	modRoot := filepath.Dir(filepath.Dir(thisFile))
	harvestPath := filepath.Join(modRoot, "cmd", "anonymity-harvest", "main.go")
	if _, err := os.Stat(harvestPath); os.IsNotExist(err) {
		t.Errorf("AO5: whitelist entry cmd/anonymity-harvest/main.go does not exist — remove from whitelist or update path")
	}
}

// TestNoNewRawNetDialer_ImapPackage re-confirms the AO2 invariant that no
// production code in this package (imap/) constructs net.Dialer{} outside
// connect(). This test is complementary to no_raw_dial_audit_test.go and
// uses a line-scanner approach instead of AST to catch partial patterns.
func TestNoNewRawNetDialer_ImapPackage(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	pkgDir := filepath.Dir(thisFile)

	dialerPat := regexp.MustCompile(`net\.Dialer\s*\{`)

	type violation struct {
		file string
		line int
		text string
	}
	var violations []violation

	err := filepath.Walk(pkgDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		lines := strings.Split(string(data), "\n")
		inConnect := false
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			// Track when we enter/exit the connect() function.
			if strings.HasPrefix(trimmed, "func connect(") {
				inConnect = true
			} else if inConnect && strings.HasPrefix(trimmed, "func ") {
				inConnect = false
			}
			if !inConnect && dialerPat.MatchString(line) {
				violations = append(violations, violation{
					file: filepath.Base(path),
					line: i + 1,
					text: trimmed,
				})
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk pkg dir: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf("AO5/AO2 ratchet: net.Dialer{} outside connect():")
		for _, v := range violations {
			t.Errorf("  %s:%d: %s", v.file, v.line, v.text)
		}
	}
}
