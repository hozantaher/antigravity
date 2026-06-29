package validation

import (
	"context"
	"testing"
)

// ── SpamtrapValidator ──

func TestSpamtrapName(t *testing.T) {
	v := &SpamtrapValidator{}
	if v.Name() != "spamtrap" {
		t.Errorf("expected 'spamtrap', got %q", v.Name())
	}
}

func TestSpamtrapDetectsDomains(t *testing.T) {
	v := &SpamtrapValidator{}
	ctx := context.Background()

	trapDomains := []string{
		"user@spamcop.net",
		"user@spamhaus.org",
		"user@example.com",
		"user@lashback.com",
	}
	for _, email := range trapDomains {
		ok, _, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("should detect spamtrap domain: %s", email)
		}
	}
}

func TestSpamtrapDetectsPatterns(t *testing.T) {
	v := &SpamtrapValidator{}
	ctx := context.Background()

	patterns := []string{
		"spamtrap@firma.cz",
		"honeypot@firma.cz",
		"anti-spam@firma.cz",
		"trap-test@firma.cz",
	}
	for _, email := range patterns {
		ok, _, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("should detect spamtrap pattern: %s", email)
		}
	}
}

func TestSpamtrapPassesNormal(t *testing.T) {
	v := &SpamtrapValidator{}
	ctx := context.Background()

	safe := []string{
		"jan.novak@firma.cz",
		"info@podnik.cz",
		"obchod@strojirna.cz",
	}
	for _, email := range safe {
		ok, _, _ := v.Validate(ctx, email)
		if !ok {
			t.Errorf("should pass normal email: %s", email)
		}
	}
}

func TestSpamtrapNoDomain(t *testing.T) {
	v := &SpamtrapValidator{}
	ok, _, _ := v.Validate(context.Background(), "nodomain")
	if ok {
		t.Error("should fail for no domain")
	}
}

// ── RoleValidator ──

func TestRoleName(t *testing.T) {
	v := &RoleValidator{}
	if v.Name() != "role" {
		t.Errorf("expected 'role', got %q", v.Name())
	}
}

func TestRoleDetectsDangerous(t *testing.T) {
	v := &RoleValidator{}
	ctx := context.Background()

	dangerous := []string{
		"abuse@firma.cz",
		"postmaster@firma.cz",
		"noreply@firma.cz",
		"spam@firma.cz",
		"mailer-daemon@firma.cz",
	}
	for _, email := range dangerous {
		ok, detail, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("should detect dangerous role: %s", email)
		}
		if detail == "" {
			t.Errorf("should have detail for: %s", email)
		}
	}
}

func TestRoleDetectsRisky(t *testing.T) {
	v := &RoleValidator{}
	ctx := context.Background()

	risky := []string{
		"admin@firma.cz",
		"support@firma.cz",
		"webmaster@firma.cz",
		"marketing@firma.cz",
	}
	for _, email := range risky {
		ok, _, _ := v.Validate(ctx, email)
		if ok {
			t.Errorf("should detect risky role: %s", email)
		}
	}
}

func TestRolePassesPersonal(t *testing.T) {
	v := &RoleValidator{}
	ctx := context.Background()

	personal := []string{
		"jan.novak@firma.cz",
		"obchod@podnik.cz", // "obchod" is not in role list
		"jnovak@strojirna.cz",
	}
	for _, email := range personal {
		ok, _, _ := v.Validate(ctx, email)
		if !ok {
			t.Errorf("should pass personal email: %s", email)
		}
	}
}

// ── looksRandom ──

func TestLooksRandom(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{"jan.novak", false},
		{"obchod", false},
		{"xq7zk9m3p2w", true},           // random alphanumeric
		{"abc123456789012", true},         // digit-heavy
		{"brrrtttggghhhjjj", true},        // no vowels
		{"", false},
	}
	for _, tt := range tests {
		if got := looksRandom(tt.input); got != tt.expected {
			t.Errorf("looksRandom(%q) = %v, want %v", tt.input, got, tt.expected)
		}
	}
}

// ── localFromEmail ──

func TestLocalFromEmail(t *testing.T) {
	tests := []struct{ in, expected string }{
		{"user@example.com", "user"},
		{"JAN.NOVAK@Firma.CZ", "jan.novak"},
		{"nodomain", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := localFromEmail(tt.in); got != tt.expected {
			t.Errorf("localFromEmail(%q) = %q, want %q", tt.in, got, tt.expected)
		}
	}
}

// ── SpamtrapValidator random local part detection ──

func TestSpamtrapRandomLocalPart(t *testing.T) {
	v := &SpamtrapValidator{}
	// >30 chars, all consonants + digits, low vowel ratio → looksRandom=true → rejected
	ok, reason, _ := v.Validate(context.Background(), "xkz3tv8mdn2fqp7wrs5lhbc1jg9y4xz@firma.cz")
	if ok {
		t.Error("random-looking local part (>30 chars, low vowels) should be rejected")
	}
	if reason != "suspiciously random local part" {
		t.Errorf("expected 'suspiciously random local part', got %q", reason)
	}
}
