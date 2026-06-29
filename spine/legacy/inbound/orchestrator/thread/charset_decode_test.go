package thread

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestCharset_Inbound_Windows1250 is the AL-F3 reproducer at the thread
// package boundary: it feeds the windows-1250 fixture (modelled on the
// real inbound id=504, gerhatova@gevotransport.eu RE: Dotaz) through
// parseRawIfPresent → bodyHTMLFromParsed and asserts the operator-
// visible body_html contains `Dobrý den` instead of U+FFFD replacement
// chars.
//
// Before AL-F3 this asserted Dobr� den (U+FFFD) — id=504 in
// unmatched_inbound has that visible at /replies/-504. After AL-F3
// the upstream charset-aware decoder transcodes windows-1250 →
// UTF-8 before string() conversion, so the operator sees Czech
// diacritics intact.
//
// safeUTF8() in inbound.go is the downstream guard; it cannot recover
// the original bytes once they are mis-stringified upstream — by the
// time it sees them they are already U+FFFD. So this test exercises
// the upstream path on purpose.
func TestCharset_Inbound_Windows1250(t *testing.T) {
	raw := loadCharsetFixture(t, "utf8_windows1250.eml")

	parsed := parseRawIfPresent(RawInbound{
		MessageID: "<al-f3-windows1250@example.cz>",
		From:      "gerhatova@gevotransport.eu",
		Subject:   "RE: Dotaz",
		RawBytes:  raw,
	})
	if parsed == nil {
		t.Fatal("parseRawIfPresent returned nil — RawBytes ignored?")
	}

	bodyHTML := bodyHTMLFromParsed(parsed)
	if bodyHTML == "" {
		t.Fatalf("bodyHTML empty; parsed=%+v", parsed)
	}
	if !utf8.ValidString(bodyHTML) {
		t.Errorf("bodyHTML is not valid UTF-8: %q", bodyHTML)
	}
	if strings.ContainsRune(bodyHTML, '�') {
		t.Errorf("bodyHTML still contains U+FFFD replacement char — AL-F3 upstream transcode missing\n%q", bodyHTML)
	}
	if !strings.Contains(bodyHTML, "Dobrý den") {
		t.Errorf("bodyHTML missing %q (czech 'ý'); got %q", "Dobrý den", bodyHTML)
	}
	if !strings.Contains(bodyHTML, "děkujeme") {
		t.Errorf("bodyHTML missing %q (czech 'ě'); got %q", "děkujeme", bodyHTML)
	}

	// safeUTF8 must be a no-op on already-clean UTF-8 — confirm we did
	// not accidentally undo our own fix.
	if got := safeUTF8(bodyHTML); got != bodyHTML {
		t.Errorf("safeUTF8 mutated already-clean UTF-8 string")
	}
}

func loadCharsetFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return bytes.ReplaceAll(b, []byte("\n"), []byte("\r\n"))
}
