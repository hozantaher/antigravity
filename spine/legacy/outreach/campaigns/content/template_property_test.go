package content

// template_property_test.go — property+monkey tests for template.go functions.
// Targets: detectHumanizeOff missing branches, substituteVars, resolveConditionals,
// deterministicSeed, plainToHTML — edge cases not covered by template_test.go.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/quick"
)

// ─── detectHumanizeOff ─────────────────────────────────────────────────────

// Sprint A (2026-05-11) inverted detectHumanizeOff: default returns true
// (= skip humanize) when no marker is present. Only explicit opt-in
// (`humanize: on|yes|true|1`) flips to false. The test invariants below
// were rewritten accordingly.

// TestDetectHumanizeOff_ColonMissing covers the `colon < 0` branch:
// no colon → key extraction fails → falls through to default-off (true).
func TestDetectHumanizeOff_ColonMissing(t *testing.T) {
	cases := []string{
		"{{/* humanize */}}",     // no colon at all
		"{{/* humanizeoff */}}",  // no colon, no space
		"{{/* humanize off */}}", // space but no colon
	}
	for _, c := range cases {
		if !detectHumanizeOff(c) {
			t.Errorf("no-colon input should fall through to default-off (true): %q", c)
		}
	}
}

// TestDetectHumanizeOff_KeyNotHumanize covers the `key != "humanize"` branch:
// comment with a different key → no match → default-off (true).
func TestDetectHumanizeOff_KeyNotHumanize(t *testing.T) {
	cases := []string{
		"{{/* humanize_ext: off */}}",
		"{{/* humanizeX: off */}}",
		"{{/* xhumanize: off */}}",
		"{{/* humanize-flag: off */}}",
	}
	for _, c := range cases {
		if !detectHumanizeOff(c) {
			t.Errorf("key != 'humanize' should fall through to default-off (true): %q", c)
		}
	}
}

// TestDetectHumanizeOff_OnValues verifies that on-like values flip the
// default to false (= activate humanize). Unrecognised values stay default-off.
func TestDetectHumanizeOff_OnValues(t *testing.T) {
	optInCases := []string{
		"{{/* humanize: on */}}",
		"{{/* humanize: yes */}}",
		"{{/* humanize: true */}}",
		"{{/* humanize: 1 */}}",
	}
	for _, c := range optInCases {
		if detectHumanizeOff(c) {
			t.Errorf("opt-in value should return false (humanize active): %q", c)
		}
	}
	// Non-canonical value (not in the recognised opt-in set) stays default-off.
	if !detectHumanizeOff("{{/* humanize: enabled */}}") {
		t.Error("unrecognised value 'enabled' should fall through to default-off")
	}
}

// TestDetectHumanizeOff_MultilineFirstOffWins — under default-off, the
// presence of ANY recognised opt-in marker activates humanize even if a
// `humanize: off` line appears earlier. Off is now the default state, so
// the first explicit `on` switches it.
func TestDetectHumanizeOff_MultilineFirstOffWins(t *testing.T) {
	content := "{{/* humanize: off */}}\n{{/* humanize: on */}}\nbody"
	if detectHumanizeOff(content) {
		t.Error("opt-in `humanize: on` on a later line must activate humanize even after `off`")
	}
}

// TestDetectHumanizeOff_Property_NeverPanics covers monkey strings.
func TestDetectHumanizeOff_Property_NeverPanics(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", s, r)
			}
		}()
		_ = detectHumanizeOff(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ─── substituteVars ────────────────────────────────────────────────────────

// TestSubstituteVars_ExtraMapIgnored verifies Extra map is carried through
// without panics (Extra is not substituted today — it must not cause panics).
func TestSubstituteVars_ExtraMapIgnored(t *testing.T) {
	vars := TemplateVars{
		Firma: "Corp",
		Extra: map[string]string{"custom": "val"},
	}
	out := substituteVars("{{firma}}", vars)
	if out != "Corp" {
		t.Errorf("Extra map should not break basic substitution, got %q", out)
	}
}

// TestSubstituteVars_NilExtraMap verifies nil Extra does not panic.
func TestSubstituteVars_NilExtraMap(t *testing.T) {
	vars := TemplateVars{Firma: "Corp", Extra: nil}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("nil Extra caused panic: %v", r)
		}
	}()
	out := substituteVars("{{firma}}", vars)
	if out != "Corp" {
		t.Errorf("nil Extra: got %q", out)
	}
}

// TestSubstituteVars_Property_NoPanic covers monkey text+vars.
func TestSubstituteVars_Property_NoPanic(t *testing.T) {
	f := func(text, firma, jmeno, region string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic for text=%q firma=%q: %v", text, firma, r)
			}
		}()
		vars := TemplateVars{Firma: firma, Jmeno: jmeno, Region: region}
		_ = substituteVars(text, vars)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestSubstituteVars_UnsubURL_BothNotations confirms both {{unsuburl}} and
