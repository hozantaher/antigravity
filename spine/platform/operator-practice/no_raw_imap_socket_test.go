package operatorpractice_test

// no_raw_imap_socket_test.go — per-module audit ratchet for raw IMAP socket usage
// in services/operator-practice.
//
// Context: operator-practice is a CLI tool for the Mail Lab feedback loop (KT-B5).
// It seeds anonymized prod replies into a Mail Lab IMAP inbox so the classifier
// can be trained against real (anonymized) data. It intentionally dials a raw
// IMAP socket because it is a Lab-only tool — it is NOT deployed in production.
//
// Existing guard: AssertLabHost() in internal/imapinject/imapinject.go blocks
// any dial to real email provider hostnames (seznam.cz, gmail.com, outlook.com,
// etc.) and requires the host to be localhost/127.0.0.1/lab-prefixed or a
// RFC1918 private address. This prevents accidental prod injection at runtime.
//
// This ratchet documents the single known raw-dial callsite as an explicit
// baseline. New callsites require a whitelist entry + justification here.
//
// Ratchet baseline: 1 callsite (internal/imapinject/imapinject.go).

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// TestNoNewRawSocketDials_OperatorPractice verifies that no NEW raw socket dials
// have been added beyond the single whitelisted callsite.
func TestNoNewRawSocketDials_OperatorPractice(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// This file lives at services/operator-practice/no_raw_imap_socket_test.go
	// so modRoot = services/operator-practice/
	modRoot := filepath.Dir(thisFile)

	// Explicit whitelist: relative path from modRoot → justification.
	whitelist := map[string]string{
		"internal/imapinject/imapinject.go": "OP-IMAP-1: New() dials Mail Lab IMAP only; AssertLabHost() runtime guard blocks all real provider hostnames; tool is never deployed in production",
	}

	rawDialPat := regexp.MustCompile(`(?:net\.Dial|net\.DialContext|tls\.Dial|tls\.DialWithDialer)\b`)
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
		t.Fatalf("walk operator-practice tree: %v", err)
	}

	if len(hits) > 0 {
		t.Errorf("operator-practice raw-socket ratchet: %d new dial(s) found outside whitelist:", len(hits))
		for _, h := range hits {
			t.Errorf("  %s:%d: %s", h.rel, h.line, h.text)
		}
		t.Error(`Fix: this module is Mail Lab only. New dials must:
  1. Only connect to localhost/lab hosts (enforced by AssertLabHost)
  2. Be added to the whitelist above with a one-line justification
  3. Never connect to production email provider IMAP/SMTP endpoints`)
	}
}

// TestWhitelistFilesExist_OperatorPractice verifies that all whitelisted files
// actually exist on disk, so stale entries are caught.
func TestWhitelistFilesExist_OperatorPractice(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	modRoot := filepath.Dir(thisFile)

	whitelisted := []string{
		"internal/imapinject/imapinject.go",
	}
	for _, rel := range whitelisted {
		full := filepath.Join(modRoot, rel)
		if _, err := os.Stat(full); os.IsNotExist(err) {
			t.Errorf("operator-practice ratchet: whitelisted file does not exist: %s — remove stale entry", rel)
		}
	}
}

// TestAssertLabHostGuardExists_OperatorPractice verifies that the AssertLabHost
// runtime guard function still exists in imapinject. If someone renames or
// removes it, this test fails immediately.
func TestAssertLabHostGuardExists_OperatorPractice(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	modRoot := filepath.Dir(thisFile)

	imapinjectPath := filepath.Join(modRoot, "internal", "imapinject", "imapinject.go")
	data, err := os.ReadFile(imapinjectPath)
	if err != nil {
		t.Fatalf("cannot read imapinject.go: %v", err)
	}

	assertPat := regexp.MustCompile(`func AssertLabHost\(`)
	if !assertPat.Match(data) {
		t.Error("operator-practice ratchet: AssertLabHost() guard has been removed from imapinject.go — this is the runtime protection against prod injection; restore it")
	}

	// Verify New() calls AssertLabHost before dialing
	newFuncPat := regexp.MustCompile(`func New\(`)
	if !newFuncPat.Match(data) {
		t.Error("operator-practice ratchet: New() constructor not found in imapinject.go")
		return
	}

	assertCallPat := regexp.MustCompile(`AssertLabHost\(`)
	if !assertCallPat.Match(data) {
		t.Error("operator-practice ratchet: AssertLabHost() is not called anywhere in imapinject.go — the runtime host guard has been bypassed")
	}
}
