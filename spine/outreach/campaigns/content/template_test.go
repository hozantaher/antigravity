package content

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSubstituteVars_AllFields(t *testing.T) {
	vars := TemplateVars{
		Firma:    "TechnoTrade s.r.o.",
		Jmeno:    "Jan",
		Prijmeni: "Novák",
		Region:   "Plzeň",
		ICO:      "12345678",
		Podpis:   "Jan Novák\nTel: 123",
	}

	template := "Dobrý den {{jmeno}} {{prijmeni}}, firma {{firma}} z {{region}}, IČO {{ico}}. {{podpis}}"
	result := substituteVars(template, vars)

	for _, expected := range []string{"Jan", "Novák", "TechnoTrade s.r.o.", "Plzeň", "12345678", "Jan Novák"} {
		if !strings.Contains(result, expected) {
			t.Errorf("missing %q in result: %s", expected, result)
		}
	}
}

func TestSubstituteVars_DotNotation(t *testing.T) {
	vars := TemplateVars{Firma: "Test Corp", Jmeno: "Marie"}
	result := substituteVars("{{.Firma}} - {{.Jmeno}}", vars)

	if result != "Test Corp - Marie" {
		t.Errorf("expected 'Test Corp - Marie', got %q", result)
	}
}

func TestSubstituteVars_EmptyVars(t *testing.T) {
	vars := TemplateVars{}
	result := substituteVars("Hello {{jmeno}}, firma {{firma}}", vars)

	if result != "Hello , firma " {
		t.Errorf("expected empty substitutions, got %q", result)
	}
}

func TestResolveConditionals_KeepBlock(t *testing.T) {
	vars := TemplateVars{Jmeno: "Jan"}
	text := "Before {{if .Jmeno}}Hello Jan{{end}} After"
	result := resolveConditionals(text, vars)

	if !strings.Contains(result, "Hello Jan") {
		t.Errorf("expected block to be kept: %q", result)
	}
	if strings.Contains(result, "{{if") || strings.Contains(result, "{{end}}") {
		t.Errorf("tags should be removed: %q", result)
	}
}

func TestResolveConditionals_RemoveBlock(t *testing.T) {
	vars := TemplateVars{Jmeno: ""}
	text := "Before {{if .Jmeno}}Hello Jan{{end}} After"
	result := resolveConditionals(text, vars)

	if strings.Contains(result, "Hello Jan") {
		t.Errorf("expected block to be removed: %q", result)
	}
	if !strings.Contains(result, "Before") || !strings.Contains(result, "After") {
		t.Errorf("surrounding text should remain: %q", result)
	}
}

func TestResolveConditionals_MultipleBlocks(t *testing.T) {
	vars := TemplateVars{Jmeno: "Jan", Region: "", Firma: "Corp"}
	text := "{{if .Jmeno}}name{{end}} {{if .Region}}region{{end}} {{if .Firma}}firma{{end}}"
	result := resolveConditionals(text, vars)

	if !strings.Contains(result, "name") {
		t.Error("Jmeno block should be kept")
	}
	if strings.Contains(result, "region") {
		t.Error("Region block should be removed")
	}
	if !strings.Contains(result, "firma") {
		t.Error("Firma block should be kept")
	}
}

func TestExtractSubjects_Multiple(t *testing.T) {
	content := `{{/* subject: Poptávka strojů */}}
{{/* subject: Zájem o spolupráci */}}
{{/* subject: Nákup těžké techniky */}}
Body text here`

	subjects := extractSubjects(content)
	if len(subjects) != 3 {
		t.Fatalf("expected 3 subjects, got %d", len(subjects))
	}
	if subjects[0] != "Poptávka strojů" {
		t.Errorf("subject 0: expected 'Poptávka strojů', got %q", subjects[0])
	}
}

func TestExtractSubjects_Fallback(t *testing.T) {
	subjects := extractSubjects("No subject comments here")
	if len(subjects) != 1 || subjects[0] != "Poptávka" {
		t.Errorf("expected fallback ['Poptávka'], got %v", subjects)
	}
}

func TestRemoveSubjectComments(t *testing.T) {
	content := "{{/* subject: Test */}}\nBody line 1\nBody line 2"
	result := removeSubjectComments(content)

	if strings.Contains(result, "subject:") {
		t.Errorf("subject comment should be removed: %q", result)
	}
	if !strings.Contains(result, "Body line 1") {
		t.Error("body should be preserved")
	}
}

