package content

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRender_PathTraversalRejected locks the path-traversal guard added
// 2026-04-27 (D.2 from adversarial-fixes plan). templateName flows from
// DB campaigns.sequence_config — an operator with edit access could
// previously specify template="../../etc/passwd" and Render would attempt
// to load /etc/passwd.tmpl. The error would leak filesystem layout via
// fmt.Errorf("load template %s: %w", templateName, err).
//
// The fix: validTemplateName regex `^[a-z0-9_-]+$` (max 64 chars). Every
// production template name (intro_machinery, followup_1, followup_2,
// initial, final, etc.) matches; every traversal payload is rejected.
func TestRender_PathTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ok.tmpl"), []byte("test"), 0644); err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(dir, nil)

	traversalCases := map[string]string{
		"path traversal up":        "../../etc/passwd",
		"absolute path":            "/etc/passwd",
		"backslash on unix":        `..\..\etc\passwd`,
		"trailing slash":           "intro/",
		"embedded slash":           "intro/hidden",
		"nul byte":                 "intro\x00malicious",
		"newline":                  "intro\nmalicious",
		"uppercase":                "INTRO",
		"dot in name":              "intro.machinery",
		"trailing tmpl extension":  "intro.tmpl",
		"unicode look-alike":       "intrО", // Cyrillic О
		"empty name":               "",
		"only dots":                "...",
		"shell expansion attempt":  "$(rm -rf)",
		"path traversal encoded":   "..%2F..%2Fetc%2Fpasswd",
		"very long name 65 chars":  strings.Repeat("a", 65),
	}

	for name, payload := range traversalCases {
		t.Run(name, func(t *testing.T) {
			_, err := engine.Render(payload, TemplateVars{}, 1, 0)
			if err == nil {
				t.Errorf("expected error for traversal payload %q, got nil", payload)
				return
			}
			if !strings.Contains(err.Error(), "invalid template name") {
				t.Errorf("expected validation error, got: %v", err)
			}
		})
	}
}

// TestRender_LegitimateNamesAccepted verifies the allowlist doesn't break
// real production template names. Pin the contract.
func TestRender_LegitimateNamesAccepted(t *testing.T) {
	dir := t.TempDir()
	legitimate := []string{
		"intro_machinery",
		"followup_1",
		"followup_2",
		"initial",
		"final",
		"followup1", // alternate format also seen on disk
		"abc-def-123",
		"a", // single char
		"test_template_v35",
	}

	// Write a stub for each so Render gets past the file-load step
	for _, n := range legitimate {
		if err := os.WriteFile(filepath.Join(dir, n+".tmpl"), []byte("body"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	engine := NewEngine(dir, nil)
	for _, n := range legitimate {
		t.Run(n, func(t *testing.T) {
			_, err := engine.Render(n, TemplateVars{}, 1, 0)
			if err != nil {
				t.Errorf("legitimate template name %q rejected: %v", n, err)
			}
		})
	}
}

// TestValidTemplateName_BoundaryLengths pins the 1..64 char window.
func TestValidTemplateName_BoundaryLengths(t *testing.T) {
	cases := map[string]bool{
		"":                          false,
		"a":                         true,
		strings.Repeat("a", 64):     true,
		strings.Repeat("a", 65):     false,
		strings.Repeat("a", 1024):   false,
	}
	for name, want := range cases {
		got := validTemplateName(name)
		if got != want {
			t.Errorf("validTemplateName(len=%d) = %v, want %v", len(name), got, want)
		}
	}
}
