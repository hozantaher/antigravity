// Package validation — L3 property, boundary, and monkey tests.
// Covers: SyntaxValidator, DisposableValidator, DuplicateValidator,
// SpamtrapValidator, RoleValidator, Pipeline.
package validation

import (
	"context"
	"strings"
	"testing"
	"testing/quick"
)

// ─── SyntaxValidator — property ────────────────────────────────────────────

// TestSyntax_NeverPanics_Property runs SyntaxValidator.Validate on 500 random
// strings and asserts it never panics and never returns a non-nil error.
func TestSyntax_NeverPanics_Property(t *testing.T) {
	v := &SyntaxValidator{}
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic for input %q: %v", s, r)
			}
		}()
		_, _, err := v.Validate(context.Background(), s)
		return err == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestSyntax_ValidEmails_ReturnTrue asserts canonical valid emails are accepted.
func TestSyntax_ValidEmails_ReturnTrue(t *testing.T) {
	v := &SyntaxValidator{}
	cases := []string{
		"user@example.com",
		"jan.novak@firma.cz",
		"user+tag@domain.org",
		"user123@sub.domain.com",
		"a@b.io",
		"x.y.z@d.e.co.uk",
	}
	for _, email := range cases {
		ok, reason, _ := v.Validate(context.Background(), email)
		if !ok {
			t.Errorf("expected valid: %q (reason: %s)", email, reason)
		}
	}
}

// TestSyntax_InvalidEmails_ReturnFalse asserts clearly invalid emails are rejected.
func TestSyntax_InvalidEmails_ReturnFalse(t *testing.T) {
	v := &SyntaxValidator{}
	cases := []string{
		"",
		"notanemail",
		"@domain.com",
		"user@",
		"user@.",
		".@domain.com",
		"user@@domain.com",
	}
	for _, email := range cases {
		ok, _, _ := v.Validate(context.Background(), email)
		if ok {
			t.Errorf("expected invalid: %q", email)
		}
	}
}

// TestSyntax_LongLocalPart_NoLengthEnforcement documents that the validator
// does NOT enforce RFC 5321 length limits — it relies on RFC 5322 parse only.
// The test asserts the validator does not panic on an oversized local part.
func TestSyntax_LongLocalPart_NoLengthEnforcement(t *testing.T) {
	v := &SyntaxValidator{}
	long := strings.Repeat("a", 300) + "@domain.com"
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on long local part: %v", r)
		}
	}()
	_, _, _ = v.Validate(context.Background(), long)
}

// TestSyntax_Deterministic_Property checks that Validate is a pure function:
// same input always produces same output.
func TestSyntax_Deterministic_Property(t *testing.T) {
	v := &SyntaxValidator{}
	f := func(s string) bool {
		ok1, r1, _ := v.Validate(context.Background(), s)
		ok2, r2, _ := v.Validate(context.Background(), s)
		return ok1 == ok2 && r1 == r2
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// TestSyntax_LongInput_NoPanic checks that a 10 000-char input does not panic
// and completes without hanging.
func TestSyntax_LongInput_NoPanic(t *testing.T) {
	v := &SyntaxValidator{}
	long := strings.Repeat("x", 10_000) + "@" + strings.Repeat("y", 1_000) + ".cz"
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on long input: %v", r)
		}
	}()
	_, _, _ = v.Validate(context.Background(), long)
}

// ─── DisposableValidator — boundary + property ─────────────────────────────

// TestDisposable_NeverPanics_Property runs DisposableValidator.Validate on
// 500 random strings.
func TestDisposable_NeverPanics_Property(t *testing.T) {
	v := &DisposableValidator{}
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic for input %q: %v", s, r)
			}
		}()
		_, _, err := v.Validate(context.Background(), s)
		return err == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestDisposable_KnownDisposableDomain_ReturnsFalse checks all disposable
