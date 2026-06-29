package audit

import (
	"strings"
	"testing"
)

func TestMaskEmail_BasicFormat(t *testing.T) {
	masked := MaskEmail("jan.novak@example.com")
	if !strings.Contains(masked, "@example.com") {
		t.Errorf("domain should be preserved: %s", masked)
	}
	if strings.Contains(masked, "jan.novak") {
		t.Errorf("local part should not appear verbatim: %s", masked)
	}
	if !strings.Contains(masked, "[sha:") {
		t.Errorf("should contain fingerprint: %s", masked)
	}
}

func TestMaskEmail_Consistent(t *testing.T) {
	// Same email → same mask (for log correlation)
	a := MaskEmail("test@example.com")
	b := MaskEmail("test@example.com")
	if a != b {
		t.Errorf("same email should produce same mask: %s != %s", a, b)
	}
}

func TestMaskEmail_DifferentEmails_DifferentMasks(t *testing.T) {
	a := MaskEmail("alice@example.com")
	b := MaskEmail("bob@example.com")
	if a == b {
		t.Errorf("different emails should produce different masks")
	}
}

func TestMaskEmail_ShortLocal(t *testing.T) {
	single := MaskEmail("x@y.cz")
	if !strings.Contains(single, "@y.cz") {
		t.Errorf("domain preserved for single-char local: %s", single)
	}
	two := MaskEmail("ab@example.com")
	if !strings.Contains(two, "@example.com") {
		t.Errorf("domain preserved for two-char local: %s", two)
	}
}

func TestMaskEmail_InvalidEmail(t *testing.T) {
	result := MaskEmail("not-an-email")
	if result != "[invalid-email]" {
		t.Errorf("invalid email should return placeholder: %s", result)
	}
}

func TestMaskEmail_PreservesFingerprint4Chars(t *testing.T) {
	masked := MaskEmail("jan@test.cz")
	// fingerprint should be exactly 4 hex chars: [sha:xxxx]
	start := strings.Index(masked, "[sha:")
	if start < 0 {
		t.Fatal("no fingerprint found")
	}
	end := strings.Index(masked[start:], "]")
	if end < 0 {
		t.Fatal("unclosed fingerprint bracket")
	}
	fp := masked[start+5 : start+end]
	if len(fp) != 4 {
		t.Errorf("fingerprint should be 4 hex chars, got %q (%d chars)", fp, len(fp))
	}
}

func TestMaskEmail_EmptyLocal(t *testing.T) {
	// "@domain.com" → local part is empty → len(local) == 0 branch
	result := MaskEmail("@domain.com")
	if !strings.Contains(result, "[sha:") {
		t.Errorf("empty local should contain fingerprint: %s", result)
	}
	if !strings.Contains(result, "@domain.com") {
		t.Errorf("domain should be preserved: %s", result)
	}
}