func TestDeterministicSeed_SameInput(t *testing.T) {
	s1 := deterministicSeed(42, 0)
	s2 := deterministicSeed(42, 0)
	if s1 != s2 {
		t.Error("same contactID+step should produce same seed")
	}
}

func TestDeterministicSeed_DifferentInputs(t *testing.T) {
	s1 := deterministicSeed(42, 0)
	s2 := deterministicSeed(42, 1)
	s3 := deterministicSeed(43, 0)

	if s1 == s2 {
		t.Error("different step should produce different seed")
	}
	if s1 == s3 {
		t.Error("different contactID should produce different seed")
	}
}

func TestPlainToHTML_Paragraphs(t *testing.T) {
	result := plainToHTML("First paragraph\n\nSecond paragraph")

	// Paragraph break must close one <p> and open another. <p> now carries
	// inline style for webmail-visible margin spacing (operator decision
	// 2026-05-08), so check for </p><p with the style prefix.
	if !strings.Contains(result, `</p><p style=`) {
		t.Errorf("double newline should create paragraph break with styled <p>: %s", result)
	}
	if !strings.HasPrefix(result, `<html><body><p style=`) {
		t.Errorf("body must open with styled <p>: %s", result)
	}
}

func TestPlainToHTML_LineBreaks(t *testing.T) {
	result := plainToHTML("Line 1\nLine 2")

	if !strings.Contains(result, "<br>") {
		t.Error("single newline should create <br>")
	}
}

func TestPlainToHTML_EscapesHTML(t *testing.T) {
	result := plainToHTML("1 < 2 & 3 > 1")

	if strings.Contains(result, " < ") || strings.Contains(result, " & ") || strings.Contains(result, " > ") {
		t.Errorf("should escape HTML entities: %s", result)
	}
	if !strings.Contains(result, "&lt;") || !strings.Contains(result, "&amp;") || !strings.Contains(result, "&gt;") {
		t.Errorf("missing escaped entities: %s", result)
	}
}

// TestPlainToHTML_FooterNoHR: --- on its own line drops to a styled <p>
// for the footer block — no <hr> element. Operator decision 2026-05-08
// (third revision): explicit HR + italic still drew the eye; whitespace
// separation via margin-top only is enough. Italic also dropped.
func TestPlainToHTML_FooterNoHR(t *testing.T) {
	in := "Body text.\n\n---\nFooter compliance text."
	out := plainToHTML(in)
	if strings.Contains(out, `<hr`) {
		t.Errorf("--- should NOT produce <hr> (whitespace separation only): %s", out)
	}
	if !strings.Contains(out, "Footer compliance text") {
		t.Errorf("footer content lost: %s", out)
	}
	if !strings.Contains(out, "color:#aaa") {
		t.Errorf("footer should be lighter grey #aaa: %s", out)
	}
	if strings.Contains(out, "font-style:italic") {
		t.Errorf("footer should NOT be italic (third revision): %s", out)
	}
	if !strings.Contains(out, "margin:32px 0 0 0") {
		t.Errorf("footer should have margin-top:32px for whitespace separation: %s", out)
	}
}

// TestPlainToHTML_NoHR_NoSmall: input without --- doesn't get <hr> or <small>.
func TestPlainToHTML_NoHR_NoSmall(t *testing.T) {
	out := plainToHTML("Plain body, no separator.\n\nSecond paragraph.")
	if strings.Contains(out, "<hr>") {
		t.Errorf("no --- → no <hr>: %s", out)
	}
	if strings.Contains(out, "<small>") {
		t.Errorf("no --- → no <small>: %s", out)
	}
}

// TestPlainToHTML_SigDash_NotHR: -- (signature delimiter) is NOT converted
// to <hr>. Only the 3-dash form acts as the body↔footer divider.
func TestPlainToHTML_SigDash_NotHR(t *testing.T) {
	in := "Body.\n\n--\nSignature line."
	out := plainToHTML(in)
	if strings.Contains(out, "<hr>") {
		t.Errorf("-- (sigdash) must NOT become <hr>: %s", out)
	}
}

// TestPlainToHTML_ParagraphMargin: every <p> carries inline margin style
// so paragraph spacing is visible in webmail clients (Gmail/Outlook strip
// <head> styles). Operator decision 2026-05-08.
func TestPlainToHTML_ParagraphMargin(t *testing.T) {
	out := plainToHTML("Para1.\n\nPara2.")
	if !strings.Contains(out, "margin:0 0 16px 0") {
		t.Errorf("<p> must carry inline margin style: %s", out)
	}
}

