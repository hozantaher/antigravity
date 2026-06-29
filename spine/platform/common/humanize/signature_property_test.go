package humanize

import (
	"strings"
	"testing"
	"testing/quick"
	"time"
)

// ── Property: Select never panics for any send time ───────────
func TestProperty_Signature_Select_NoPanic(t *testing.T) {
	eng := NewSignatureEngine("Jan Novák", "CEO", "+420123456789", "jan@x.cz", "https://x.cz")
	f := func(unix int64) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on unix=%d: %v", unix, r)
			}
		}()
		// Clamp to reasonable range
		if unix < -2208988800 || unix > 4102444800 {
			return true
		}
		_ = eng.Select(time.Unix(unix, 0))
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Select returns valid enum value ─────────────────
func TestProperty_Signature_Select_ValidEnum(t *testing.T) {
	eng := NewSignatureEngine("Jan", "CEO", "", "", "")
	valid := map[SignatureType]bool{
		SignatureDesktop: true,
		SignatureMobile:  true,
		SignatureShort:   true,
	}
	for h := 0; h < 24; h++ {
		t := time.Date(2025, 3, 10, h, 0, 0, 0, time.UTC)
		got := eng.Select(t)
		if !valid[got] {
			// can't call t.Fatalf because t is shadowed — use outer t by renaming
			panic("invalid enum")
		}
	}
}

// ── Property: Evening hours (19-22) always → Mobile ────────────
func TestProperty_Signature_EveningAlwaysMobile(t *testing.T) {
	eng := NewSignatureEngine("Jan", "CEO", "", "", "")
	for h := 19; h <= 22; h++ {
		for i := 0; i < 10; i++ {
			tt := time.Date(2025, 3, 10, h, 0, 0, 0, time.UTC)
			if eng.Select(tt) != SignatureMobile {
				t.Fatalf("hour %d:00 iter=%d should return SignatureMobile", h, i)
			}
		}
	}
}

// ── Property: Render never panics for any sig type ────────────
func TestProperty_Signature_Render_NoPanic(t *testing.T) {
	eng := NewSignatureEngine("Jan Novák", "CEO", "+420 123", "jan@x.cz", "https://x.cz")
	for _, st := range []SignatureType{SignatureDesktop, SignatureMobile, SignatureShort, SignatureType(42)} {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on sig=%v: %v", st, r)
			}
		}()
		_ = eng.Render(st)
	}
}

// ── Property: Render desktop includes all non-empty fields ─────
func TestProperty_Signature_DesktopAllFields(t *testing.T) {
	eng := NewSignatureEngine("Jan Novák", "CEO", "+420123", "jan@x.cz", "https://x.cz")
	got := eng.Render(SignatureDesktop)
	for _, want := range []string{"Jan Novák", "CEO", "+420123", "jan@x.cz", "https://x.cz"} {
		if !strings.Contains(got, want) {
			t.Fatalf("desktop signature missing %q (got %q)", want, got)
		}
	}
}

// ── Property: Render desktop with empty fields skips them ──────
func TestProperty_Signature_DesktopOmitsEmpty(t *testing.T) {
	// Only name + role populated.
	eng := NewSignatureEngine("Jan Novák", "CEO", "", "", "")
	got := eng.Render(SignatureDesktop)
	if !strings.Contains(got, "Jan Novák") || !strings.Contains(got, "CEO") {
		t.Fatalf("expected name + role in: %q", got)
	}
	if strings.Contains(got, "Tel:") || strings.Contains(got, "Email:") {
		t.Fatalf("empty fields should be omitted; got %q", got)
	}
}

// ── Property: Render mobile contains name ─────────────────────
func TestProperty_Signature_MobileContainsName(t *testing.T) {
	eng := NewSignatureEngine("Jan Novák", "CEO", "", "", "")
	// Try many times to exercise all 3 mobile variants.
	seen := map[string]bool{}
	for i := 0; i < 60 && len(seen) < 3; i++ {
		got := eng.Render(SignatureMobile)
		seen[got] = true
		if !strings.Contains(got, "Jan Novák") {
			t.Fatalf("mobile variant missing name: %q", got)
		}
	}
}

// ── Property: Render short returns initials ──────────────────
func TestProperty_Signature_ShortInitials(t *testing.T) {
	cases := []struct {
		name     string
		expected string
	}{
		{"Jan Novák", "JN"},
		{"Anna Marie Dvořáková", "AMD"},
		{"Single", "S"},
		{"", ""},
	}
	for _, c := range cases {
		eng := NewSignatureEngine(c.name, "", "", "", "")
		got := eng.Render(SignatureShort)
		if got != c.expected {
			t.Fatalf("name %q: want %q, got %q", c.name, c.expected, got)
		}
	}
}

// ── Property: Unknown SignatureType falls back to name ────────
func TestProperty_Signature_UnknownDefaultsToName(t *testing.T) {
	eng := NewSignatureEngine("Jan Novák", "CEO", "+420", "", "")
	got := eng.Render(SignatureType(999))
	if got != "Jan Novák" {
		t.Fatalf("default should be name only, got %q", got)
	}
}

// ── Property: splitWords handles whitespace edge cases ────────
func TestProperty_SplitWords_EdgeCases(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"Jan Novák", []string{"Jan", "Novák"}},
		{"Single", []string{"Single"}},
		{"", nil},
		{"   ", nil},
		{"\tJan\tNovák\t", []string{"Jan", "Novák"}},
		{"Jan  Novák", []string{"Jan", "Novák"}}, // double space
	}
	for _, c := range cases {
		got := splitWords(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("splitWords(%q) len: want %d, got %d (%v)", c.in, len(c.want), len(got), got)
		}
		for i, w := range c.want {
			if got[i] != w {
				t.Fatalf("splitWords(%q)[%d]: want %q, got %q", c.in, i, w, got[i])
			}
		}
	}
}

// ── Property: Initials handle Czech diacritics (UTF-8 rune extraction) ──
func TestProperty_Signature_ShortCzechDiacritics(t *testing.T) {
	eng := NewSignatureEngine("Žaneta Černá", "", "", "", "")
	got := eng.Render(SignatureShort)
	if got != "ŽČ" {
		t.Fatalf("Czech diacritics initials: want 'ŽČ', got %q", got)
	}
}
