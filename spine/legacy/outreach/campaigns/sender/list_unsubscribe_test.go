package sender

// Tests for BuildListUnsubscribeHeaders and BuildListUnsubscribeToken.
//
// Coverage targets (extreme-testing rule: ≥10 cases per change):
//
//  1. Normal URL → angle-bracket wrapping + One-Click value
//  2. Empty URL → both values empty (fail-silent, no panic)
//  3. CRLF in URL → stripped, no header injection
//  4. HTTPS URL → passes through angle-brackets unchanged
//  5. Token non-empty when secret provided
//  6. Token empty when secret nil / empty
//  7. Token differs for different sendEventIDs
//  8. Token differs for different contactIDs
//  9. Same inputs produce same token (deterministic)
// 10. Token is valid base64url (no +/= chars)
// 11. buildMessage output contains List-Unsubscribe headers
// 12. buildMessage List-Unsubscribe-Post value is exact RFC 8058 literal

import (
	"encoding/base64"
	"strings"
	"testing"
)

// ─── BuildListUnsubscribeHeaders ─────────────────────────────────────────────

func TestBuildListUnsubscribeHeaders_Normal(t *testing.T) {
	url := "https://garaaage.cz/unsubscribe?c=42&id=7&t=abcdef0123456789"
	lu, lup := BuildListUnsubscribeHeaders(url)
	want := "<" + url + ">"
	if lu != want {
		t.Errorf("List-Unsubscribe = %q, want %q", lu, want)
	}
	if lup != "List-Unsubscribe=One-Click" {
		t.Errorf("List-Unsubscribe-Post = %q, want %q", lup, "List-Unsubscribe=One-Click")
	}
}

func TestBuildListUnsubscribeHeaders_EmptyURL(t *testing.T) {
	lu, lup := BuildListUnsubscribeHeaders("")
	if lu != "" || lup != "" {
		t.Errorf("empty URL: got (%q, %q), want both empty", lu, lup)
	}
}

func TestBuildListUnsubscribeHeaders_CRLFInURL_Stripped(t *testing.T) {
	// A CRLF in the URL could split the header line and inject a new header.
	// BuildListUnsubscribeHeaders must strip all CR and LF characters so
	// the resulting value is safe to write as a single header-line value.
	// After stripping, "Bcc: attacker" becomes a harmless run-on string —
	// its threat was the CRLF that would have terminated the header line.
	url := "https://garaaage.cz/unsub?c=1\r\nBcc: attacker@evil.com"
	lu, _ := BuildListUnsubscribeHeaders(url)
	if strings.ContainsAny(lu, "\r\n") {
		t.Errorf("CRLF must be stripped from List-Unsubscribe value, got: %q", lu)
	}
	// The result must be a single logical line (no newline characters).
	if strings.Count(lu, "\n") > 0 || strings.Count(lu, "\r") > 0 {
		t.Errorf("List-Unsubscribe must contain no newlines: %q", lu)
	}
}

func TestBuildListUnsubscribeHeaders_BareNewlineInURL_Stripped(t *testing.T) {
	url := "https://garaaage.cz/unsub?c=1\nX-Injected: yes"
	lu, _ := BuildListUnsubscribeHeaders(url)
	if strings.ContainsAny(lu, "\r\n") {
		t.Errorf("bare LF must be stripped from List-Unsubscribe value, got: %q", lu)
	}
}

func TestBuildListUnsubscribeHeaders_HTTPSURLPassesThrough(t *testing.T) {
	url := "https://garaaage.cz/unsubscribe?c=99&id=123&t=deadbeefcafebabe"
	lu, lup := BuildListUnsubscribeHeaders(url)
	if !strings.HasPrefix(lu, "<https://") {
		t.Errorf("HTTPS URL must be preserved inside angle-brackets, got: %q", lu)
	}
	if !strings.HasSuffix(lu, ">") {
		t.Errorf("List-Unsubscribe must end with >, got: %q", lu)
	}
	if lup != "List-Unsubscribe=One-Click" {
		t.Errorf("List-Unsubscribe-Post must be exact RFC 8058 literal, got: %q", lup)
	}
}

func TestBuildListUnsubscribeHeaders_OnlyWhitespaceURL(t *testing.T) {
	// A URL that is entirely CRLF collapses to empty after stripping.
	lu, lup := BuildListUnsubscribeHeaders("\r\n\r\n")
	if lu != "" || lup != "" {
		t.Errorf("all-CRLF URL: got (%q, %q), want both empty", lu, lup)
	}
}

// ─── BuildListUnsubscribeToken ───────────────────────────────────────────────

func TestBuildListUnsubscribeToken_NonEmptyWithSecret(t *testing.T) {
	tok := BuildListUnsubscribeToken("evt-abc-123", 42, []byte("secretkey"))
	if tok == "" {
		t.Fatal("expected non-empty token when secret is provided")
	}
}

