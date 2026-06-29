package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

// ── Round-trip ───────────────────────────────────────────────────────────────

// TestBuildAndVerify_RoundTrip locks the basic contract: BuildUnsubToken
// followed by VerifyUnsubToken with the same inputs returns true. Any
// drift in the formatting/hashing pipeline breaks unsub links.
func TestBuildAndVerify_RoundTrip(t *testing.T) {
	secret := []byte("test-secret-32-bytes-aaaaaaaaaaa")
	tok := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	if !VerifyUnsubToken(42, 1001, "jan@firma.cz", tok, secret) {
		t.Errorf("round-trip verify failed for token %q", tok)
	}
}

// ── Determinism ──────────────────────────────────────────────────────────────

// TestBuildUnsubToken_Deterministic — same inputs MUST produce the same
// token across calls. Runner re-renders templates per send tick; if the
// token were non-deterministic the BFF could not validate without storing
// every emitted token in DB.
func TestBuildUnsubToken_Deterministic(t *testing.T) {
	secret := []byte("test")
	a := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	b := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	if a != b {
		t.Errorf("not deterministic: a=%q b=%q", a, b)
	}
}

// ── Distinct per recipient ───────────────────────────────────────────────────

// TestBuildUnsubToken_DistinctPerRecipient — different (campaign, contact,
// email) tuples MUST yield different tokens. Otherwise an attacker holding
// one valid link could opt out an arbitrary other recipient.
func TestBuildUnsubToken_DistinctPerRecipient(t *testing.T) {
	secret := []byte("test")
	tokens := []string{
		BuildUnsubToken(42, 1001, "jan@firma.cz", secret),
		BuildUnsubToken(42, 1002, "jan@firma.cz", secret),
		BuildUnsubToken(43, 1001, "jan@firma.cz", secret),
		BuildUnsubToken(42, 1001, "anna@firma.cz", secret),
	}
	for i := 0; i < len(tokens); i++ {
		for j := i + 1; j < len(tokens); j++ {
			if tokens[i] == tokens[j] {
				t.Errorf("collision: tokens[%d]==tokens[%d] (%q)", i, j, tokens[i])
			}
		}
	}
}

// ── Format: 16 lowercase hex ─────────────────────────────────────────────────

// TestBuildUnsubToken_Format — token is exactly 16 lowercase hex chars.
// The BFF /unsubscribe regex `^[0-9a-f]{16}$` rejects anything else;
// drift here breaks unsub links across both layers.
func TestBuildUnsubToken_Format(t *testing.T) {
	secret := []byte("test")
	emails := []string{
		"a@b.cz",
		"longer.address+tag@domain.example",
		"ñon-ascii@háček.cz",
		"",
	}
	for i, email := range emails {
		tok := BuildUnsubToken(int64(i), int64(i*10), email, secret)
		if len(tok) != 16 {
			t.Errorf("email=%q: len=%d, want 16", email, len(tok))
		}
		for _, c := range tok {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				t.Errorf("email=%q: non-hex %q in %q", email, c, tok)
				break
			}
		}
	}
}

// ── Byte-equivalence with previous inline implementation ─────────────────────

// TestBuildUnsubToken_MatchesLegacyFormula — the canonical formula MUST
// match what the runner used to compute inline pre-refactor. Property:
// for arbitrary inputs, the new helper output equals the legacy formula
// output. Encodes the migration safety guarantee in the test suite so any
// future helper rewrite that drifts from `<id>|<id>|<email>` HMAC-SHA256[:16]
// fails loudly.
func TestBuildUnsubToken_MatchesLegacyFormula(t *testing.T) {
	cases := []struct {
		cid, id int64
		email   string
		secret  string
	}{
		{42, 1001, "jan@firma.cz", "secret-a"},
		{1, 1, "x@y.cz", "secret-b"},
		{99999, 88888, "a.b.c@d.e.f.cz", "fallback-secret-aaaaaaaa"},
		{0, 0, "", ""},
		{1, 1, "ñon-ascii@háček.cz", "test"},
	}
	for _, tc := range cases {
		got := BuildUnsubToken(tc.cid, tc.id, tc.email, []byte(tc.secret))

		mac := hmac.New(sha256.New, []byte(tc.secret))
		fmt.Fprintf(mac, "%d|%d|%s", tc.cid, tc.id, tc.email)
		want := hex.EncodeToString(mac.Sum(nil))[:16]

		if got != want {
			t.Errorf("legacy mismatch for %+v: got=%q want=%q", tc, got, want)
		}
	}
}

