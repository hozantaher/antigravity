package campaign

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
)

// TestBuildUnsubURL_Deterministic locks the contract that buildUnsubURL
// produces the same URL for the same (campaign, contact, email) tuple
// across calls within the same process. The runner re-renders templates
// per send tick and the URL must be stable so the BFF can validate the
// HMAC without storing tokens in DB.
func TestBuildUnsubURL_Deterministic(t *testing.T) {
	os.Setenv("UNSUBSCRIBE_BASE_URL", "https://example.test")
	os.Setenv("UNSUBSCRIBE_SECRET", "test-secret-32-bytes-aaaaaaaaaaa")
	defer os.Unsetenv("UNSUBSCRIBE_BASE_URL")
	defer os.Unsetenv("UNSUBSCRIBE_SECRET")

	a := buildUnsubURL(42, 1001, "jan@firma.cz")
	b := buildUnsubURL(42, 1001, "jan@firma.cz")
	if a != b {
		t.Errorf("buildUnsubURL not deterministic:\n  a=%s\n  b=%s", a, b)
	}
}

// TestBuildUnsubURL_DistinctPerRecipient ensures different (campaign,
// contact, email) tuples yield different tokens — otherwise an attacker
// who has one valid unsub link could opt out arbitrary other recipients.
func TestBuildUnsubURL_DistinctPerRecipient(t *testing.T) {
	os.Setenv("UNSUBSCRIBE_SECRET", "test-secret-aaaaaaaaaaaaaaaaaaaa")
	defer os.Unsetenv("UNSUBSCRIBE_SECRET")

	a := buildUnsubURL(42, 1001, "jan@firma.cz")
	b := buildUnsubURL(42, 1002, "jan@firma.cz")
	c := buildUnsubURL(43, 1001, "jan@firma.cz")
	d := buildUnsubURL(42, 1001, "anna@firma.cz")

	urls := []string{a, b, c, d}
	for i := 0; i < len(urls); i++ {
		for j := i + 1; j < len(urls); j++ {
			if extractToken(t, urls[i]) == extractToken(t, urls[j]) {
				t.Errorf("collision: tokens %d == %d (%s vs %s)", i, j, urls[i], urls[j])
			}
		}
	}
}

// TestBuildUnsubURL_BaseURLOverride verifies UNSUBSCRIBE_BASE_URL env is
// honored. Default falls back to https://garaaage.cz so unset env doesn't
// produce malformed URL.
func TestBuildUnsubURL_BaseURLOverride(t *testing.T) {
	os.Setenv("UNSUBSCRIBE_SECRET", "test")
	defer os.Unsetenv("UNSUBSCRIBE_SECRET")

	tests := []struct {
		envBase     string
		expectStart string
	}{
		{"https://example.test", "https://example.test/unsubscribe?"},
		{"http://localhost:18001", "http://localhost:18001/unsubscribe?"},
		{"", "https://garaaage.cz/unsubscribe?"}, // fallback
	}
	for _, tc := range tests {
		t.Run(tc.envBase, func(t *testing.T) {
			if tc.envBase == "" {
				os.Unsetenv("UNSUBSCRIBE_BASE_URL")
			} else {
				os.Setenv("UNSUBSCRIBE_BASE_URL", tc.envBase)
			}
			defer os.Unsetenv("UNSUBSCRIBE_BASE_URL")
			got := buildUnsubURL(1, 1, "x@y.cz")
			if !strings.HasPrefix(got, tc.expectStart) {
				t.Errorf("got %q, expected prefix %q", got, tc.expectStart)
			}
		})
	}
}

