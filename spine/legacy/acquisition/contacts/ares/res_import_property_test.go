package ares

import (
	"strings"
	"testing"
	"testing/quick"
	"time"
	"unicode/utf8"
)

// ── padICO ────────────────────────────────────────────────────────────────────

// TestPadICO_NeverPanics: property — any string input, including adversarial ones.
func TestPadICO_NeverPanics(t *testing.T) {
	f := func(ico string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on ico=%q: %v", ico, r)
			}
		}()
		_ = padICO(ico)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestPadICO_AlwaysAtLeast8Bytes: output is always ≥ 8 bytes.
func TestPadICO_AlwaysAtLeast8Bytes(t *testing.T) {
	f := func(ico string) bool {
		out := padICO(ico)
		return len(out) >= 8
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestPadICO_Idempotent: calling twice gives the same result.
func TestPadICO_Idempotent(t *testing.T) {
	f := func(ico string) bool {
		once := padICO(ico)
		twice := padICO(once)
		return once == twice
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestPadICO_MonkeyInputs covers empty, long, unicode, and SQL-injection strings.
func TestPadICO_MonkeyInputs(t *testing.T) {
	cases := []struct {
		in   string
		desc string
	}{
		{"", "empty"},
		{strings.Repeat("x", 10000), "10000-char string"},
		{"12345678", "already 8 digits"},
		{"1234567", "7 digits"},
		{"1", "single digit"},
		{"'; DROP TABLE companies; --", "SQL injection"},
		{"⚙️🔧🏗️", "emoji/unicode"},
		{"00000000", "eight zeros"},
		{"\x00\x01\x02", "null bytes"},
		{"  1234  ", "spaces around digits"},
	}
	for _, c := range cases {
		t.Run(c.desc, func(t *testing.T) {
			out := padICO(c.in)
			if len(out) < 8 {
				t.Errorf("padICO(%q) = %q, len %d < 8", c.in, out, len(out))
			}
		})
	}
}

// TestPadICO_KnownValues verifies concrete Czech ICO padding.
func TestPadICO_KnownValues(t *testing.T) {
	expectations := map[string]string{
		"1234567":   "01234567",
		"123456":    "00123456",
		"12345":     "00012345",
		"12345678":  "12345678",
		"123456789": "123456789",
	}
	for in, want := range expectations {
		got := padICO(in)
		if got != want {
			t.Errorf("padICO(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── normalizeNACE ─────────────────────────────────────────────────────────────

// TestNormalizeNACE_NeverPanics: property — any string input.
func TestNormalizeNACE_NeverPanics(t *testing.T) {
	f := func(nace string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on nace=%q: %v", nace, r)
			}
		}()
		_ = normalizeNACE(nace)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestNormalizeNACE_NoDots: output never contains a dot.
func TestNormalizeNACE_NoDots(t *testing.T) {
	f := func(nace string) bool {
		out := normalizeNACE(nace)
		return !strings.Contains(out, ".")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestNormalizeNACE_TrimmedLeadingTrailingSpaces: output has no leading/trailing spaces.
func TestNormalizeNACE_TrimmedLeadingTrailingSpaces(t *testing.T) {
	f := func(nace string) bool {
		out := normalizeNACE(nace)
		return out == strings.TrimSpace(out)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestNormalizeNACE_Idempotent: calling twice gives the same result.
func TestNormalizeNACE_Idempotent(t *testing.T) {
	f := func(nace string) bool {
		once := normalizeNACE(nace)
		twice := normalizeNACE(once)
		return once == twice
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestNormalizeNACE_KnownValues verifies the documented ARES/CSÚ normalization.
func TestNormalizeNACE_KnownValues(t *testing.T) {
	cases := []struct{ in, want string }{
		{"68.20", "6820"},
		{"28.41", "2841"},
		{"6820", "6820"},
		{"", ""},
		{"  6820  ", "6820"},
		{"  68.20  ", "6820"},
	}
	for _, c := range cases {
		got := normalizeNACE(c.in)
		if got != c.want {
			t.Errorf("normalizeNACE(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestNormalizeNACE_MonkeyInputs covers adversarial NACE inputs.
func TestNormalizeNACE_MonkeyInputs(t *testing.T) {
	adversarial := []string{
		"",
		strings.Repeat(".", 10000),
		"'; DROP TABLE companies; --",
		"⚙️68.20🔧",
		"\x00\x01\x02",
		".....",
		"  ",
	}
	for _, in := range adversarial {
		out := normalizeNACE(in)
		if strings.Contains(out, ".") {
			t.Errorf("normalizeNACE(%q) = %q still contains dot", in, out)
		}
		if out != strings.TrimSpace(out) {
			t.Errorf("normalizeNACE(%q) = %q has leading/trailing space", in, out)
		}
	}
}

// ── extractRow ────────────────────────────────────────────────────────────────

// TestExtractRow_NeverPanics: property — arbitrary record lengths and column maps.
func TestExtractRow_NeverPanics(t *testing.T) {
	f := func(record []string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on record=%v: %v", record, r)
			}
		}()
		maps := []colMap{
			{ico: 0, ddatvzn: 1, ddatzan: 2, forma: 3, nace: 4},
			{ico: -1, ddatvzn: -1, ddatzan: -1, forma: -1, nace: -1},
			{ico: 100, ddatvzn: 200, ddatzan: 300, forma: 400, nace: 500},
		}
		for _, m := range maps {
			_ = extractRow(record, m)
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestExtractRow_OutOfBoundsIndex: negative or oversized index returns empty string.
func TestExtractRow_OutOfBoundsIndex(t *testing.T) {
	record := []string{"12345678", "2010-01-01", "", "112", "6820"}
	m := colMap{ico: -1, ddatvzn: 100, ddatzan: -5, forma: 3, nace: 4}
	row := extractRow(record, m)
	if row.ICO != "" {
		t.Errorf("ico with index -1 should be empty, got %q", row.ICO)
	}
	if row.DatumVzniku != "" {
		t.Errorf("datumVzniku with index 100 should be empty, got %q", row.DatumVzniku)
	}
	if row.DatumZaniku != "" {
		t.Errorf("datumZaniku with index -5 should be empty, got %q", row.DatumZaniku)
	}
	if row.LegalForm != "112" {
		t.Errorf("forma at index 3 should be '112', got %q", row.LegalForm)
	}
	if row.NACEPrimary != "6820" {
		t.Errorf("nace at index 4 should be '6820', got %q", row.NACEPrimary)
	}
}

// TestExtractRow_TrimsWhitespace: all fields are trimmed.
func TestExtractRow_TrimsWhitespace(t *testing.T) {
	record := []string{"  12345678  ", "  2010-01-01  ", "  ", "  112  ", "  6820  "}
	m := colMap{ico: 0, ddatvzn: 1, ddatzan: 2, forma: 3, nace: 4}
	row := extractRow(record, m)
	if row.ICO != "12345678" {
		t.Errorf("ICO not trimmed: got %q", row.ICO)
	}
	if row.NACEPrimary != "6820" {
		t.Errorf("NACEPrimary not trimmed: got %q", row.NACEPrimary)
	}
	if row.DatumZaniku != "" {
		t.Errorf("whitespace-only DatumZaniku should be empty after trim, got %q", row.DatumZaniku)
	}
}

// TestExtractRow_EmptyRecord: all-empty record with valid indices returns empty strings.
func TestExtractRow_EmptyRecord(t *testing.T) {
	m := colMap{ico: 0, ddatvzn: 1, ddatzan: 2, forma: 3, nace: 4}
	row := extractRow([]string{}, m)
	if row.ICO != "" || row.DatumVzniku != "" || row.NACEPrimary != "" {
		t.Errorf("empty record should produce empty fields: %+v", row)
	}
}

// ── resolveColumns ────────────────────────────────────────────────────────────

// TestResolveColumns_RequiredColumnsPresent: valid header succeeds.
func TestResolveColumns_RequiredColumnsPresent(t *testing.T) {
	header := []string{"ICO", "DDATVZN", "DDATZAN", "FORMA", "NACE"}
	m, err := resolveColumns(header)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.ico != 0 || m.ddatvzn != 1 || m.ddatzan != 2 || m.forma != 3 || m.nace != 4 {
		t.Errorf("wrong indices: %+v", m)
	}
}

// TestResolveColumns_MissingRequiredProperty: all combinations of missing required columns.
func TestResolveColumns_MissingRequiredProperty(t *testing.T) {
	cases := [][]string{
		{"DDATVZN", "NACE"},              // missing ICO
		{"ICO", "NACE"},                  // missing DDATVZN
		{"ICO", "DDATVZN"},               // missing NACE
		{},                               // empty header
	}
	for _, header := range cases {
		_, err := resolveColumns(header)
		if err == nil {
			t.Errorf("expected error for header %v", header)
		}
	}
}

// TestResolveColumns_CaseInsensitive: header matching is case-insensitive (via ToUpper).
func TestResolveColumns_CaseInsensitive(t *testing.T) {
	header := []string{"ico", "ddatvzn", "ddatzan", "forma", "nace"}
	_, err := resolveColumns(header)
	if err != nil {
		t.Fatalf("case-insensitive resolveColumns failed: %v", err)
	}
}

// TestResolveColumns_OptionalColumnsAbsent: optional columns get -1 index.
func TestResolveColumns_OptionalColumnsAbsent(t *testing.T) {
	header := []string{"ICO", "DDATVZN", "NACE"} // no DDATZAN, no FORMA
	m, err := resolveColumns(header)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.ddatzan != -1 {
		t.Errorf("absent DDATZAN should be -1, got %d", m.ddatzan)
	}
	if m.forma != -1 {
		t.Errorf("absent FORMA should be -1, got %d", m.forma)
	}
}

// TestResolveColumns_MonkeyInputs: adversarial headers never panic.
func TestResolveColumns_MonkeyInputs(t *testing.T) {
	adversarial := [][]string{
		nil,
		{""},
		{strings.Repeat("X", 10000)},
		{"'; DROP TABLE --", "ICO", "DDATVZN", "NACE"},
		{"ICO\x00", "DDATVZN\x00", "NACE\x00"},
		{"ICO ", " DDATVZN ", " NACE "},
	}
	for _, h := range adversarial {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on header=%v: %v", h, r)
				}
			}()
			_, _ = resolveColumns(h)
		}()
	}
}

// ── FormatRESResult ───────────────────────────────────────────────────────────

// TestFormatRESResult_NeverPanics: property — random result and elapsed.
func TestFormatRESResult_NeverPanics(t *testing.T) {
	f := func(parsed, updated, notFound, skipped, errors int) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic: %v", r)
			}
		}()
		res := &RESImportResult{
			Parsed:   parsed,
			Updated:  updated,
			NotFound: notFound,
			Skipped:  skipped,
			Errors:   errors,
		}
		_ = FormatRESResult(res, 5*time.Second)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestFormatRESResult_ZeroElapsedValidUTF8: zero elapsed doesn't panic and output is valid UTF-8.
func TestFormatRESResult_ZeroElapsedValidUTF8(t *testing.T) {
	res := &RESImportResult{Parsed: 100, Updated: 50}
	out := FormatRESResult(res, 0)
	if !utf8.ValidString(out) {
		t.Errorf("output is not valid UTF-8")
	}
}

// TestFormatRESResult_ContainsKeyFields: output mentions the important numeric fields.
func TestFormatRESResult_ContainsKeyFields(t *testing.T) {
	res := &RESImportResult{
		Parsed:   1000,
		Updated:  800,
		NotFound: 150,
		Skipped:  40,
		Errors:   10,
	}
	out := FormatRESResult(res, 10*time.Second)
	checks := []string{"1000", "800", "150", "40", "10"}
	for _, s := range checks {
		if !strings.Contains(out, s) {
			t.Errorf("FormatRESResult output missing %q:\n%s", s, out)
		}
	}
}