// TestPlainToHTML_MarkdownBold: **text** in DB body → <strong> in HTML.
// Operator decision 2026-05-08 (revision): bold is operator-controlled
// via Markdown, not positional — matches historical Garaaage screenshot
// where specific phrases (CTAs, hooks) were bold, not the whole sign-off.
func TestPlainToHTML_MarkdownBold(t *testing.T) {
	in := "Body with **bold phrase** inline."
	out := plainToHTML(in)
	if !strings.Contains(out, "<strong>bold phrase</strong>") {
		t.Errorf("**...** should produce <strong>: %s", out)
	}
}

// TestPlainToHTML_BoldNonGreedy: multiple bold spans don't merge across
// regular text between them.
func TestPlainToHTML_BoldNonGreedy(t *testing.T) {
	in := "**first** then plain then **second**."
	out := plainToHTML(in)
	if !strings.Contains(out, "<strong>first</strong>") {
		t.Errorf("first span lost: %s", out)
	}
	if !strings.Contains(out, "<strong>second</strong>") {
		t.Errorf("second span lost: %s", out)
	}
	// regression: greedy match would produce <strong>first** then plain then **second</strong>
	if strings.Contains(out, "<strong>first</strong> then plain then <strong>second</strong>") == false {
		t.Errorf("non-greedy match required: %s", out)
	}
}

// TestPlainToHTML_FooterStyle: footer renders subtle — light grey, smaller
// font, regular weight (no italic). Operator decision 2026-05-08 (third
// revision): "GDPR je stále moc nápadná" with italic + 0.9em + #888.
func TestPlainToHTML_FooterStyle(t *testing.T) {
	in := "Body.\n\n---\nFooter line."
	out := plainToHTML(in)
	if !strings.Contains(out, "color:#aaa") {
		t.Errorf("footer should be light grey #aaa: %s", out)
	}
	if !strings.Contains(out, "font-size:0.8em") {
		t.Errorf("footer should be 0.8em: %s", out)
	}
	if strings.Contains(out, "font-style:italic") {
		t.Errorf("footer should NOT be italic (italic is itself an attention signal): %s", out)
	}
}

func TestRender_BasicTemplate(t *testing.T) {
	// Create temp template
	dir := t.TempDir()
	err := os.WriteFile(filepath.Join(dir, "test.tmpl"),
		[]byte("{{/* subject: Test subject */}}\nDobrý den {{jmeno}}, firma {{firma}}."),
		0644)
	if err != nil {
		t.Fatal(err)
	}

	engine := NewEngine(dir, nil)
	rendered, err := engine.Render("test", TemplateVars{
		Jmeno: "Jan",
		Firma: "Corp",
	}, 1, 0)
	if err != nil {
		t.Fatalf("render: %v", err)
	}

	if rendered.Subject != "Test subject" {
		t.Errorf("subject: expected 'Test subject', got %q", rendered.Subject)
	}
	if !strings.Contains(rendered.BodyPlain, "Jan") || !strings.Contains(rendered.BodyPlain, "Corp") {
		t.Errorf("body should contain substituted vars: %s", rendered.BodyPlain)
	}
	// HTML body populated (operator reverted plaintext-only later same day,
	// 2026-05-08 — wants old Garaaage visual style: inline bold + thin HR
	// + grey italic footer).
	if rendered.BodyHTML == "" {
		t.Error("HTML body must be populated")
	}
	if !strings.HasPrefix(rendered.BodyHTML, "<html><body>") {
		t.Errorf("HTML body must open with <html><body>: %s", rendered.BodyHTML)
	}
}

func TestRender_MissingTemplate(t *testing.T) {
	engine := NewEngine(t.TempDir(), nil)
	_, err := engine.Render("nonexistent", TemplateVars{}, 1, 0)
	if err == nil {
		t.Error("expected error for missing template")
	}
}

func TestListTemplates(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "initial.tmpl"), []byte("a"), 0644)
	os.WriteFile(filepath.Join(dir, "followup.tmpl"), []byte("b"), 0644)
	os.WriteFile(filepath.Join(dir, "not-a-template.txt"), []byte("c"), 0644)

	engine := NewEngine(dir, nil)
	templates := engine.ListTemplates()

	if len(templates) != 2 {
		t.Errorf("expected 2 templates, got %d: %v", len(templates), templates)
	}
}