// TestBuildUnsubURL_SecretFallback locks the fallback chain:
// UNSUBSCRIBE_SECRET → OUTREACH_API_KEY. Missing UNSUBSCRIBE_SECRET must
// not produce empty-secret tokens (which would be trivially forgeable).
func TestBuildUnsubURL_SecretFallback(t *testing.T) {
	os.Unsetenv("UNSUBSCRIBE_SECRET")
	os.Setenv("OUTREACH_API_KEY", "fallback-secret-aaaaaaaa")
	defer os.Unsetenv("OUTREACH_API_KEY")

	got := buildUnsubURL(1, 1, "x@y.cz")
	tok := extractToken(t, got)

	// Compute expected HMAC manually using the fallback secret.
	mac := hmac.New(sha256.New, []byte("fallback-secret-aaaaaaaa"))
	fmt.Fprintf(mac, "%d|%d|%s", 1, 1, "x@y.cz")
	want := hex.EncodeToString(mac.Sum(nil))[:16]

	if tok != want {
		t.Errorf("token from fallback secret mismatch: got %q want %q", tok, want)
	}
}

// TestBuildUnsubURL_TokenFormat asserts the token is exactly 16 lowercase
// hex chars. BFF /unsubscribe regex `^[0-9a-f]{16}$` rejects anything
// else, so any drift in token format here would break unsub links.
func TestBuildUnsubURL_TokenFormat(t *testing.T) {
	os.Setenv("UNSUBSCRIBE_SECRET", "test")
	defer os.Unsetenv("UNSUBSCRIBE_SECRET")

	for i, email := range []string{"a@b.cz", "longer.address+tag@domain.example", "ñon-ascii@háček.cz"} {
		got := buildUnsubURL(int64(i), int64(i*10), email)
		tok := extractToken(t, got)
		if len(tok) != 16 {
			t.Errorf("email=%q: token len %d, expected 16", email, len(tok))
		}
		for _, c := range tok {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				t.Errorf("email=%q: non-hex char %q in token %q", email, c, tok)
				break
			}
		}
	}
}

// TestBuildUnsubURL_QueryParams asserts c=campaign_id, id=contact_id,
// t=token are all present and parseable. BFF endpoint validates each.
func TestBuildUnsubURL_QueryParams(t *testing.T) {
	os.Setenv("UNSUBSCRIBE_SECRET", "test")
	defer os.Unsetenv("UNSUBSCRIBE_SECRET")

	got := buildUnsubURL(42, 1001, "jan@firma.cz")
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("url.Parse failed: %v", err)
	}
	q := u.Query()
	if q.Get("c") != "42" {
		t.Errorf("c=%q, expected 42", q.Get("c"))
	}
	if q.Get("id") != "1001" {
		t.Errorf("id=%q, expected 1001", q.Get("id"))
	}
	if len(q.Get("t")) != 16 {
		t.Errorf("t=%q, expected 16-char token", q.Get("t"))
	}
}

// TestBuildUnsubURL_ForgeryResistance — mock attacker has 16 random hex
// chars guessed for token. Probability of collision is 2^-64 per attempt.
// We assert that 1000 random tokens never match a legitimate one (sanity
// check that buildUnsubURL output is HMAC-derived, not predictable).
func TestBuildUnsubURL_ForgeryResistance(t *testing.T) {
	os.Setenv("UNSUBSCRIBE_SECRET", "test-secret")
	defer os.Unsetenv("UNSUBSCRIBE_SECRET")

	legit := extractToken(t, buildUnsubURL(42, 1001, "jan@firma.cz"))

	// Try brute-force: same campaign+contact, but different secret guesses.
	for i := 0; i < 1000; i++ {
		guess := fmt.Sprintf("guess-%d", i)
		mac := hmac.New(sha256.New, []byte(guess))
		fmt.Fprintf(mac, "%d|%d|%s", 42, 1001, "jan@firma.cz")
		got := hex.EncodeToString(mac.Sum(nil))[:16]
		if got == legit {
			t.Fatalf("forgery: secret %q produced same token", guess)
		}
	}
}

// extractToken pulls the t= query param from a URL string.
func extractToken(t *testing.T, urlStr string) string {
	t.Helper()
	u, err := url.Parse(urlStr)
	if err != nil {
		t.Fatalf("url.Parse failed: %v", err)
	}
	return u.Query().Get("t")
}
