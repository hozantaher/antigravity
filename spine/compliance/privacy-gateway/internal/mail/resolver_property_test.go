package mail_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"testing/quick"

	"privacy-gateway/internal/mail"
)

func testSettings() mail.SMTPSettings {
	return mail.SMTPSettings{Host: "smtp.test.cz", Port: 587, Username: "user@test.cz", Password: "secret"}
}

// ── StaticSMTPResolver — property tests ──────────────────────────────────

func TestStaticSMTPResolver_CaseInsensitiveLookup(t *testing.T) {
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{
		"user@example.cz": testSettings(),
	})
	ctx := context.Background()
	variants := []string{
		"user@example.cz",
		"USER@EXAMPLE.CZ",
		"User@Example.Cz",
		"USER@example.cz",
	}
	for _, v := range variants {
		_, err := resolver.Resolve(ctx, v)
		if err != nil {
			t.Errorf("Resolve(%q) should succeed (case-insensitive), got: %v", v, err)
		}
	}
}

func TestStaticSMTPResolver_WhitespaceTolerant(t *testing.T) {
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{
		"user@example.cz": testSettings(),
	})
	ctx := context.Background()
	padded := []string{
		"  user@example.cz",
		"user@example.cz  ",
		"  user@example.cz  ",
	}
	for _, v := range padded {
		_, err := resolver.Resolve(ctx, v)
		if err != nil {
			t.Errorf("Resolve(%q) should succeed (whitespace-tolerant), got: %v", v, err)
		}
	}
}

func TestStaticSMTPResolver_MissingKeyReturnsErrMailboxNotFound(t *testing.T) {
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{})
	f := func(sender string) bool {
		_, err := resolver.Resolve(context.Background(), sender)
		return errors.Is(err, mail.ErrMailboxNotFound)
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("empty resolver should always return ErrMailboxNotFound: %v", err)
	}
}

func TestStaticSMTPResolver_NeverPanics(t *testing.T) {
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{
		"known@test.cz": testSettings(),
	})
	f := func(sender string) bool {
		defer func() { recover() }()
		resolver.Resolve(context.Background(), sender) //nolint:errcheck
		return true
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("Resolve panicked: %v", err)
	}
}

func TestStaticSMTPResolver_EmptyKeySkipped(t *testing.T) {
	// Empty-string sender in constructor map is silently skipped
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{
		"": testSettings(),
	})
	_, err := resolver.Resolve(context.Background(), "")
	if !errors.Is(err, mail.ErrMailboxNotFound) {
		t.Errorf("empty sender should not be resolvable, got: %v", err)
	}
}

func TestStaticSMTPResolver_Deterministic(t *testing.T) {
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{
		"user@test.cz": testSettings(),
	})
	ctx := context.Background()
	s1, e1 := resolver.Resolve(ctx, "user@test.cz")
	s2, e2 := resolver.Resolve(ctx, "user@test.cz")
	if e1 != e2 || s1.Host != s2.Host || s1.Port != s2.Port {
		t.Errorf("Resolve not deterministic: (%v,%v) != (%v,%v)", s1, e1, s2, e2)
	}
}

func TestNewStaticSMTPResolver_KeysNormalized(t *testing.T) {
	// Constructor normalises keys: mixed-case key should be reachable via lowercase
	resolver := mail.NewStaticSMTPResolver(map[string]mail.SMTPSettings{
		"User@DOMAIN.CZ": testSettings(),
	})
	lower := strings.ToLower("User@DOMAIN.CZ")
	_, err := resolver.Resolve(context.Background(), lower)
	if err != nil {
		t.Errorf("constructor should normalise keys: Resolve(%q) got %v", lower, err)
	}
}
