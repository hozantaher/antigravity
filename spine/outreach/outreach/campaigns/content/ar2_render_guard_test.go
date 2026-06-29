package content

// AR2 — Render-time anti-detection guard tests.
//
// Guards added in Sprint AR2:
//   - Short URL in rendered body → hard render fail (ErrShortURL)
//   - {{.OpenPixel}} unresolved (empty string after substitution) → body has no
//     leftover placeholder (vars.OpenPixel == "" is the normal path — no pixel emitted)
//
// ≥10 test cases per memory feedback_extreme_testing.

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// ── helper: file-only engine for AR2 tests ────────────────────────────────────

func ar2Engine(t *testing.T, templateName, body string) *Engine {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/"+templateName+".tmpl", []byte(body), 0o644); err != nil {
		t.Fatalf("write tmpl: %v", err)
	}
	return NewEngine(dir, nil)
}

// ── T-1: clean template renders OK ───────────────────────────────────────────

func TestAR2_CleanTemplate_Renders(t *testing.T) {
	e := ar2Engine(t, "clean", "{{/* subject: test */}}\nDobrý den, {{firma}}!")
	_, err := e.Render("clean", TemplateVars{Firma: "ACME"}, 1, 0)
	if err != nil {
		t.Fatalf("expected nil error, got: %v", err)
	}
}

// ── T-2: bit.ly short URL → hard fail ────────────────────────────────────────

func TestAR2_BitLy_HardFail(t *testing.T) {
	e := ar2Engine(t, "bitly", "{{/* subject: test */}}\nKlikněte zde: https://bit.ly/abc123")
	_, err := e.Render("bitly", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for bit.ly URL, got nil")
	}
	if !errors.Is(err, ErrShortURL) {
		t.Fatalf("expected ErrShortURL, got: %v", err)
	}
}

// ── T-3: t.co short URL → hard fail ──────────────────────────────────────────

func TestAR2_TCo_HardFail(t *testing.T) {
	e := ar2Engine(t, "tco", "{{/* subject: test */}}\nOdkaz: https://t.co/xyz")
	_, err := e.Render("tco", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for t.co URL, got nil")
	}
	if !errors.Is(err, ErrShortURL) {
		t.Fatalf("expected ErrShortURL, got: %v", err)
	}
}

// ── T-4: tinyurl.com short URL → hard fail ───────────────────────────────────

func TestAR2_TinyURL_HardFail(t *testing.T) {
	e := ar2Engine(t, "tiny", "{{/* subject: test */}}\nOdkaz: https://tinyurl.com/abc")
	_, err := e.Render("tiny", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for tinyurl URL, got nil")
	}
	if !errors.Is(err, ErrShortURL) {
		t.Fatalf("expected ErrShortURL, got: %v", err)
	}
}

// ── T-5: goo.gl short URL → hard fail ────────────────────────────────────────

func TestAR2_GooGl_HardFail(t *testing.T) {
	e := ar2Engine(t, "googl", "{{/* subject: test */}}\nhttps://goo.gl/maps/abc")
	_, err := e.Render("googl", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for goo.gl URL, got nil")
	}
	if !errors.Is(err, ErrShortURL) {
		t.Fatalf("expected ErrShortURL, got: %v", err)
	}
}

// ── T-6: ow.ly short URL → hard fail ─────────────────────────────────────────

func TestAR2_OwLy_HardFail(t *testing.T) {
	e := ar2Engine(t, "owly", "{{/* subject: test */}}\nhttps://ow.ly/xyz")
	_, err := e.Render("owly", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for ow.ly URL, got nil")
	}
	if !errors.Is(err, ErrShortURL) {
		t.Fatalf("expected ErrShortURL, got: %v", err)
	}
}

// ── T-7: full URL is NOT flagged ─────────────────────────────────────────────

func TestAR2_FullURL_NotFlagged(t *testing.T) {
	e := ar2Engine(t, "fullurl", "{{/* subject: test */}}\nhttps://garaaage.cz/vykup-techniky")
	_, err := e.Render("fullurl", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("full URL should not be flagged, got: %v", err)
	}
}

// ── T-8: template without any pixel renders without warn-related failure ──────
// (warn path is not a hard fail — this tests the happy-path invariant)

func TestAR2_NoPixel_Renders(t *testing.T) {
	e := ar2Engine(t, "nopixel", "{{/* subject: test */}}\nPlain text bez obrázků.")
	r, err := e.Render("nopixel", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(r.BodyPlain, "<img") {
		t.Error("body should not contain <img>")
	}
}

// ── T-9: short URL in subject does NOT fail (only body checked) ───────────────
// Subject line is typically plain text without links, but even if it contained
// a short URL it would be the body text that matters most. This documents
// the scoping decision: guard applies to rendered body, not subject.
//
// (This test documents behavior, not a bug — the subject is rarely where a
// short URL appears; the guard on body text is the meaningful protection.)

func TestAR2_ShortURL_InSubjectOnly_BodyClean_NoFail(t *testing.T) {
	// Subject comment contains "bit.ly" but body is clean.
	// After subject extraction, the bit.ly is in subject not body.
	e := ar2Engine(t, "subj_only", "{{/* subject: https://bit.ly/subject-link */}}\nTělo bez odkazů.")
	_, err := e.Render("subj_only", TemplateVars{}, 1, 0)
	// No error expected: guard operates on rendered body, subject is separate.
	if err != nil {
		t.Fatalf("expected no error (guard is body-only), got: %v", err)
	}
}

// ── T-10: error message names the template ────────────────────────────────────

func TestAR2_ErrorMessageNamesTemplate(t *testing.T) {
	e := ar2Engine(t, "my-template", "{{/* subject: test */}}\nhttps://bit.ly/xyz")
	_, err := e.Render("my-template", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "my-template") {
		t.Errorf("error should mention template name, got: %v", err)
	}
}

// ── T-11: shortURLRe case-insensitive (BIT.LY) ───────────────────────────────

func TestAR2_ShortURL_CaseInsensitive(t *testing.T) {
	e := ar2Engine(t, "upper", "{{/* subject: test */}}\nHTTPS://BIT.LY/ABC")
	_, err := e.Render("upper", TemplateVars{}, 1, 0)
	if err == nil {
		t.Fatal("expected error for uppercase BIT.LY, got nil")
	}
	if !errors.Is(err, ErrShortURL) {
		t.Fatalf("expected ErrShortURL, got: %v", err)
	}
}

// ── T-12: open-pixel HTML img tag without /o? path does not warn ─────────────
// Only the combination of <img + /o? (our tracking endpoint) is the signal.

func TestAR2_ImgTag_WithoutTrackingPath_OK(t *testing.T) {
	e := ar2Engine(t, "img_ok", `{{/* subject: test */}}`+"\n"+
		`<img src="https://garaaage.cz/logo.png" alt="logo">`)
	_, err := e.Render("img_ok", TemplateVars{}, 1, 0)
	if err != nil {
		t.Fatalf("img without tracking path should not fail, got: %v", err)
	}
}