// {{.UnsubURL}} are substituted in the same text body.
func TestSubstituteVars_UnsubURL_BothNotations(t *testing.T) {
	vars := TemplateVars{UnsubURL: "https://example.com/unsub?tok=abc"}
	out := substituteVars("Odhlásit se: {{unsuburl}} nebo {{.UnsubURL}}", vars)
	if strings.Count(out, "https://example.com/unsub?tok=abc") != 2 {
		t.Errorf("both {{unsuburl}} and {{.UnsubURL}} should be substituted: %q", out)
	}
}

// ─── deterministicSeed ────────────────────────────────────────────────────

// TestDeterministicSeed_NonNegative verifies seed is always ≥ 0.
func TestDeterministicSeed_NonNegative(t *testing.T) {
	f := func(contactID int64, step int) bool {
		return deterministicSeed(contactID, step) >= 0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestDeterministicSeed_Property_Deterministic verifies idempotency.
func TestDeterministicSeed_Property_Deterministic(t *testing.T) {
	f := func(contactID int64, step int) bool {
		return deterministicSeed(contactID, step) == deterministicSeed(contactID, step)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ─── plainToHTML ──────────────────────────────────────────────────────────

// TestPlainToHTML_Property_NoPanic monkey test.
//
// Inner structure varies (post-2026-05-08): may contain <p>, <hr>,
// <small><em>, or be empty body — all valid for the various inputs.
// Property: never panic, always wrapped in <html><body>…</body></html>.
func TestPlainToHTML_Property_NoPanic(t *testing.T) {
	f := func(text string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", text, r)
			}
		}()
		out := plainToHTML(text)
		return strings.HasPrefix(out, "<html><body>") && strings.HasSuffix(out, "</body></html>")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestPlainToHTML_NoRawAmpersand verifies & is always escaped.
func TestPlainToHTML_NoRawAmpersand(t *testing.T) {
	out := plainToHTML("a & b && c")
	if strings.Contains(out, " & ") {
		t.Errorf("raw & should be escaped: %q", out)
	}
}

// ─── Render property tests ────────────────────────────────────────────────

// TestRender_Property_NoPanicOnEmptyVars verifies Render never panics with
// zero-value TemplateVars across many contact IDs.
func TestRender_Property_NoPanicOnEmptyVars(t *testing.T) {
	dir := t.TempDir()
	content := "{{/* subject: Test */}}\nHello {{jmeno}} from {{firma}}"
	os.WriteFile(filepath.Join(dir, "prop.tmpl"), []byte(content), 0644)
	engine := NewEngine(dir, nil)

	for contactID := int64(0); contactID < 50; contactID++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic contactID=%d: %v", contactID, r)
				}
			}()
			_, err := engine.Render("prop", TemplateVars{}, contactID, 0)
			if err != nil {
				t.Errorf("Render error contactID=%d: %v", contactID, err)
			}
		}()
	}
}

// TestRender_Property_OutputNeverEmpty verifies rendered body is never empty
// when template has content.
func TestRender_Property_OutputNeverEmpty(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "nonempty.tmpl"), []byte("{{/* subject: S */}}\nstatic body text"), 0644)
	engine := NewEngine(dir, nil)

	for seed := int64(0); seed < 20; seed++ {
		r, err := engine.Render("nonempty", TemplateVars{}, seed, 0)
		if err != nil {
			t.Fatalf("Render error seed=%d: %v", seed, err)
		}
		if r.BodyPlain == "" {
			t.Errorf("seed=%d: BodyPlain should not be empty", seed)
		}
		if r.BodyHTML == "" {
			t.Errorf("seed=%d: BodyHTML should not be empty", seed)
		}
	}
}

// TestRender_SpinInTemplate verifies spin syntax in template body resolves.
func TestRender_SpinInTemplate(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "spin.tmpl"), []byte("{{/* subject: S */}}\n{Dobrý den|Zdravím} {{jmeno}}"), 0644)
	engine := NewEngine(dir, nil)

	seen := make(map[string]bool)
	for contactID := int64(1); contactID <= 50; contactID++ {
		r, err := engine.Render("spin", TemplateVars{Jmeno: "Jan"}, contactID, 0)
		if err != nil {
			t.Fatalf("Render error: %v", err)
		}
		if strings.Contains(r.BodyPlain, "{") || strings.Contains(r.BodyPlain, "}") {
			t.Errorf("spin not resolved in body: %q", r.BodyPlain)
		}
		seen[r.BodyPlain] = true
	}
	// Over 50 contacts, both variants should appear.
	if len(seen) < 2 {
		t.Errorf("spin should produce variation, only got: %v", seen)
	}
}
