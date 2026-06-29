package metrics

import (
	"strconv"
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: escapeHelp never panics ────────────────────────
func TestProperty_EscapeHelp_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = escapeHelp(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: escapeLabelValue never panics ──────────────────
func TestProperty_EscapeLabelValue_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = escapeLabelValue(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: formatFloat never panics ───────────────────────
func TestProperty_FormatFloat_NoPanic(t *testing.T) {
	f := func(v float64) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %v: %v", v, r)
			}
		}()
		_ = formatFloat(v)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: deterministic outputs ──────────────────────────
func TestProperty_EscapeFunctions_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return escapeHelp(s) == escapeHelp(s) &&
			escapeLabelValue(s) == escapeLabelValue(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: escapeLabelValue output never contains raw " ───
// Prometheus format invariant: label values are quoted with ".
// Any raw " in output would break the line parser.
func TestProperty_EscapeLabelValue_NoRawQuote(t *testing.T) {
	f := func(s string) bool {
		out := escapeLabelValue(s)
		// Every " in output must be preceded by \.
		for i := 0; i < len(out); i++ {
			if out[i] == '"' {
				if i == 0 || out[i-1] != '\\' {
					return false
				}
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: escapeLabelValue never emits raw \n ────────────
// Prometheus format is line-based; raw \n would break the parser.
func TestProperty_EscapeLabelValue_NoRawNewline(t *testing.T) {
	f := func(s string) bool {
		return !strings.Contains(escapeLabelValue(s), "\n")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: escapeHelp never emits raw \n ──────────────────
// HELP lines must stay on a single line per Prometheus spec.
func TestProperty_EscapeHelp_NoRawNewline(t *testing.T) {
	f := func(s string) bool {
		return !strings.Contains(escapeHelp(s), "\n")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: escapeHelp doubles backslashes ─────────────────
func TestProperty_EscapeHelp_BackslashDoubled(t *testing.T) {
	cases := map[string]string{
		`backslash\here`:      `backslash\\here`,
		`newline\nhere`:       `newline\\nhere`,
		"actual\nnewline":     `actual\nnewline`,
		`\\`:                  `\\\\`,
		``:                    ``,
		`plain help text`:     `plain help text`,
	}
	for in, want := range cases {
		if got := escapeHelp(in); got != want {
			t.Fatalf("escapeHelp(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: escapeLabelValue handles all three metachars ───
func TestProperty_EscapeLabelValue_AllMetachars(t *testing.T) {
	cases := map[string]string{
		`say "hi"`:           `say \"hi\"`,
		`path\to\file`:       `path\\to\\file`,
		"line1\nline2":       `line1\nline2`,
		``:                   ``,
		`plain-value`:        `plain-value`,
		`"quote\newline\n"`:  `\"quote\\newline\\n\"`,
	}
	for in, want := range cases {
		if got := escapeLabelValue(in); got != want {
			t.Fatalf("escapeLabelValue(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: formatFloat output parses back as a number ─────
func TestProperty_FormatFloat_Parseable(t *testing.T) {
	f := func(v float64) bool {
		// Skip NaN / Inf (fmt produces non-numeric; document behavior).
		if v != v { // NaN
			return true
		}
		out := formatFloat(v)
		// Trimmed trailing "0" or "." can produce "" for exact zero.
		if out == "" || out == "-" {
			return v == 0 || v == -0
		}
		_, err := strconv.ParseFloat(out, 64)
		return err == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: formatFloat has no scientific notation ─────────
// Prometheus text format is permissive but scrapers historically
// had bugs with e-notation; keep plain decimal.
func TestProperty_FormatFloat_NoScientific(t *testing.T) {
	f := func(v float64) bool {
		if v != v { // NaN
			return true
		}
		out := formatFloat(v)
		return !strings.ContainsAny(out, "eE")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: formatFloat strips trailing zeros and dots ─────
func TestProperty_FormatFloat_StripsTrailing(t *testing.T) {
	cases := map[float64]string{
		1.0:    "1",
		1.5:    "1.5",
		0.0:    "0",
		-1.5:   "-1.5",
		3.14:   "3.14",
		100.0:  "100",
	}
	for in, want := range cases {
		if got := formatFloat(in); got != want {
			t.Fatalf("formatFloat(%v) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: formatLabels never panics ──────────────────────
func TestProperty_FormatLabels_NoPanic(t *testing.T) {
	f := func(names []string, key string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on names=%v key=%q: %v", names, key, r)
			}
		}()
		_ = formatLabels(names, key)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: formatLabels output uses name="value" syntax ───
func TestProperty_FormatLabels_SyntaxLock(t *testing.T) {
	got := formatLabels([]string{"a", "b"}, "x\x00y")
	// Must contain: a="x",b="y"
	if !strings.Contains(got, `a="x"`) || !strings.Contains(got, `b="y"`) {
		t.Fatalf("formatLabels: want a=\"x\",b=\"y\"; got %q", got)
	}
}

// ── Property: formatLabels shorter key than names → empty val ─
func TestProperty_FormatLabels_ShortKey(t *testing.T) {
	got := formatLabels([]string{"a", "b", "c"}, "x\x00y")
	if !strings.Contains(got, `c=""`) {
		t.Fatalf("missing label got empty string, got %q", got)
	}
}