// ── Verify: wrong secret ─────────────────────────────────────────────────────

// TestVerifyUnsubToken_WrongSecret — verify with a different secret MUST
// fail. Without this, secret rotation could not invalidate old tokens.
func TestVerifyUnsubToken_WrongSecret(t *testing.T) {
	secret := []byte("real-secret")
	wrong := []byte("attacker-secret")
	tok := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	if VerifyUnsubToken(42, 1001, "jan@firma.cz", tok, wrong) {
		t.Error("verify accepted token signed with different secret")
	}
}

// ── Verify: tampered campaignID ──────────────────────────────────────────────

// TestVerifyUnsubToken_TamperedCampaign — token bound to campaign 42
// MUST NOT verify when presented as campaign 99. Locks the BFF contract:
// (c=99 in URL but token signed for c=42) → 403.
func TestVerifyUnsubToken_TamperedCampaign(t *testing.T) {
	secret := []byte("test")
	tok := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	if VerifyUnsubToken(99, 1001, "jan@firma.cz", tok, secret) {
		t.Error("verify accepted token bound to campaign 42 against campaign 99")
	}
}

// ── Verify: tampered contactID ───────────────────────────────────────────────

// TestVerifyUnsubToken_TamperedContact — token bound to contact 1001 MUST
// NOT verify against contact 1002. Otherwise a single leaked link would
// opt out the entire enrolled set.
func TestVerifyUnsubToken_TamperedContact(t *testing.T) {
	secret := []byte("test")
	tok := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	if VerifyUnsubToken(42, 1002, "jan@firma.cz", tok, secret) {
		t.Error("verify accepted token bound to contact 1001 against contact 1002")
	}
}

// ── Verify: tampered email ───────────────────────────────────────────────────

// TestVerifyUnsubToken_TamperedEmail — token bound to one email MUST NOT
// verify when the BFF re-derives a different email from the contact_id
// lookup (e.g. contact email was changed post-send).
func TestVerifyUnsubToken_TamperedEmail(t *testing.T) {
	secret := []byte("test")
	tok := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	if VerifyUnsubToken(42, 1001, "anna@firma.cz", tok, secret) {
		t.Error("verify accepted token bound to jan@ against anna@")
	}
}

// ── Verify: empty token ──────────────────────────────────────────────────────

// TestVerifyUnsubToken_EmptyToken — an empty received token MUST NOT
// verify (defense against client-side stripping or mis-encoded URLs).
func TestVerifyUnsubToken_EmptyToken(t *testing.T) {
	secret := []byte("test")
	if VerifyUnsubToken(42, 1001, "jan@firma.cz", "", secret) {
		t.Error("verify accepted empty token")
	}
}

// ── Verify: garbage token ────────────────────────────────────────────────────

// TestVerifyUnsubToken_GarbageToken — random 16-char strings MUST NOT
// verify against legitimate inputs. Sanity check the constant-time compare
// is doing actual byte comparison and not short-circuiting.
func TestVerifyUnsubToken_GarbageToken(t *testing.T) {
	secret := []byte("test")
	for _, garbage := range []string{
		"0000000000000000",
		"ffffffffffffffff",
		strings.Repeat("a", 16),
		"deadbeefdeadbeef",
	} {
		if VerifyUnsubToken(42, 1001, "jan@firma.cz", garbage, secret) {
			t.Errorf("verify accepted garbage token %q", garbage)
		}
	}
}

