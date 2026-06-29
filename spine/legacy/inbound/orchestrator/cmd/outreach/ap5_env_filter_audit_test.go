package main

// ap5_env_filter_audit_test.go — AP5 production boundary ratchet for the Go orchestrator.
//
// Mirrors the JS bff-mailboxes-environment.contract.test.ts source ratchet, applied
// to Go production query paths in features/inbound/orchestrator/.
//
// Rule: any SELECT from outreach_mailboxes in a production code path MUST include
// AND environment = 'production'. Exceptions are whitelisted below with
// // AP5_ALLOW_NO_ENV_FILTER reason comments in the source file.
//
// This ratchet prevents a regression where anonymity-test and anonymity-harvest
// queried mailboxes without the environment boundary (PR #721 fix).
//
// Covered files and expected patterns:
//   - features/inbound/orchestrator/cmd/anonymity-harvest/main.go (loadMailboxes)
//   - features/inbound/orchestrator/cmd/anonymity-test/main.go (loadMailboxes)
//   - features/inbound/orchestrator/intelligence/mailbox_score_loop.go (loadActiveMailboxes)
//   - features/inbound/orchestrator/intelligence/stubs.go (stubbed path — has filter)

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// rootDir walks up from the test file's directory to the monorepo root.
func ap5RepoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	// file: features/inbound/orchestrator/cmd/outreach/ap5_env_filter_audit_test.go
	// Root is 5 levels up (features/inbound/orchestrator/cmd/outreach → repo root).
	root := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..")
	abs, err := filepath.Abs(root)
	if err != nil {
		t.Fatalf("ap5RepoRoot: %v", err)
	}
	return abs
}

// ap5ReadFile reads a repo-relative path.
func ap5ReadFile(t *testing.T, root, relPath string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(root, relPath))
	if err != nil {
		t.Fatalf("ap5ReadFile %s: %v", relPath, err)
	}
	return string(content)
}

var reFromMailboxes = regexp.MustCompile(`(?i)FROM\s+outreach_mailboxes`)
var reEnvProduction = regexp.MustCompile(`(?i)AND\s+environment\s*=\s*'production'`)
var reAP5Allow = regexp.MustCompile(`AP5_ALLOW_NO_ENV_FILTER`)
// reCommentLine matches a line that is purely a Go comment (starts with optional
// whitespace then // or is part of a /* block).
var reCommentLine = regexp.MustCompile(`^\s*//`)

// TestAP5_EnvFilter_AnonymityHarvest verifies anonymity-harvest loadMailboxes
// has AND environment = 'production'.
func TestAP5_EnvFilter_AnonymityHarvest(t *testing.T) {
	root := ap5RepoRoot(t)
	content := ap5ReadFile(t, root, "features/inbound/orchestrator/cmd/anonymity-harvest/main.go")

	if !reFromMailboxes.MatchString(content) {
		t.Skip("anonymity-harvest no longer queries outreach_mailboxes — test no longer needed")
	}

	// Find lines that contain FROM outreach_mailboxes and check they are
	// accompanied by environment filter within the same query block.
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if !strings.Contains(strings.ToLower(line), "from outreach_mailboxes") {
			continue
		}
		// Skip comment-only lines — they mention the table for documentation, not SQL.
		if reCommentLine.MatchString(line) {
			continue
		}
		// Check for AP5_ALLOW_NO_ENV_FILTER in surrounding 5 lines (inline exemption).
		window := extractWindow(lines, i, 5)
		if reAP5Allow.MatchString(window) {
			continue // explicitly whitelisted
		}
		// Check environment filter within the next 10 lines (query block).
		queryBlock := extractWindow(lines, i, 10)
		if !reEnvProduction.MatchString(queryBlock) {
			t.Errorf("anonymity-harvest line %d: FROM outreach_mailboxes without AND environment='production' (AP5):\n  %s\nQuery block:\n%s",
				i+1, strings.TrimSpace(line), queryBlock)
		}
	}
}

