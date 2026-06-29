package content

import (
	"strings"
	"testing"
)

// ── A3: TemplateVars.UnsubURL substitution ────────────────────────────────

func TestSubstituteVars_UnsubURL(t *testing.T) {
	vars := TemplateVars{
		Firma:    "Firma s.r.o.",
		UnsubURL: "https://outreach.example.com/unsubscribe?token=abc123",
	}
	text := "Kontakt: {{firma}}\nOdhlásit: {{unsuburl}}"
	got := substituteVars(text, vars)
	if !strings.Contains(got, "abc123") {
		t.Errorf("UnsubURL not substituted: %q", got)
	}
	if strings.Contains(got, "{{unsuburl}}") {
		t.Error("{{unsuburl}} placeholder was not replaced")
	}
}

func TestSubstituteVars_UnsubURL_DotNotation(t *testing.T) {
	vars := TemplateVars{
		UnsubURL: "https://example.com/u?t=xyz",
	}
	text := "Click here: {{.UnsubURL}}"
	got := substituteVars(text, vars)
	if !strings.Contains(got, "xyz") {
		t.Errorf("{{.UnsubURL}} not substituted: %q", got)
	}
}

func TestSubstituteVars_UnsubURL_Empty(t *testing.T) {
	vars := TemplateVars{UnsubURL: ""}
	text := "link: {{unsuburl}}"
	got := substituteVars(text, vars)
	// Empty UnsubURL → placeholder replaced with empty string (not the literal placeholder)
	if strings.Contains(got, "{{unsuburl}}") {
		t.Error("empty UnsubURL must still replace the placeholder")
	}
}

func TestSubstituteVars_UnsubURL_NoDoubleEncoding(t *testing.T) {
	// URL must be passed verbatim — no HTML escaping in plain text body
	vars := TemplateVars{
		UnsubURL: "https://x.com/u?token=a%2Fb&id=1",
	}
	text := "{{unsuburl}}"
	got := substituteVars(text, vars)
	if got != vars.UnsubURL {
		t.Errorf("UnsubURL must be inserted verbatim, got: %q", got)
	}
}

// ── A3: Multiple unsuburl occurrences in one body ─────────────────────────

func TestSubstituteVars_UnsubURL_MultipleOccurrences(t *testing.T) {
	vars := TemplateVars{UnsubURL: "https://unsub.example.com"}
	text := "Top: {{unsuburl}}\nBottom: {{unsuburl}}"
	got := substituteVars(text, vars)
	count := strings.Count(got, "https://unsub.example.com")
	if count != 2 {
		t.Errorf("expected 2 unsubURL replacements, got %d in %q", count, got)
	}
}