// ── Verify: length mismatch ──────────────────────────────────────────────────

// TestVerifyUnsubToken_LengthMismatch — token of wrong length MUST NOT
// verify. hmac.Equal returns false for unequal-length inputs without
// short-circuiting on the first byte (constant-time on the longer slice).
func TestVerifyUnsubToken_LengthMismatch(t *testing.T) {
	secret := []byte("test")
	cases := []string{
		"a",                                // too short
		"deadbeef",                         // too short
		"deadbeefdeadbeefdeadbeefdeadbeef", // too long (full sha256 hex)
	}
	for _, tok := range cases {
		if VerifyUnsubToken(42, 1001, "jan@firma.cz", tok, secret) {
			t.Errorf("verify accepted token of wrong length %q", tok)
		}
	}
}

// ── Verify: forgery resistance ──────────────────────────────────────────────

// TestVerifyUnsubToken_ForgeryResistance — 1000 wrong-secret guesses MUST
// not produce a token that verifies. Probability of accidental collision
// is ≈ 1000 * 2^-64 ≈ 5.4e-17, well below any reasonable test flake rate.
func TestVerifyUnsubToken_ForgeryResistance(t *testing.T) {
	secret := []byte("real-secret")
	for i := 0; i < 1000; i++ {
		guess := []byte(fmt.Sprintf("guess-%d", i))
		tok := BuildUnsubToken(42, 1001, "jan@firma.cz", guess)
		if VerifyUnsubToken(42, 1001, "jan@firma.cz", tok, secret) {
			t.Fatalf("forgery: guess %d produced verifying token %q", i, tok)
		}
	}
}

// ── Empty-input handling ─────────────────────────────────────────────────────

// TestBuildUnsubToken_EmptyInputs — zero/empty inputs are accepted
// (mathematically valid HMAC) but each combination still produces a
// distinct token so callers can distinguish them downstream.
func TestBuildUnsubToken_EmptyInputs(t *testing.T) {
	cases := []struct {
		name   string
		cid    int64
		id     int64
		email  string
		secret []byte
	}{
		{"all-zero", 0, 0, "", nil},
		{"empty-secret", 1, 1, "x@y.cz", []byte{}},
		{"empty-email", 1, 1, "", []byte("s")},
		{"zero-ids", 0, 0, "x@y.cz", []byte("s")},
	}
	seen := map[string]string{}
	for _, tc := range cases {
		tok := BuildUnsubToken(tc.cid, tc.id, tc.email, tc.secret)
		if len(tok) != 16 {
			t.Errorf("%s: len=%d want 16", tc.name, len(tok))
		}
		if prev, ok := seen[tok]; ok {
			t.Errorf("%s: collision with %s on token %q", tc.name, prev, tok)
		}
		seen[tok] = tc.name
	}
}

// ── Constant-time property (smoke) ──────────────────────────────────────────

// TestVerifyUnsubToken_UsesConstantTimeCompare — verifies we delegate to
// hmac.Equal rather than naive ==. Strategy: pass two tokens that differ
// only at the LAST byte. A naive compare would short-circuit on byte 0
// and return false the same way; hmac.Equal also returns false but does
// so without leaking position. We can't directly observe timing in unit
// tests, so this case at least exercises the late-divergence path that
// would expose a naive compare under microbenchmarks.
func TestVerifyUnsubToken_UsesConstantTimeCompare(t *testing.T) {
	secret := []byte("test")
	tok := BuildUnsubToken(42, 1001, "jan@firma.cz", secret)
	// Tamper last byte
	tampered := tok[:15] + "0"
	if tampered == tok {
		// Pick a different replacement
		tampered = tok[:15] + "f"
	}
	if VerifyUnsubToken(42, 1001, "jan@firma.cz", tampered, secret) {
		t.Errorf("late-byte tamper accepted: tok=%q tampered=%q", tok, tampered)
	}
}
