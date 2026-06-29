package sanitizer

import (
	"relay/internal/model"
	"strings"
	"testing"
)

func TestSanitizeIntakeClean(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "Help needed",
		Body:    "I need assistance leaving the area.",
	})
	if result.Status != "clean" {
		t.Fatalf("expected clean, got %s", result.Status)
	}
	if result.NormalizedSubject != "Help needed" {
		t.Fatalf("unexpected subject: %s", result.NormalizedSubject)
	}
}

func TestSanitizeIntakeBlocksScript(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "Test",
		Body:    "Hello <script>alert('xss')</script> world",
	})
	if result.Status != "blocked" {
		t.Fatalf("expected blocked, got %s", result.Status)
	}
	if !result.HasBlockedContent {
		t.Fatal("expected HasBlockedContent=true")
	}
}

func TestSanitizeIntakeStripsHTML(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "Test",
		Body:    "Hello <div>world</div> <span>test</span>",
	})
	if result.HasHTML != true {
		t.Fatal("expected HasHTML=true")
	}
	if result.NormalizedBody != "Hello world test" {
		t.Fatalf("unexpected body: %q", result.NormalizedBody)
	}
}

func TestStripHeaders(t *testing.T) {
	svc := NewService()
	headers := map[string]string{
		"Content-Type":      "text/plain",
		"X-Originating-IP":  "192.168.1.1",
		"User-Agent":        "Mozilla/5.0",
		"X-Custom":          "safe",
		"X-Forwarded-For":   "10.0.0.1",
	}
	clean := svc.StripHeaders(headers)

	if _, ok := clean["X-Originating-IP"]; ok {
		t.Fatal("X-Originating-IP should be stripped")
	}
	if _, ok := clean["User-Agent"]; ok {
		t.Fatal("User-Agent should be stripped")
	}
	if _, ok := clean["X-Forwarded-For"]; ok {
		t.Fatal("X-Forwarded-For should be stripped")
	}
	if clean["Content-Type"] != "text/plain" {
		t.Fatal("Content-Type should be preserved")
	}
	if clean["X-Custom"] != "safe" {
		t.Fatal("X-Custom should be preserved")
	}
}

// TestSanitizeIntakeInvalidUTF8Subject — invalid UTF-8 in subject is fixed
func TestSanitizeIntakeInvalidUTF8Subject(t *testing.T) {
	svc := NewService()
	// \xFF \xFE are invalid UTF-8 bytes
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "Hello \xFF\xFE World",
		Body:    "body",
	})
	// The note should say "invalid_utf8_in_subject"
	found := false
	for _, note := range result.Notes {
		if note == "invalid_utf8_in_subject" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected invalid_utf8_in_subject note in %v", result.Notes)
	}
}

// TestSanitizeIntakeInvalidUTF8Body — invalid UTF-8 in body is fixed
func TestSanitizeIntakeInvalidUTF8Body(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "Subj",
		Body:    "Hello \xFF\xFE World",
	})
	// Should be fixed to valid UTF-8
	found := false
	for _, note := range result.Notes {
		if note == "invalid_utf8_in_body" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected invalid_utf8_in_body note in %v", result.Notes)
	}
}

// TestSanitizeIntakeBlockedVBScript — vbscript: URI triggers blocked
func TestSanitizeIntakeBlockedVBScript(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "test",
		Body:    "Click vbscript:msgbox('xss')",
	})
	if result.Status != "blocked" {
		t.Fatalf("expected blocked, got %q", result.Status)
	}
	if !result.HasBlockedContent {
		t.Fatal("expected HasBlockedContent=true")
	}
}

// ──────────────────────────────────────────────────────────────────────
// normalizeWhitespace — paragraph-preserving whitespace normalization.
//
// RCA Sprint X vs Y (2026-05-04, docs/initiatives/2026-05-04-anti-trace-
// incremental-verification.md): identical body via /v1/raw-smtp-test
// (no sanitizer) delivered 5/5 INBOX; same body via /v1/submit (this
// sanitizer) delivered 3/5 INBOX. The kill differentiator was
// strings.Fields collapsing all newlines + spaces into single-line
// wall-of-text. Tests below lock in paragraph-preserving behaviour so a
// future refactor can't re-introduce the collapse.
// ──────────────────────────────────────────────────────────────────────

