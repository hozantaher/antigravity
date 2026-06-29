package bounce

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: ClassifyBounce never panics ─────────────────────
func TestProperty_ClassifyBounce_NoPanic(t *testing.T) {
	f := func(code, message string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on code=%q msg=%q: %v", code, message, r)
			}
		}()
		_ = ClassifyBounce(code, message)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ClassifyBounce deterministic ────────────────────
func TestProperty_ClassifyBounce_Deterministic(t *testing.T) {
	f := func(code, msg string) bool {
		return ClassifyBounce(code, msg) == ClassifyBounce(code, msg)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Complaint keywords always → BounceComplaint ─────
// Complaint takes precedence over code — a 550 with "spam" in msg
// is still classified as complaint (higher-priority signal for
// reputation management).
func TestProperty_ClassifyBounce_ComplaintPriority(t *testing.T) {
	kws := []string{"complaint", "spam", "abuse", "junk"}
	// Case-insensitive: impl lowercases msg first.
	for _, kw := range kws {
		for _, prefix := range []string{"", "550 ", "550 "} {
			msg := prefix + "user " + kw + " report"
			if got := ClassifyBounce("550", msg); got != BounceComplaint {
				t.Fatalf("kw=%q msg=%q: want Complaint, got %v", kw, msg, got)
			}
		}
		// Uppercase also complaint (lowercased in impl).
		upper := strings.ToUpper(kw)
		if got := ClassifyBounce("250", "report of "+upper); got != BounceComplaint {
			t.Fatalf("uppercase kw=%q: want Complaint", upper)
		}
	}
}

// ── Property: 5xx codes in hard list → BounceHard ─────────────
func TestProperty_ClassifyBounce_HardCodes(t *testing.T) {
	hardCodes := []string{"550", "551", "552", "553", "554"}
	// Use a message that's neither complaint nor soft keyword.
	for _, code := range hardCodes {
		if got := ClassifyBounce(code, "mailbox issue"); got != BounceHard {
			t.Fatalf("code=%q: want Hard, got %v", code, got)
		}
	}
	// Also works for extensions of these codes.
	if got := ClassifyBounce("550 5.1.1", "user"); got != BounceHard {
		t.Fatalf("5xx extended code: want Hard, got %v", got)
	}
}

// ── Property: hard-bounce keywords → BounceHard ───────────────
func TestProperty_ClassifyBounce_HardKeywords(t *testing.T) {
	kws := []string{
		"user unknown", "mailbox not found", "no such user",
		"does not exist", "invalid recipient", "rejected",
		"address rejected", "undeliverable", "permanent",
	}
	for _, kw := range kws {
		msg := "Error: " + kw
		if got := ClassifyBounce("450", msg); got != BounceHard {
			t.Fatalf("kw=%q: want Hard, got %v", kw, got)
		}
	}
}

// ── Property: complaint keywords ALWAYS trump 5xx hard codes ─
// Priority-order invariant: 550 + "complaint" should still classify
// as complaint (not hard) — see ClassifyBounce ordering.
func TestProperty_ClassifyBounce_ComplaintBeatsHard(t *testing.T) {
	if got := ClassifyBounce("550", "rejected as spam complaint"); got != BounceComplaint {
		t.Fatalf("complaint+5xx: want Complaint, got %v", got)
	}
}

// ── Property: unknown codes + neutral msg → BounceSoft ────────
func TestProperty_ClassifyBounce_DefaultSoft(t *testing.T) {
	cases := []struct{ code, msg string }{
		{"421", "try again later"},
		{"450", "temporarily deferred"},
		{"452", "insufficient storage"},
		{"250", "ok"}, // technically success but still classified via fn
		{"", ""},
	}
	for _, c := range cases {
		got := ClassifyBounce(c.code, c.msg)
		if got != BounceSoft {
			t.Fatalf("neutral code=%q msg=%q: want Soft, got %v", c.code, c.msg, got)
		}
	}
}

// ── Property: empty inputs → Soft (documents current behavior) ──
func TestProperty_ClassifyBounce_EmptyInputs(t *testing.T) {
	if got := ClassifyBounce("", ""); got != BounceSoft {
		t.Fatalf("empty inputs: want Soft, got %v", got)
	}
}

// ── Property: enum values ─────────────────────────────────────
func TestProperty_ClassifyBounce_EnumRange(t *testing.T) {
	valid := map[BounceType]bool{
		BounceHard:      true,
		BounceSoft:      true,
		BounceComplaint: true,
	}
	f := func(code, msg string) bool {
		return valid[ClassifyBounce(code, msg)]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: very long message + code don't panic ────────────
func TestProperty_ClassifyBounce_LongInputs(t *testing.T) {
	long := strings.Repeat("a", 100000)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on long input: %v", r)
		}
	}()
	_ = ClassifyBounce("550", long)
	_ = ClassifyBounce(long, "abuse report")
}

// ── Property: Unicode in message handled ──────────────────────
func TestProperty_ClassifyBounce_Unicode(t *testing.T) {
	cases := []string{
		"Schránka neexistuje (user unknown)",
		"邮箱不存在",
		"Spam report 🚀",
		"ěščř complaint ěščř",
	}
	for _, msg := range cases {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on unicode %q: %v", msg, r)
			}
		}()
		_ = ClassifyBounce("550", msg)
	}
}