// TestAP5_EnvFilter_AnonymityTest verifies anonymity-test loadMailboxes
// has AND environment = 'production'.
func TestAP5_EnvFilter_AnonymityTest(t *testing.T) {
	root := ap5RepoRoot(t)
	content := ap5ReadFile(t, root, "features/inbound/orchestrator/cmd/anonymity-test/main.go")

	if !reFromMailboxes.MatchString(content) {
		t.Skip("anonymity-test no longer queries outreach_mailboxes — test no longer needed")
	}

	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if !strings.Contains(strings.ToLower(line), "from outreach_mailboxes") {
			continue
		}
		if reCommentLine.MatchString(line) {
			continue
		}
		window := extractWindow(lines, i, 5)
		if reAP5Allow.MatchString(window) {
			continue
		}
		queryBlock := extractWindow(lines, i, 10)
		if !reEnvProduction.MatchString(queryBlock) {
			t.Errorf("anonymity-test line %d: FROM outreach_mailboxes without AND environment='production' (AP5):\n  %s\nQuery block:\n%s",
				i+1, strings.TrimSpace(line), queryBlock)
		}
	}
}

// TestAP5_EnvFilter_MailboxScoreLoop verifies mailbox_score_loop still has the filter.
func TestAP5_EnvFilter_MailboxScoreLoop(t *testing.T) {
	root := ap5RepoRoot(t)
	content := ap5ReadFile(t, root, "features/inbound/orchestrator/intelligence/mailbox_score_loop.go")

	if !reFromMailboxes.MatchString(content) {
		t.Skip("mailbox_score_loop no longer queries outreach_mailboxes")
	}

	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if !strings.Contains(strings.ToLower(line), "from outreach_mailboxes") {
			continue
		}
		if reCommentLine.MatchString(line) {
			continue
		}
		window := extractWindow(lines, i, 5)
		if reAP5Allow.MatchString(window) {
			continue
		}
		queryBlock := extractWindow(lines, i, 10)
		if !reEnvProduction.MatchString(queryBlock) {
			t.Errorf("mailbox_score_loop line %d: FROM outreach_mailboxes without AND environment='production' (AP5):\n  %s\nQuery block:\n%s",
				i+1, strings.TrimSpace(line), queryBlock)
		}
	}
}

// allowedAP5NonTestFiles is the explicit allowlist of non-test production files
// permitted to use AP5_ALLOW_NO_ENV_FILTER. Each entry must have a documented
// reason (single-row lookup by ID/address, not a set query).
// Adding to this list requires a reviewer to confirm the exemption is justified.
var allowedAP5NonTestFiles = map[string]string{
	"features/inbound/orchestrator/cmd/anonymity-harvest/main.go": "lookupMailboxIDByAddress: single-row reverse lookup by address, not a set query",
}

// TestAP5_EnvFilter_Whitelist verifies that AP5_ALLOW_NO_ENV_FILTER exemptions
// in non-test files are in the explicit allowlist only.
// A new non-test file with this tag that is NOT in allowedAP5NonTestFiles is a violation.
func TestAP5_EnvFilter_WhitelistOnlyInTestOrUtil(t *testing.T) {
	root := ap5RepoRoot(t)
	// Walk Go source files in orchestrator.
	orchRoot := filepath.Join(root, "features", "inbound", "orchestrator")
	violations := []string{}
	err := filepath.Walk(orchRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !reAP5Allow.Match(content) {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		// Test files are always allowed.
		if strings.HasSuffix(path, "_test.go") || strings.Contains(rel, "test") {
			return nil
		}
		// Check explicit allowlist for non-test production files.
		if _, ok := allowedAP5NonTestFiles[rel]; !ok {
			violations = append(violations, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk orchestrator: %v", err)
	}
	if len(violations) > 0 {
		t.Errorf("AP5_ALLOW_NO_ENV_FILTER found in non-test files not in the explicit allowlist:")
		for _, v := range violations {
			t.Logf("  %s — add to allowedAP5NonTestFiles with a documented reason", v)
		}
	}
}

// extractWindow returns lines[max(0,i-before) : min(len(lines), i+after+1)] joined.
func extractWindow(lines []string, i, radius int) string {
	start := i - radius
	if start < 0 {
		start = 0
	}
	end := i + radius + 1
	if end > len(lines) {
		end = len(lines)
	}
	return strings.Join(lines[start:end], "\n")
}