func TestListTemplates_NonExistentDir(t *testing.T) {
	engine := NewEngine("/nonexistent/path/xyz", nil)
	templates := engine.ListTemplates()
	if templates != nil {
		t.Errorf("ListTemplates on missing dir should return nil, got %v", templates)
	}
}

func TestListTemplates_SubdirNotIncluded(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "real.tmpl"), []byte("x"), 0644)
	// Create a subdirectory — should be excluded
	os.Mkdir(filepath.Join(dir, "subdir.tmpl"), 0755)

	engine := NewEngine(dir, nil)
	templates := engine.ListTemplates()
	if len(templates) != 1 || templates[0] != "real" {
		t.Errorf("expected [real], got %v", templates)
	}
}

func TestRender_MultipleSubjects(t *testing.T) {
	dir := t.TempDir()
	content := "{{/* subject: Varianta A */}}\n{{/* subject: Varianta B */}}\nBody text\n"
	os.WriteFile(filepath.Join(dir, "multi.tmpl"), []byte(content), 0644)

	engine := NewEngine(dir, nil)
	rendered, err := engine.Render("multi", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if rendered.Subject != "Varianta A" && rendered.Subject != "Varianta B" {
		t.Errorf("multi-subject: got %q, want one of [Varianta A, Varianta B]", rendered.Subject)
	}
}

func TestResolveConditionals_UnclosedTag(t *testing.T) {
	// {{if .Jmeno}} without {{end}} → break on end < 0 → text unchanged
	text := "Hello {{if .Jmeno}}world"
	got := resolveConditionals(text, TemplateVars{Jmeno: "Jan"})
	if !strings.Contains(got, "{{if .Jmeno}}") {
		t.Errorf("unclosed conditional should leave text unchanged, got: %q", got)
	}
}

func TestRender_SignatureFromEngine(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.tmpl"), []byte("Body\n{{podpis}}"), 0644)

	sigs := []string{"Sig A", "Sig B"}
	engine := NewEngine(dir, sigs)
	rendered, err := engine.Render("test", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatal(err)
	}

	hasSig := strings.Contains(rendered.BodyPlain, "Sig A") || strings.Contains(rendered.BodyPlain, "Sig B")
	if !hasSig {
		t.Errorf("body should contain one of the signatures: %s", rendered.BodyPlain)
	}
}

func TestRender_ExistingSignatureNotOverridden(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.tmpl"), []byte("Body\n{{podpis}}"), 0644)

	sigs := []string{"Engine Sig"}
	engine := NewEngine(dir, sigs)
	// vars.Podpis is already set — engine signatures must NOT override it
	rendered, err := engine.Render("test", TemplateVars{Podpis: "Custom Sig"}, 1, 0)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(rendered.BodyPlain, "Custom Sig") {
		t.Errorf("existing Podpis should be preserved: %s", rendered.BodyPlain)
	}
	if strings.Contains(rendered.BodyPlain, "Engine Sig") {
		t.Errorf("engine signature should NOT override existing Podpis: %s", rendered.BodyPlain)
	}
}

// ── detectHumanizeOff ──

// TestDetectHumanizeOff_OffMarker catches `return true → false` mutation.
func TestDetectHumanizeOff_OffMarker(t *testing.T) {
	cases := []string{
		"{{/* humanize: off */}}",
		"{{/* humanize:off */}}",
		"{{/* humanize: false */}}",
		"{{/* humanize: no */}}",
		"{{/* humanize: 0 */}}",
		"  {{/* humanize: off */}}  ",
	}
	for _, c := range cases {
		if !detectHumanizeOff(c) {
			t.Errorf("expected true for %q", c)
		}
	}
}

// TestDetectHumanizeOff_NoMarker — Sprint A (2026-05-11) inverted the
// default: humanize is now OFF unless explicit opt-in. Bodies WITHOUT a
// humanize marker should return true (= skip humanize).
func TestDetectHumanizeOff_NoMarker(t *testing.T) {
	skipCases := []string{
		"Normal template body.",
		"{{/* subject: Poptávka */}}",
		"{{/* something else */}}",
		"",
	}
	for _, c := range skipCases {
		if !detectHumanizeOff(c) {
			t.Errorf("expected true (skip humanize) for %q under default-off invariant", c)
		}
	}
	// Opt-in markers flip to false (= do not skip; run humanize).
	optInCases := []string{
		"{{/* humanize: on */}}",
		"{{/* humanize: yes */}}",
		"{{/* humanize: true */}}",
		"{{/* humanize: 1 */}}",
	}
	for _, c := range optInCases {
		if detectHumanizeOff(c) {
			t.Errorf("expected false (humanize active) for opt-in marker %q", c)
		}
	}
}

// TestDetectHumanizeOff_MalformedCommentIgnored — a line with prefix but
// no closing `*/}}` must NOT be treated as a humanize directive.
// Default-off invariant: missing marker → true (skip humanize).
func TestDetectHumanizeOff_MalformedCommentIgnored(t *testing.T) {
	malformed := "{{/* humanize: off" // has prefix, no suffix → ignored → default-off
	if !detectHumanizeOff(malformed) {
		t.Errorf("malformed comment should fall through to default-off (true)")
	}
}

// TestRender_SkipHumanizeSetWhenMarkerPresent verifies that Render propagates
// the humanize-off flag through to RenderedEmail.SkipHumanize.
func TestRender_SkipHumanizeSetWhenMarkerPresent(t *testing.T) {
	dir := t.TempDir()
	tmpl := "{{/* humanize: off */}}\n{{/* subject: Testovací předmět */}}\nTělo mailu"
	os.WriteFile(filepath.Join(dir, "humanize_off.tmpl"), []byte(tmpl), 0644)

	engine := NewEngine(dir, nil)
	rendered, err := engine.Render("humanize_off", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if !rendered.SkipHumanize {
		t.Error("SkipHumanize must be true when template has {{/* humanize: off */}}")
	}
}

// TestRender_SkipHumanizeTrueByDefaultWhenNoMarker — Sprint A invariant:
// templates without any humanize directive default to SkipHumanize=true.
// Production templates are operator-curated final bodies; humanize must
// be explicit opt-in (`{{/* humanize: on */}}`).
func TestRender_SkipHumanizeTrueByDefaultWhenNoMarker(t *testing.T) {
	dir := t.TempDir()
	tmpl := "{{/* subject: Testovací předmět */}}\nTělo mailu bez humanize markeru"
	os.WriteFile(filepath.Join(dir, "normal.tmpl"), []byte(tmpl), 0644)

	engine := NewEngine(dir, nil)
	rendered, err := engine.Render("normal", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if !rendered.SkipHumanize {
		t.Error("SkipHumanize must be true by default (Sprint A 2026-05-11 default-off)")
	}
}

// TestRender_SkipHumanizeFalseWhenOptIn — `{{/* humanize: on */}}` flips to false.
func TestRender_SkipHumanizeFalseWhenOptIn(t *testing.T) {
	dir := t.TempDir()
	tmpl := "{{/* humanize: on */}}\n{{/* subject: Test */}}\nTělo"
	os.WriteFile(filepath.Join(dir, "opt_in.tmpl"), []byte(tmpl), 0644)

	engine := NewEngine(dir, nil)
	rendered, err := engine.Render("opt_in", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("Render error: %v", err)
	}
	if rendered.SkipHumanize {
		t.Error("SkipHumanize must be false when humanize: on marker present")
	}
}

// TestRender_MultipleSubjectsSelectsNonFirst catches the `> → <` mutation on
// `if len(subjects) > 1`. With different seeds, both subject variants must be
// reachable. We verify at least one seed picks a subject other than the first.
func TestRender_MultipleSubjectsSelectsNonFirst(t *testing.T) {
	dir := t.TempDir()
	tmpl := "{{/* subject: Předmět A */}}\n{{/* subject: Předmět B */}}\nTělo"
	os.WriteFile(filepath.Join(dir, "multi.tmpl"), []byte(tmpl), 0644)

	engine := NewEngine(dir, nil)

	subjects := make(map[string]bool)
	for contactID := int64(1); contactID <= 50; contactID++ {
		r, err := engine.Render("multi", TemplateVars{}, contactID, 0)
		if err != nil {
			t.Fatalf("Render error: %v", err)
		}
		subjects[r.Subject] = true
	}
	if len(subjects) < 2 {
		t.Errorf("expected both subjects to be selected across 50 seeds, only got: %v", subjects)
	}
}
