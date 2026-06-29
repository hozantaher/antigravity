// Sprint AR1 + AR3 tests — template variant selection, HTML profiles, footer
// formulations, and greeting/sign-off rotation.
//
// Coverage targets (memory feedback_extreme_testing ≥10 test cases):
//   AR1: pickVariant determinism, distribution, empty, single-variant
//   AR1: greeting rotation, sign-off rotation
//   AR3: 5 HTML profiles render distinct HTML
//   AR3: footer 3 variants distinct
//   AR3: footer NEVER contains href (ratchet for feedback_no_unsub_url_in_body)
//   AR3: HTML profile selection deterministic per envelopeKey
package content

import (
	"fmt"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// AR1 — pickVariant
// ─────────────────────────────────────────────────────────────────────────────

// Test 1: pickVariant returns mainContent when variants is empty.
func TestPickVariant_EmptyVariants(t *testing.T) {
	result := pickVariant("env1", "k1", nil, "main")
	if result != "main" {
		t.Errorf("expected 'main' for empty variants, got %q", result)
	}
	result2 := pickVariant("env1", "k1", []string{}, "main")
	if result2 != "main" {
		t.Errorf("expected 'main' for empty slice, got %q", result2)
	}
}

// Test 2: pickVariant is deterministic — same inputs always produce same output.
func TestPickVariant_Deterministic(t *testing.T) {
	variants := []string{"alt1", "alt2", "alt3"}
	for _, env := range []string{"env1", "env2", "123:0", "9999:5"} {
		r1 := pickVariant(env, "tmpl:subject", variants, "main")
		r2 := pickVariant(env, "tmpl:subject", variants, "main")
		if r1 != r2 {
			t.Errorf("non-deterministic: env=%q got %q then %q", env, r1, r2)
		}
	}
}

// Test 3: pickVariant uniform distribution across 10,000 samples.
// Each of (N variants + main) should appear in roughly 1/(N+1) of cases.
func TestPickVariant_UniformDistribution(t *testing.T) {
	variants := []string{"alt1", "alt2"}
	counts := make(map[string]int)
	total := 10000
	for i := 0; i < total; i++ {
		key := fmt.Sprintf("contact%d:0", i)
		r := pickVariant(key, "tmpl:body", variants, "main")
		counts[r]++
	}
	// 3 choices → expect ~3333 each; allow ±15% tolerance
	for _, v := range append(variants, "main") {
		got := counts[v]
		expected := total / 3
		tol := expected * 15 / 100
		if got < expected-tol || got > expected+tol {
			t.Errorf("variant %q count %d far from expected ~%d (±%d)", v, got, expected, tol)
		}
	}
}

// Test 4: pickVariant with 1 variant — both main and variant selected (50/50).
func TestPickVariant_SingleVariant(t *testing.T) {
	variants := []string{"only-alt"}
	gotMain, gotAlt := 0, 0
	for i := 0; i < 10000; i++ {
		key := fmt.Sprintf("contact%d:1", i)
		r := pickVariant(key, "t:s", variants, "main")
		switch r {
		case "main":
			gotMain++
		case "only-alt":
			gotAlt++
		default:
			t.Fatalf("unexpected value %q", r)
		}
	}
	// expect ~50/50; allow ±15%
	for name, count := range map[string]int{"main": gotMain, "only-alt": gotAlt} {
		expected := 5000
		tol := 750
		if count < expected-tol || count > expected+tol {
			t.Errorf("single-variant case: %q count %d, expected ~%d (±%d)", name, count, expected, tol)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AR1 — greeting rotation
// ─────────────────────────────────────────────────────────────────────────────

// Test 5: PickGreetingVariant returns a non-empty string from known set.
func TestPickGreetingVariant_KnownSet(t *testing.T) {
	allowed := map[string]bool{
		"Vážený":             true,
		"Dobrý den vážený":   true,
		"Dobrý den":          true,
	}
	for _, env := range []string{"1:0", "2:1", "999:3", "12345:0"} {
		g := PickGreetingVariant(env)
		if !allowed[g] {
			t.Errorf("unexpected greeting %q for env %q", g, env)
		}
	}
}

// Test 6: PickGreetingVariant rotates — all 3 forms appear across 1000 samples.
func TestPickGreetingVariant_AllFormsAppear(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		seen[PickGreetingVariant(fmt.Sprintf("c%d:0", i))] = true
	}
	for _, expected := range greetingVariants {
		if !seen[expected] {
			t.Errorf("greeting variant %q never appeared in 1000 samples", expected)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AR1 — sign-off rotation
// ─────────────────────────────────────────────────────────────────────────────

// Test 7: PickSignOffVariant returns one of the 3 templates.
func TestPickSignOffVariant_KnownTemplates(t *testing.T) {
	allowed := map[string]bool{
		"%s":                      true,
		"%s\nBalkan Motors":       true,
		"%s\nObchodní zástupce":   true,
	}
	for _, env := range []string{"1:0", "2:1", "77:2", "500:0"} {
		s := PickSignOffVariant(env)
		if !allowed[s] {
			t.Errorf("unexpected sign-off template %q for env %q", s, env)
		}
	}
}

// Test 8: PickSignOffVariant rotates — all 3 forms appear.
func TestPickSignOffVariant_AllFormsAppear(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		seen[PickSignOffVariant(fmt.Sprintf("c%d:0", i))] = true
	}
	for _, expected := range signOffTemplates {
		if !seen[expected] {
			t.Errorf("sign-off variant %q never appeared in 1000 samples", expected)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AR3 — HTML profiles
// ─────────────────────────────────────────────────────────────────────────────

// Test 9: 5 HTML profiles render distinct HTML strings for the same body text.
func TestHTMLProfiles_DistinctOutput(t *testing.T) {
	body := "Dobrý den,\n\ntoto je testovací zpráva.\n\nS pozdravem,\nGoran"
	results := make(map[string]bool)
	for i := HTMLProfile(0); i < htmlProfileCount; i++ {
		html := plainToHTMLWithProfile(body, i)
		if results[html] {
			t.Errorf("profile %d produced duplicate HTML", i)
		}
		results[html] = true
	}
}

// Test 10: pickHTMLProfile is deterministic for same envelopeKey+template.
func TestPickHTMLProfile_Deterministic(t *testing.T) {
	for _, env := range []string{"1:0", "42:3", "999:1"} {
		p1 := pickHTMLProfile(env, "initial")
		p2 := pickHTMLProfile(env, "initial")
		if p1 != p2 {
			t.Errorf("pickHTMLProfile not deterministic for env=%q: %v vs %v", env, p1, p2)
		}
	}
}

// Test 11: pickHTMLProfile distributes across all 5 profiles.
func TestPickHTMLProfile_AllProfilesUsed(t *testing.T) {
	seen := make(map[HTMLProfile]bool)
	for i := 0; i < 10000; i++ {
		p := pickHTMLProfile(fmt.Sprintf("c%d:0", i), "initial")
		seen[p] = true
	}
	for i := HTMLProfile(0); i < htmlProfileCount; i++ {
		if !seen[i] {
			t.Errorf("HTML profile %d never selected in 10000 samples", i)
		}
	}
}

// Test 12: Footer 3 variants are distinct from each other.
func TestFooterVariants_Distinct(t *testing.T) {
	seen := make(map[string]bool)
	for _, v := range footerVariants {
		if seen[v] {
			t.Errorf("duplicate footer variant: %q", v)
		}
		seen[v] = true
	}
}

// Test 13: PickFooterVariant rotates — all 3 forms appear.
func TestPickFooterVariant_AllFormsAppear(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		seen[PickFooterVariant(fmt.Sprintf("c%d:0", i))] = true
	}
	for _, expected := range footerVariants {
		if !seen[expected] {
			t.Errorf("footer variant %q never appeared in 1000 samples", expected)
		}
	}
}

// Test 14: HARD RATCHET — no footer variant contains an href or URL.
// Enforces memory feedback_no_unsub_url_in_body: footer NEVER links.
func TestFooterVariants_NoHref(t *testing.T) {
	for i, v := range footerVariants {
		lower := strings.ToLower(v)
		if strings.Contains(lower, "href") {
			t.Errorf("footer variant[%d] contains 'href': %q", i, v)
		}
		if strings.Contains(lower, "http://") || strings.Contains(lower, "https://") {
			t.Errorf("footer variant[%d] contains URL: %q", i, v)
		}
		if strings.Contains(lower, "<a ") || strings.Contains(lower, "<a>") {
			t.Errorf("footer variant[%d] contains <a> anchor: %q", i, v)
		}
	}
}

// Test 15: plainToHTMLWithProfile footer ratchet — HTML output never contains
// href in the footer portion when rendered with any profile.
func TestPlainToHTMLWithProfile_FooterNoHref(t *testing.T) {
	body := "Dobrý den,\n\nPoptávka.\n\n---\nPokud nemáte zájem, stačí odepsat."
	for i := HTMLProfile(0); i < htmlProfileCount; i++ {
		html := plainToHTMLWithProfile(body, i)
		lower := strings.ToLower(html)
		// The footer portion is everything after the <p style="...color:#aaa"> tag.
		if idx := strings.Index(lower, `color:#aaa`); idx >= 0 {
			footerHTML := lower[idx:]
			if strings.Contains(footerHTML, "href") {
				t.Errorf("profile %d: footer HTML contains 'href': %q", i, footerHTML)
			}
		}
	}
}

// Test 16: pickVariant with 4 variants — distribution covers all 5 choices.
func TestPickVariant_FourVariants_AllChoicesAppear(t *testing.T) {
	variants := []string{"v1", "v2", "v3", "v4"}
	seen := make(map[string]bool)
	for i := 0; i < 10000; i++ {
		key := fmt.Sprintf("c%d:0", i)
		seen[pickVariant(key, "t", variants, "main")] = true
	}
	for _, expected := range append(variants, "main") {
		if !seen[expected] {
			t.Errorf("choice %q never appeared in 10000 samples", expected)
		}
	}
}
