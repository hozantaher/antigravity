package mime

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// TestParse_Charset_Transcoding exercises the AL-F3 charset-aware MIME
// body decode path.
//
// Background (2026-05-18): inbound id=504 in unmatched_inbound had Czech
// text rendered as `Dobr� den` (U+FFFD replacement chars) instead of
// `Dobrý den`. The MIME body was windows-1250 quoted-printable from
// Outlook; the previous parser called string(data) directly, treating
// bytes as if they were UTF-8.
//
// The fix transcodes via golang.org/x/net/html/charset.NewReaderLabel
// before stringifying. This test exercises the common Czech charsets
// (windows-1250, iso-8859-2), the most common western charset (latin1),
// UTF-8 passthrough, and a malformed-input fallback.
//
// Per HARD RULE feedback_extreme_testing: ingestion code = state-mutating,
// risk-proportional minimum is happy + boundary + error + integration.
func TestParse_Charset_Transcoding(t *testing.T) {
	cases := []struct {
		name             string
		fixture          string
		wantHTMLContains string // empty → skip BodyHTML assertion
		wantTextContains string // empty → skip BodyPlain assertion
	}{
		{
			name:             "windows-1250 single-part html",
			fixture:          "charset-windows1250.eml",
			wantHTMLContains: "Dobrý den, děkujeme za nabídku.",
		},
		{
			name:             "iso-8859-2 single-part plain",
			fixture:          "charset-iso88592.eml",
			wantTextContains: "Dobrý den, děkujeme za nabídku.",
		},
		{
			name:             "iso-8859-1 (latin1) single-part plain",
			fixture:          "charset-latin1.eml",
			wantTextContains: "Répondez sîl vous plaît.",
		},
		{
			name:             "utf-8 passthrough single-part plain",
			fixture:          "charset-utf8.eml",
			wantTextContains: "Děkuji za nabídku. Dobrý den.",
		},
		{
			name:             "windows-1250 multipart/alternative both parts",
			fixture:          "charset-multipart-windows1250.eml",
			wantTextContains: "Dobrý den, plain part.",
			wantHTMLContains: "Dobrý den, HTML part.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := loadFixture(t, tc.fixture)
			out, err := Parse(raw)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if tc.wantHTMLContains != "" {
				if !strings.Contains(out.BodyHTML, tc.wantHTMLContains) {
					t.Errorf("BodyHTML missing %q\ngot: %q", tc.wantHTMLContains, out.BodyHTML)
				}
				if !utf8.ValidString(out.BodyHTML) {
					t.Errorf("BodyHTML not valid UTF-8")
				}
				if strings.ContainsRune(out.BodyHTML, '�') {
					t.Errorf("BodyHTML contains U+FFFD replacement char: %q", out.BodyHTML)
				}
			}
			if tc.wantTextContains != "" {
				if !strings.Contains(out.BodyPlain, tc.wantTextContains) {
					t.Errorf("BodyPlain missing %q\ngot: %q", tc.wantTextContains, out.BodyPlain)
				}
				if !utf8.ValidString(out.BodyPlain) {
					t.Errorf("BodyPlain not valid UTF-8")
				}
				if strings.ContainsRune(out.BodyPlain, '�') {
					t.Errorf("BodyPlain contains U+FFFD replacement char: %q", out.BodyPlain)
				}
			}
		})
	}
}

// TestParse_Charset_MissingLabelFallsBack verifies that a body with no
// charset parameter and non-UTF-8 bytes is handled gracefully — either
// transcoded by charset.DetermineEncoding's BOM/heuristic sniff, or
// passed through with U+FFFD substitution. The contract is "never panic,
// never return raw garbage bytes that break Postgres TEXT INSERT".
func TestParse_Charset_MissingLabelFallsBack(t *testing.T) {
	raw := []byte("From: x@y\r\n" +
		"To: a@b\r\n" +
		"Subject: garbage\r\n" +
		"Date: Mon, 18 May 2026 12:00:00 +0200\r\n" +
		"Message-ID: <garbage@example>\r\n" +
		"Content-Type: text/plain\r\n" +
		"\r\n" +
		"\xfd\xec\xe1 invalid utf8 bytes\r\n")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !utf8.ValidString(out.BodyPlain) {
		t.Errorf("BodyPlain not valid UTF-8 after fallback: %q", out.BodyPlain)
	}
	// The fallback may leave the bytes interpreted as latin1 or insert
	// U+FFFD — either is acceptable as long as the result is valid UTF-8.
	if out.BodyPlain == "" {
		t.Errorf("BodyPlain should not be empty for a body-bearing message")
	}
}
