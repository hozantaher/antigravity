package mail

import (
	"context"
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: StaticSMTPResolver.Resolve never panics ────────
func TestProperty_StaticSMTPResolver_NoPanic(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{
		"a@example.com": {Host: "smtp.example.com", Port: 465},
	})
	f := func(sender string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", sender, r)
			}
		}()
		_, _ = r.Resolve(context.Background(), sender)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: deterministic ──────────────────────────────────
func TestProperty_StaticSMTPResolver_Deterministic(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{
		"a@example.com": {Host: "smtp.example.com", Port: 465},
	})
	f := func(sender string) bool {
		s1, e1 := r.Resolve(context.Background(), sender)
		s2, e2 := r.Resolve(context.Background(), sender)
		return s1 == s2 && (e1 == nil) == (e2 == nil)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: case-insensitive sender lookup ─────────────────
func TestProperty_StaticSMTPResolver_CaseInsensitive(t *testing.T) {
	want := SMTPSettings{Host: "smtp.example.com", Port: 465, Username: "u", Password: "p"}
	r := NewStaticSMTPResolver(map[string]SMTPSettings{
		"user@example.com": want,
	})
	for _, s := range []string{"user@example.com", "USER@EXAMPLE.COM", "User@Example.Com"} {
		got, err := r.Resolve(context.Background(), s)
		if err != nil {
			t.Fatalf("%q: unexpected err %v", s, err)
		}
		if got != want {
			t.Fatalf("%q: want %+v, got %+v", s, want, got)
		}
	}
}

// ── Property: whitespace-tolerant sender lookup ──────────────
func TestProperty_StaticSMTPResolver_WhitespaceTolerant(t *testing.T) {
	want := SMTPSettings{Host: "smtp.example.com", Port: 465}
	r := NewStaticSMTPResolver(map[string]SMTPSettings{"user@example.com": want})
	for _, s := range []string{" user@example.com", "user@example.com ", "\tuser@example.com\n"} {
		got, err := r.Resolve(context.Background(), s)
		if err != nil {
			t.Fatalf("%q: unexpected err %v", s, err)
		}
		if got != want {
			t.Fatalf("%q: want %+v, got %+v", s, want, got)
		}
	}
}

// ── Property: unknown sender → ErrMailboxNotFound ────────────
func TestProperty_StaticSMTPResolver_UnknownSender(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{"user@example.com": {Host: "h"}})
	f := func(sender string) bool {
		// Skip matches (including whitespace/case variants) of the registered key.
		if strings.ToLower(strings.TrimSpace(sender)) == "user@example.com" {
			return true
		}
		_, err := r.Resolve(context.Background(), sender)
		return err == ErrMailboxNotFound
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: empty/whitespace sender → ErrMailboxNotFound ────
func TestProperty_StaticSMTPResolver_EmptySender(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{"user@example.com": {Host: "h"}})
	for _, s := range []string{"", " ", "\t", "\n", "  \t\n  "} {
		_, err := r.Resolve(context.Background(), s)
		if err != ErrMailboxNotFound {
			t.Fatalf("empty/ws %q: want ErrMailboxNotFound, got %v", s, err)
		}
	}
}

// ── Property: empty keys in ctor are dropped ─────────────────
// NewStaticSMTPResolver defensively skips empty/whitespace keys.
func TestProperty_StaticSMTPResolver_EmptyKeysDropped(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{
		"":    {Host: "ghost"},
		" ":   {Host: "wsp"},
		"a@b": {Host: "good"},
	})
	// Empty sender must still error.
	if _, err := r.Resolve(context.Background(), ""); err != ErrMailboxNotFound {
		t.Fatalf("empty key should be dropped; want ErrMailboxNotFound got %v", err)
	}
	// Good key works.
	got, err := r.Resolve(context.Background(), "a@b")
	if err != nil {
		t.Fatalf("good key: unexpected err %v", err)
	}
	if got.Host != "good" {
		t.Fatalf("want Host=good, got %q", got.Host)
	}
}

// ── Property: empty map rejects everything ───────────────────
func TestProperty_StaticSMTPResolver_EmptyMap(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{})
	f := func(sender string) bool {
		_, err := r.Resolve(context.Background(), sender)
		return err == ErrMailboxNotFound
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: error path returns zero SMTPSettings ───────────
// No stale settings leak on lookup failure.
func TestProperty_StaticSMTPResolver_ZeroOnError(t *testing.T) {
	r := NewStaticSMTPResolver(map[string]SMTPSettings{"ok@x": {Host: "h", Port: 25}})
	settings, err := r.Resolve(context.Background(), "nope@x")
	if err != ErrMailboxNotFound {
		t.Fatalf("want ErrMailboxNotFound, got %v", err)
	}
	if settings != (SMTPSettings{}) {
		t.Fatalf("errored path leaked settings: %+v", settings)
	}
}

// ── Property: ctor defensively copies input map ──────────────
// Mutating the input after construction must not alter the resolver.
func TestProperty_StaticSMTPResolver_DefensiveCopy(t *testing.T) {
	input := map[string]SMTPSettings{
		"user@x": {Host: "original", Port: 25},
	}
	r := NewStaticSMTPResolver(input)
	// Mutate original map after construction.
	input["user@x"] = SMTPSettings{Host: "hijacked", Port: 99}
	delete(input, "user@x")
	input["added@x"] = SMTPSettings{Host: "new"}

	got, err := r.Resolve(context.Background(), "user@x")
	if err != nil {
		t.Fatalf("original key should still resolve: %v", err)
	}
	if got.Host != "original" {
		t.Fatalf("ctor not defensive: want Host=original, got %q", got.Host)
	}
	if _, err := r.Resolve(context.Background(), "added@x"); err != ErrMailboxNotFound {
		t.Fatalf("post-ctor addition leaked in; want ErrMailboxNotFound")
	}
}

// ── Property: multiple senders isolated ──────────────────────
func TestProperty_StaticSMTPResolver_MultipleSenders(t *testing.T) {
	entries := map[string]SMTPSettings{
		"a@x": {Host: "host-a"},
		"b@x": {Host: "host-b"},
		"c@x": {Host: "host-c"},
	}
	r := NewStaticSMTPResolver(entries)
	for sender, want := range entries {
		got, err := r.Resolve(context.Background(), sender)
		if err != nil {
			t.Fatalf("%q: err %v", sender, err)
		}
		if got.Host != want.Host {
			t.Fatalf("%q: want Host=%q, got %q", sender, want.Host, got.Host)
		}
	}
}