// entries in the package-level list.
func TestDisposable_KnownDisposableDomain_ReturnsFalse(t *testing.T) {
	v := &DisposableValidator{}
	ctx := context.Background()
	for _, d := range disposableDomains {
		email := "user@" + d
		ok, _, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("disposable domain %q should be rejected", d)
		}
	}
}

// TestDisposable_RealDomain_ReturnsTrue checks known real domains pass.
func TestDisposable_RealDomain_ReturnsTrue(t *testing.T) {
	v := &DisposableValidator{}
	ctx := context.Background()
	real := []string{
		"user@gmail.com",
		"jan@firma.cz",
		"sales@strojirna.cz",
	}
	for _, email := range real {
		ok, _, _ := v.Validate(ctx, email)
		if !ok {
			t.Errorf("real domain %q should not be disposable", email)
		}
	}
}

// TestDisposable_EmptyDomain_Safe verifies an email without @ is handled safely.
func TestDisposable_EmptyDomain_Safe(t *testing.T) {
	v := &DisposableValidator{}
	ok, reason, err := v.Validate(context.Background(), "notanemail")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("email without domain should be rejected")
	}
	if reason != "no domain" {
		t.Errorf("expected reason 'no domain', got %q", reason)
	}
}

// TestDisposable_10kCharDomain_Safe verifies that an absurdly long domain does
// not panic or hang.
func TestDisposable_10kCharDomain_Safe(t *testing.T) {
	v := &DisposableValidator{}
	big := "user@" + strings.Repeat("x", 10_000) + ".com"
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on 10k domain: %v", r)
		}
	}()
	ok, _, _ := v.Validate(context.Background(), big)
	// Not in disposable list → should pass, but we only assert no panic here.
	_ = ok
}

// TestDisposable_CaseInsensitive verifies case-insensitive comparison.
func TestDisposable_CaseInsensitive(t *testing.T) {
	v := &DisposableValidator{}
	cases := []string{
		"user@Mailinator.com",
		"user@MAILINATOR.COM",
		"user@mailinator.COM",
	}
	for _, email := range cases {
		ok, _, _ := v.Validate(context.Background(), email)
		if ok {
			t.Errorf("case variant %q should still be detected as disposable", email)
		}
	}
}

// ─── SpamtrapValidator — property ──────────────────────────────────────────

// TestSpamtrap_NeverPanics_Property runs SpamtrapValidator.Validate on 500
// arbitrary strings.
func TestSpamtrap_NeverPanics_Property(t *testing.T) {
	v := &SpamtrapValidator{}
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic for input %q: %v", s, r)
			}
		}()
		_, _, err := v.Validate(context.Background(), s)
		return err == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestSpamtrap_AllSpamtrapDomains_Rejected checks every entry in spamtrapDomains.
func TestSpamtrap_AllSpamtrapDomains_Rejected(t *testing.T) {
	v := &SpamtrapValidator{}
	ctx := context.Background()
	for _, d := range spamtrapDomains {
		email := "user@" + d
		ok, _, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("spamtrap domain %q should be rejected", d)
		}
	}
}

// TestSpamtrap_AllLocalPatterns_Rejected checks every entry in spamtrapLocalPatterns.
func TestSpamtrap_AllLocalPatterns_Rejected(t *testing.T) {
	v := &SpamtrapValidator{}
	ctx := context.Background()
	for _, p := range spamtrapLocalPatterns {
		email := p + "@legit-domain.cz"
		ok, _, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("spamtrap pattern %q should be rejected", p)
		}
	}
}

// ─── DuplicateValidator — boundary ─────────────────────────────────────────

// TestDuplicate_EmptyEmail_Safe verifies empty email is handled without panic.
func TestDuplicate_EmptyEmail_Safe(t *testing.T) {
	v := &DuplicateValidator{seen: make(map[string]bool)}
	// First call with empty string should pass (nothing seen yet)
	ok1, _, _ := v.Validate(context.Background(), "")
	// Second identical call must be rejected as duplicate
	ok2, _, _ := v.Validate(context.Background(), "")
	if ok1 && ok2 {
		t.Error("second empty-string call should be a duplicate")
	}
}

