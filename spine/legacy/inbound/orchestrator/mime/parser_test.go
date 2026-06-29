package mime

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

// loadFixture reads testdata/<name>.eml and normalizes line endings.
// Real RFC822 is CRLF — we keep LF in fixtures for editor sanity and
// rewrite on load so the parser sees what a real IMAP server would deliver.
func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return bytes.ReplaceAll(b, []byte("\n"), []byte("\r\n"))
}

// ── Test 1: empty input → error ────────────────────────────────────────
func TestParse_Empty(t *testing.T) {
	if _, err := Parse(nil); err == nil {
		t.Error("expected error on empty input")
	}
}

// ── Test 2: plain.eml → BodyPlain populated, no HTML, no attachments ──
func TestParse_Plain(t *testing.T) {
	raw := loadFixture(t, "plain.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyPlain, "Děkuji za nabídku") {
		t.Errorf("BodyPlain missing UTF-8 content: %q", out.BodyPlain)
	}
	if out.BodyHTML != "" {
		t.Errorf("BodyHTML should be empty for plain mail, got %q", out.BodyHTML)
	}
	if len(out.Attachments) != 0 {
		t.Errorf("expected 0 attachments, got %d", len(out.Attachments))
	}
}

// ── Test 3: html.eml → BodyHTML populated, no plain ──────────────────
func TestParse_HTML(t *testing.T) {
	raw := loadFixture(t, "html.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyHTML, "<b>Děkuji</b>") {
		t.Errorf("BodyHTML missing expected markup: %q", out.BodyHTML)
	}
	if out.BodyPlain != "" {
		t.Errorf("BodyPlain should be empty for html-only mail")
	}
}

// ── Test 4: multipart-alt.eml → both BodyPlain + BodyHTML populated ──
func TestParse_MultipartAlt(t *testing.T) {
	raw := loadFixture(t, "multipart-alt.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyPlain, "Plain alternative body") {
		t.Errorf("BodyPlain wrong: %q", out.BodyPlain)
	}
	if !strings.Contains(out.BodyHTML, "HTML alternative body") {
		t.Errorf("BodyHTML wrong: %q", out.BodyHTML)
	}
}

// ── Test 5: inline-image.eml → 1 inline attachment with content_id ────
func TestParse_InlineImage(t *testing.T) {
	raw := loadFixture(t, "inline-image.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyHTML, `cid:logo-001@example`) {
		t.Errorf("BodyHTML lost cid: reference: %q", out.BodyHTML)
	}
	if len(out.Attachments) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(out.Attachments))
	}
	a := out.Attachments[0]
	if a.ContentID != "logo-001@example" {
		t.Errorf("ContentID: %q (want logo-001@example, no brackets)", a.ContentID)
	}
	if a.ContentType != "image/png" {
		t.Errorf("ContentType: %q", a.ContentType)
	}
	if !a.IsInline {
		t.Error("expected IsInline=true")
	}
	// Decoded PNG should start with the PNG magic header.
	if len(a.Data) < 8 || !bytes.Equal(a.Data[:8], []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		t.Errorf("PNG magic bytes mismatch: %x", a.Data[:min(len(a.Data), 8)])
	}
}

// ── Test 6: attachments.eml → 2 non-inline attachments ────────────────
func TestParse_Attachments(t *testing.T) {
	raw := loadFixture(t, "attachments.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyPlain, "Příloha v plné kráse") {
		t.Errorf("BodyPlain wrong: %q", out.BodyPlain)
	}
	if len(out.Attachments) != 2 {
		t.Fatalf("expected 2 attachments, got %d", len(out.Attachments))
	}
	// First: PDF.
	if out.Attachments[0].Filename != "contract.pdf" {
		t.Errorf("att[0].Filename: %q", out.Attachments[0].Filename)
	}
	if out.Attachments[0].ContentType != "application/pdf" {
		t.Errorf("att[0].ContentType: %q", out.Attachments[0].ContentType)
	}
	if out.Attachments[0].IsInline {
		t.Error("att[0] should NOT be inline (Content-Disposition: attachment)")
	}
	// Second: JPEG.
	if out.Attachments[1].Filename != "photo.jpg" {
		t.Errorf("att[1].Filename: %q", out.Attachments[1].Filename)
	}
	if out.Attachments[1].ContentType != "image/jpeg" {
		t.Errorf("att[1].ContentType: %q", out.Attachments[1].ContentType)
	}
	// First 4 bytes of decoded PDF = "%PDF" (0x25 0x50 0x44 0x46).
	if len(out.Attachments[0].Data) < 4 || string(out.Attachments[0].Data[:4]) != "%PDF" {
		t.Errorf("PDF magic mismatch: %q", out.Attachments[0].Data[:min(len(out.Attachments[0].Data), 4)])
	}
}

// ── Test 7: nested-multipart.eml → recursive, both bodies + 1 att ────
func TestParse_NestedMultipart(t *testing.T) {
	raw := loadFixture(t, "nested-multipart.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyPlain, "Inner plain") {
		t.Errorf("BodyPlain not recursed: %q", out.BodyPlain)
	}
	if !strings.Contains(out.BodyHTML, "<b>HTML</b>") {
		t.Errorf("BodyHTML not recursed: %q", out.BodyHTML)
	}
	if len(out.Attachments) != 1 {
		t.Fatalf("expected 1 attachment from outer, got %d", len(out.Attachments))
	}
	if out.Attachments[0].Filename != "report.pdf" {
		t.Errorf("att.Filename: %q", out.Attachments[0].Filename)
	}
}