func TestBuildListUnsubscribeToken_EmptyWithNilSecret(t *testing.T) {
	tok := BuildListUnsubscribeToken("evt-abc-123", 42, nil)
	if tok != "" {
		t.Errorf("nil secret must return empty token, got %q", tok)
	}
}

func TestBuildListUnsubscribeToken_EmptyWithEmptySecret(t *testing.T) {
	tok := BuildListUnsubscribeToken("evt-abc-123", 42, []byte{})
	if tok != "" {
		t.Errorf("empty secret must return empty token, got %q", tok)
	}
}

func TestBuildListUnsubscribeToken_DifferentSendEvents(t *testing.T) {
	secret := []byte("test-secret-key-32bytes-padding!")
	tok1 := BuildListUnsubscribeToken("evt-001", 42, secret)
	tok2 := BuildListUnsubscribeToken("evt-002", 42, secret)
	if tok1 == tok2 {
		t.Errorf("different sendEventIDs must produce different tokens; both %q", tok1)
	}
}

func TestBuildListUnsubscribeToken_DifferentContactIDs(t *testing.T) {
	secret := []byte("test-secret-key-32bytes-padding!")
	tok1 := BuildListUnsubscribeToken("evt-001", 100, secret)
	tok2 := BuildListUnsubscribeToken("evt-001", 200, secret)
	if tok1 == tok2 {
		t.Errorf("different contactIDs must produce different tokens; both %q", tok1)
	}
}

func TestBuildListUnsubscribeToken_Deterministic(t *testing.T) {
	secret := []byte("test-secret-key-32bytes-padding!")
	tok1 := BuildListUnsubscribeToken("evt-xyz", 77, secret)
	tok2 := BuildListUnsubscribeToken("evt-xyz", 77, secret)
	if tok1 != tok2 {
		t.Errorf("same inputs must produce same token; got %q vs %q", tok1, tok2)
	}
}

func TestBuildListUnsubscribeToken_ValidBase64URL(t *testing.T) {
	secret := []byte("test-secret-key-32bytes-padding!")
	tok := BuildListUnsubscribeToken("evt-abc", 99, secret)
	// base64url (no padding) must not contain +, /, or = characters.
	if strings.ContainsAny(tok, "+/=") {
		t.Errorf("token must be base64url (no +/=), got %q", tok)
	}
	// Must decode cleanly.
	if _, err := base64.RawURLEncoding.DecodeString(tok); err != nil {
		t.Errorf("token is not valid base64url: %v — got %q", err, tok)
	}
}

// ─── buildMessage integration ─────────────────────────────────────────────────

// TestBuildMessage_ContainsListUnsubscribeHeaders verifies that headers
// injected by runner.go (via BuildListUnsubscribeHeaders) survive the
// buildMessage serialisation path unchanged.
func TestBuildMessage_ContainsListUnsubscribeHeaders(t *testing.T) {
	unsubURL := "https://garaaage.cz/unsubscribe?c=5&id=101&t=aabbccddeeff0011"
	luVal, lupVal := BuildListUnsubscribeHeaders(unsubURL)

	headers := map[string]string{
		"List-Unsubscribe":      luVal,
		"List-Unsubscribe-Post": lupVal,
		"Date":                  "Mon, 05 May 2026 09:00:00 +0200",
	}
	msg := buildMessage(
		"sender@firma.cz",
		"recipient@target.cz",
		"Test predmet",
		"Telo zpravy.",
		"",
		headers,
		"<mid@firma.cz>",
	)
	s := string(msg)
	if !strings.Contains(s, "List-Unsubscribe: <https://garaaage.cz/unsubscribe?c=5&id=101&t=aabbccddeeff0011>") {
		t.Errorf("buildMessage output must contain List-Unsubscribe header; output:\n%s", s)
	}
	if !strings.Contains(s, "List-Unsubscribe-Post: List-Unsubscribe=One-Click") {
		t.Errorf("buildMessage output must contain List-Unsubscribe-Post header; output:\n%s", s)
	}
}

// TestBuildMessage_ListUnsubscribePostExactValue verifies the RFC 8058-required
// literal value "List-Unsubscribe=One-Click" is present verbatim.
func TestBuildMessage_ListUnsubscribePostExactValue(t *testing.T) {
	_, lupVal := BuildListUnsubscribeHeaders("https://garaaage.cz/unsub?c=1&id=2&t=aabbccddeeff0011")
	if lupVal != "List-Unsubscribe=One-Click" {
		t.Errorf("List-Unsubscribe-Post value must be exactly %q per RFC 8058, got %q",
			"List-Unsubscribe=One-Click", lupVal)
	}
}