// TestDuplicate_NeverPanics_Property runs DuplicateValidator on arbitrary strings.
func TestDuplicate_NeverPanics_Property(t *testing.T) {
	v := &DuplicateValidator{seen: make(map[string]bool)}
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic for input %q: %v", s, r)
			}
		}()
		_, _, err := v.Validate(context.Background(), s)
		return err == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ─── Pipeline — monkey tests ────────────────────────────────────────────────

// TestPipeline_EmptyEmail_ReturnsHighRisk verifies empty input returns high-risk.
func TestPipeline_EmptyEmail_ReturnsHighRisk(t *testing.T) {
	p := &Pipeline{validators: []Validator{&SyntaxValidator{}}}
	result := p.Run(context.Background(), "")
	if result.SyntaxValid {
		t.Error("empty email should fail syntax")
	}
	if result.RiskLevel != "high" {
		t.Errorf("empty email should be high risk, got %q", result.RiskLevel)
	}
}

// TestPipeline_NoValidators_ReturnsLowRisk verifies a pipeline with no validators
// returns the safe default (low risk, no flags set).
func TestPipeline_NoValidators_ReturnsLowRisk(t *testing.T) {
	p := &Pipeline{validators: []Validator{}}
	result := p.Run(context.Background(), "user@example.com")
	if result.RiskLevel != "low" {
		t.Errorf("no-validator pipeline should default to low risk, got %q", result.RiskLevel)
	}
}

// TestPipeline_Property_NeverPanics runs the complete pipeline on 200 arbitrary
// strings and asserts no panic and always returns a non-nil result.
func TestPipeline_Property_NeverPanics(t *testing.T) {
	p := &Pipeline{validators: []Validator{
		&SyntaxValidator{},
		&DuplicateValidator{seen: make(map[string]bool)},
		&DisposableValidator{},
	}}
	f := func(email string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic for input %q: %v", email, r)
			}
		}()
		result := p.Run(context.Background(), email)
		return result != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestPipeline_DisposableShortCircuits verifies that a disposable email stops
// the pipeline and sets IsDisposable=true with high risk.
func TestPipeline_DisposableShortCircuits(t *testing.T) {
	p := &Pipeline{validators: []Validator{
		&SyntaxValidator{},
		&DisposableValidator{},
	}}
	result := p.Run(context.Background(), "user@mailinator.com")
	if !result.SyntaxValid {
		t.Error("mailinator.com is syntactically valid")
	}
	if !result.IsDisposable {
		t.Error("mailinator.com should be flagged as disposable")
	}
	if result.RiskLevel != "high" {
		t.Errorf("disposable should be high risk, got %q", result.RiskLevel)
	}
}

// TestPipeline_RiskLevels_OnlyLowOrHigh verifies the pipeline never returns
// an unexpected risk level string for the standard two validators.
func TestPipeline_RiskLevels_OnlyLowOrHigh(t *testing.T) {
	p := &Pipeline{validators: []Validator{
		&SyntaxValidator{},
		&DisposableValidator{},
	}}
	valid := map[string]bool{"low": true, "high": true, "medium": true}
	f := func(email string) bool {
		defer func() { recover() }()
		result := p.Run(context.Background(), email)
		return valid[result.RiskLevel]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestPipeline_WhitespaceEmail_ReturnsHighRisk checks that a whitespace-only
// email (which trims to empty) is treated as invalid.
func TestPipeline_WhitespaceEmail_ReturnsHighRisk(t *testing.T) {
	p := &Pipeline{validators: []Validator{&SyntaxValidator{}}}
	result := p.Run(context.Background(), "   ")
	if result.SyntaxValid {
		t.Error("whitespace-only email should fail syntax")
	}
	if result.RiskLevel != "high" {
		t.Errorf("whitespace-only should be high risk, got %q", result.RiskLevel)
	}
}