func TestNormalizeWhitespace_PreservesParagraphBreaks(t *testing.T) {
	in := "Dobrý den,\n\nmate u Vas pouzitou techniku?\n\nDiky"
	out := normalizeWhitespace(in)
	want := "Dobrý den,\n\nmate u Vas pouzitou techniku?\n\nDiky"
	if out != want {
		t.Fatalf("paragraph breaks lost\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_PreservesSingleNewline(t *testing.T) {
	in := "Line one\nLine two\nLine three"
	out := normalizeWhitespace(in)
	want := "Line one\nLine two\nLine three"
	if out != want {
		t.Fatalf("single newlines lost\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_CollapsesIntraLineSpaces(t *testing.T) {
	in := "word1   word2\t\tword3"
	out := normalizeWhitespace(in)
	want := "word1 word2 word3"
	if out != want {
		t.Fatalf("intra-line whitespace not collapsed\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_BlankLineBetweenParagraphs(t *testing.T) {
	in := "First.\n   \nSecond."
	out := normalizeWhitespace(in)
	want := "First.\n\nSecond."
	if out != want {
		t.Fatalf("blank line whitespace not normalized\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_TrailingNewline(t *testing.T) {
	in := "Body text\n"
	out := normalizeWhitespace(in)
	want := "Body text\n"
	if out != want {
		t.Fatalf("trailing newline behavior changed\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_EmptyString(t *testing.T) {
	if got := normalizeWhitespace(""); got != "" {
		t.Fatalf("empty input must return empty, got %q", got)
	}
}

func TestNormalizeWhitespace_OnlyWhitespace(t *testing.T) {
	in := "   \t\t  "
	out := normalizeWhitespace(in)
	want := ""
	if out != want {
		t.Fatalf("whitespace-only must collapse to empty\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_MixedTabsAndSpaces(t *testing.T) {
	in := "Foo\tbar  baz\n  qux\tquux"
	out := normalizeWhitespace(in)
	want := "Foo bar baz\nqux quux"
	if out != want {
		t.Fatalf("mixed whitespace handling\nwant: %q\ngot:  %q", want, out)
	}
}

func TestNormalizeWhitespace_OutreachTemplateRoundTrip(t *testing.T) {
	in := "Dobrý den,\n\nmate u Vas pouzitou techniku, ktere se chcete zbavit?\nAuto, dodavku, traktor, stavebni stroj... cokoli.\n\nDiky,\nGoran Nowak"
	out := normalizeWhitespace(in)
	if !strings.Contains(out, "\n\n") {
		t.Fatal("paragraph breaks (\\n\\n) must survive")
	}
	if strings.Contains(out, "  ") {
		t.Fatalf("double-space inside lines must collapse: %q", out)
	}
	// At least 4 newlines (paragraph + 3 internal line breaks)
	if strings.Count(out, "\n") < 4 {
		t.Fatalf("expected ≥4 newlines, got %d in %q", strings.Count(out, "\n"), out)
	}
}

func TestNormalizeWhitespace_CRLFInputNormalized(t *testing.T) {
	// Input may contain Windows-style line endings; sanitizer should still
	// handle them deterministically. \r is dropped by stripControlChars
	// upstream, but normalize must not reintroduce single-line collapse.
	in := "Foo\nBar\nBaz"
	out := normalizeWhitespace(in)
	want := "Foo\nBar\nBaz"
	if out != want {
		t.Fatalf("LF-only input round-trip\nwant: %q\ngot:  %q", want, out)
	}
}

// TestSanitizeIntake_ProductionTemplatePreservesStructure end-to-end check
// that the full SanitizeIntake call (the path /v1/submit takes) preserves
// the multi-paragraph shape of a real production template body.
func TestSanitizeIntake_ProductionTemplatePreservesStructure(t *testing.T) {
	svc := NewService()
	body := "Dobrý den,\n\nmate u Vas pouzitou techniku?\n\nDiky,\nGoran Nowak"
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "Vykup pouzite techniky",
		Body:    body,
	})
	if result.Status != "clean" {
		t.Fatalf("status=%q, want clean", result.Status)
	}
	if !strings.Contains(result.NormalizedBody, "\n\n") {
		t.Fatalf("body lost paragraph breaks: %q", result.NormalizedBody)
	}
	if strings.Count(result.NormalizedBody, "\n") < 4 {
		t.Fatalf("body lost line breaks (got %d \\n in %q)",
			strings.Count(result.NormalizedBody, "\n"), result.NormalizedBody)
	}
}