// ── Test 8: quoted-printable.eml → CTE decoded ────────────────────────
func TestParse_QuotedPrintable(t *testing.T) {
	raw := loadFixture(t, "quoted-printable.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(out.BodyPlain, "Děkuji za nabídku") {
		t.Errorf("QP not decoded: %q", out.BodyPlain)
	}
}

// ── Test 9: RFC 2047 subject decoded ──────────────────────────────────
func TestParse_RFC2047Subject(t *testing.T) {
	raw := loadFixture(t, "quoted-printable.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Headers retains raw; verify the encoded form is present and the
	// decode helper works on it.
	subj := out.Headers.Get("Subject")
	decoded := decodeRFC2047(subj)
	if !strings.Contains(decoded, "Příjemný pozdrav") {
		t.Errorf("RFC 2047 subject not decoded: %q → %q", subj, decoded)
	}
}

// ── Test 10: stripBrackets removes <> ─────────────────────────────────
func TestStripBrackets(t *testing.T) {
	cases := []struct{ in, want string }{
		{"<abc@xyz>", "abc@xyz"},
		{"abc@xyz", "abc@xyz"},
		{" <abc@xyz> ", "abc@xyz"},
		{"", ""},
	}
	for _, c := range cases {
		if got := stripBrackets(c.in); got != c.want {
			t.Errorf("stripBrackets(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ── Test 11: malformed input doesn't panic ────────────────────────────
func TestParse_MalformedDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("panicked on malformed input: %v", r)
		}
	}()
	cases := [][]byte{
		[]byte("not a mail"),
		[]byte("\r\n\r\n"),
		[]byte("Subject: x\r\n\r\nbody no content-type"),
		bytes.Repeat([]byte{0x00}, 100),
		[]byte("Content-Type: multipart/mixed; boundary=BOUND\r\n\r\n--BOUND\r\nbroken"),
	}
	for i, c := range cases {
		if _, err := Parse(c); err == nil {
			// Some malformed inputs may parse partially without an error;
			// the contract is "don't panic" not "always error".
			_ = i
		}
	}
}

// ── Test 12: base64 attachment SHA matches expected ───────────────────
// Verifies CTE decoding is byte-perfect (regression on dropped trailing
// padding bytes manifests as one wrong SHA).
func TestParse_AttachmentBytesExact(t *testing.T) {
	raw := loadFixture(t, "inline-image.eml")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// The fixture's base64 decodes to a specific 1×1 transparent PNG.
	expected, _ := base64.StdEncoding.DecodeString(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
	if len(out.Attachments) != 1 {
		t.Fatal("attachment missing")
	}
	got := out.Attachments[0].Data
	if !bytes.Equal(got, expected) {
		gh := sha256.Sum256(got)
		eh := sha256.Sum256(expected)
		t.Errorf("byte mismatch — got sha %x, want %x", gh[:8], eh[:8])
	}
}

// ── Test 13: empty body returns empty output, not error ───────────────
func TestParse_HeadersOnlyNoBody(t *testing.T) {
	raw := []byte("From: a@b\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\n")
	out, err := Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if out.BodyPlain != "" {
		t.Errorf("expected empty BodyPlain, got %q", out.BodyPlain)
	}
}

// ── Test 14: multipart without boundary → error returned ──────────────
func TestParse_MultipartNoBoundary(t *testing.T) {
	raw := []byte("From: a@b\r\nContent-Type: multipart/mixed\r\n\r\nbody")
	_, err := Parse(raw)
	if err == nil {
		t.Error("expected error for multipart without boundary param")
	}
}

// ── Test 15: name= parameter on Content-Type used as filename fallback ─
func TestParse_NameParamFilename(t *testing.T) {
	raw := loadFixture(t, "attachments.eml")
	out, _ := Parse(raw)
	// First attachment has BOTH name= and filename= — Content-Disposition wins.
	if out.Attachments[0].Filename != "contract.pdf" {
		t.Errorf("filename: %q", out.Attachments[0].Filename)
	}
}

// ── Test 16: source-level audit — stdlib + golang.org/x quasi-stdlib only ──
// Memory rule (initiative S1.3): no github.com/... dependencies. The
// golang.org/x/net and golang.org/x/text trees are maintained by the
// Go team and ship alongside the stdlib release cycle, so they count
// as quasi-stdlib for our purposes. AL-F3 (2026-05-18) added
// golang.org/x/net/html/charset for windows-1250 / iso-8859-2 / latin1
// transcoding — stdlib `mime` package has no cross-charset transcoder.
func TestSourceLevelAudit_NoThirdPartyImports(t *testing.T) {
	// Whitelist: quasi-stdlib packages maintained by the Go team.
	allowedThirdParty := map[string]string{
		"golang.org/x/net/html/charset": "AL-F3: MIME body charset transcoding (windows-1250 / iso-8859-2 / latin1)",
	}

	src, err := os.ReadFile("parser.go")
	if err != nil {
		t.Skipf("read parser.go: %v", err)
	}
	// Imports come between `import (` and `)` blocks. Look for any path
	// that contains '.' (third-party always do, e.g. "github.com/...").
	inImports := false
	for _, line := range strings.Split(string(src), "\n") {
		if strings.HasPrefix(line, "import (") {
			inImports = true
			continue
		}
		if inImports && line == ")" {
			break
		}
		if inImports && strings.Contains(line, `"`) {
			pkg := strings.TrimSpace(line)
			pkg = strings.TrimSpace(strings.SplitN(pkg, "//", 2)[0])
			// Strip alias if any.
			parts := strings.Fields(pkg)
			path := strings.Trim(parts[len(parts)-1], `"`)
			if !strings.Contains(path, ".") {
				continue
			}
			if _, ok := allowedThirdParty[path]; ok {
				continue
			}
			t.Errorf("third-party import detected (stdlib-only policy): %q", path)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
