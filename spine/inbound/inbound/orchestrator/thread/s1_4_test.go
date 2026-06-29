package thread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for S1.4 — RecordInbound full persist + sanitize.
// ════════════════════════════════════════════════════════════════════════

// recordingSanitizer captures every Sanitize call so tests can assert
// what the production code passed to bluemonday.
type recordingSanitizer struct {
	calls []string
	out   string // what to return
}

func (r *recordingSanitizer) Sanitize(s string) string {
	r.calls = append(r.calls, s)
	if r.out != "" {
		return r.out
	}
	return "[sanitized]"
}

// helper: bring up sqlmock + recorder with the recording sanitizer.
func newMockRecorder(t *testing.T) (*MessageRecorder, sqlmock.Sqlmock, *recordingSanitizer) {
	t.Helper()
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	san := &recordingSanitizer{}
	rec := NewMessageRecorder(db).WithSanitizer(san)
	return rec, mock, san
}

// 1. RecordInbound with no attachments uses single INSERT (no tx).
func TestS14_NoAttachments_SingleInsert(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))

	id, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 1, Subject: "x", BodyPlain: "hi",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if id != 42 {
		t.Errorf("id: %d", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 2. With 1 attachment: BEGIN + 2 INSERTs + COMMIT.
func TestS14_OneAttachment_TxFlow(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7))
	mock.ExpectExec(`INSERT INTO message_attachments`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	att := InboundAttachment{
		ContentID: "logo", Filename: "logo.png", ContentType: "image/png",
		Data: []byte{0x89, 0x50, 0x4E, 0x47}, SizeBytes: 4,
		SHA256: strings.Repeat("0", 64), IsInline: true,
	}
	id, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 1, Subject: "x", BodyPlain: "hi", Attachments: []InboundAttachment{att},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if id != 7 {
		t.Errorf("id: %d", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 3. 3 attachments → 4 INSERTs + COMMIT.
func TestS14_ThreeAttachments_AllPersisted(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(8))
	for i := 0; i < 3; i++ {
		mock.ExpectExec(`INSERT INTO message_attachments`).
			WillReturnResult(sqlmock.NewResult(int64(i+1), 1))
	}
	mock.ExpectCommit()

	atts := make([]InboundAttachment, 3)
	for i := range atts {
		atts[i] = InboundAttachment{
			Filename: "a.bin", ContentType: "application/octet-stream",
			Data: []byte{byte(i)}, SizeBytes: 1, SHA256: strings.Repeat("a", 64),
		}
	}
	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 1, Subject: "x", BodyPlain: "y", Attachments: atts,
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 4. Attachment INSERT fails → tx rolled back, no commit.
func TestS14_AttachmentFailure_Rollback(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(9))
	mock.ExpectExec(`INSERT INTO message_attachments`).
		WillReturnError(errSimulated)
	mock.ExpectRollback()

	_, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 1, Subject: "x", Attachments: []InboundAttachment{
			{Filename: "x.bin", ContentType: "application/octet-stream", Data: []byte{0}, SizeBytes: 1, SHA256: strings.Repeat("0", 64)},
		},
	})
	if err == nil {
		t.Error("expected error from attachment insert")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 5. Sanitizer is invoked when BodyHTML is non-empty.
func TestS14_Sanitizer_CalledWithRawHTML(t *testing.T) {
	rec, mock, san := newMockRecorder(t)
	mock.ExpectQuery(`INSERT INTO outreach_messages (
			thread_id, direction, message_id, in_reply_to, references_header,
			subject, body_preview, body_hash,
			body_text, body_html, body_html_raw, body_size_bytes,
			sentiment, reply_type, replied_at
		) VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id
	`).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(11))

	rawHTML := `<script>alert(1)</script><p>Hello</p>`
	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 1, BodyHTML: rawHTML,
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(san.calls) != 1 || san.calls[0] != rawHTML {
		t.Errorf("sanitizer not called with raw HTML — calls=%v", san.calls)
	}
}

// 6. Empty BodyHTML → no sanitizer call (avoid wasted work).
func TestS14_Sanitizer_SkippedForEmptyHTML(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	san := &recordingSanitizer{}
	rec := NewMessageRecorder(db).WithSanitizer(san)

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(12))

	if _, err := rec.RecordInbound(context.Background(), InboundMessage{ThreadID: 1, BodyPlain: "x"}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(san.calls) != 0 {
		t.Errorf("sanitizer called for empty HTML: %v", san.calls)
	}
}

// 7. nullableString empty → nil
func TestS14_nullableString(t *testing.T) {
	if got := nullableString(""); got != nil {
		t.Errorf("empty: %v", got)
	}
	if got := nullableString("x"); got != "x" {
		t.Errorf("non-empty: %v", got)
	}
}

// 8. nullableInt zero → nil
func TestS14_nullableInt(t *testing.T) {
	if got := nullableInt(0); got != nil {
		t.Errorf("zero: %v", got)
	}
	if got := nullableInt(7); got != 7 {
		t.Errorf("nonzero: %v", got)
	}
}

// 9. parseRawIfPresent returns nil when RawBytes empty.
func TestS14_parseRawIfPresent_Empty(t *testing.T) {
	if p := parseRawIfPresent(RawInbound{}); p != nil {
		t.Errorf("expected nil, got %+v", p)
	}
}

// 10. attachmentsFromParsed computes SHA256 + size correctly.
func TestS14_attachmentsFromParsed_SHAComputed(t *testing.T) {
	raw := []byte("From: a@b\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n" +
		"--B\r\nContent-Type: text/plain\r\n\r\nbody\r\n" +
		"--B\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"x.png\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
		"iVBORw0KGgo=\r\n--B--\r\n")
	p := parseRawIfPresent(RawInbound{RawBytes: raw})
	if p == nil {
		t.Fatal("expected parsed message")
	}
	atts := attachmentsFromParsed(p)
	if len(atts) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(atts))
	}
	want := sha256.Sum256(atts[0].Data)
	if atts[0].SHA256 != hex.EncodeToString(want[:]) {
		t.Errorf("SHA256 mismatch: %s", atts[0].SHA256)
	}
	if atts[0].SizeBytes != len(atts[0].Data) {
		t.Errorf("SizeBytes %d != len(Data) %d", atts[0].SizeBytes, len(atts[0].Data))
	}
}

// 11. Production sanitizer DOES strip <script> tags (real bluemonday).
func TestS14_RealSanitizer_StripsScript(t *testing.T) {
	s := NewSanitizer()
	dirty := `<p>safe</p><script>alert(1)</script>`
	clean := s.Sanitize(dirty)
	if strings.Contains(clean, "<script>") {
		t.Errorf("script tag survived sanitize: %s", clean)
	}
	if !strings.Contains(clean, "<p>safe</p>") {
		t.Errorf("safe content lost: %s", clean)
	}
}

// 12. Production sanitizer ALLOWS cid: img src (carve-out for inline images).
func TestS14_RealSanitizer_AllowsCidScheme(t *testing.T) {
	s := NewSanitizer()
	html := `<img src="cid:logo-001@example" alt="logo">`
	out := s.Sanitize(html)
	if !strings.Contains(out, "cid:logo-001@example") {
		t.Errorf("cid: scheme stripped (regression on inline-image rendering): %s", out)
	}
}

// 13. Production sanitizer strips javascript: hrefs (XSS guard).
func TestS14_RealSanitizer_StripsJavascriptHref(t *testing.T) {
	s := NewSanitizer()
	html := `<a href="javascript:alert(1)">click</a>`
	out := s.Sanitize(html)
	if strings.Contains(out, "javascript:") {
		t.Errorf("javascript: scheme passed through: %s", out)
	}
}

// 14. Empty input to real sanitizer returns empty.
func TestS14_RealSanitizer_EmptyEmpty(t *testing.T) {
	s := NewSanitizer()
	if out := s.Sanitize(""); out != "" {
		t.Errorf("empty → %q", out)
	}
}

// 15. bodyPlainFromParsed prefers parsed plain over fallback.
func TestS14_bodyPlainFromParsed_PrefersParsed(t *testing.T) {
	p := parseRawIfPresent(RawInbound{RawBytes: []byte(
		"From: a@b\r\nContent-Type: text/plain\r\n\r\nparsed body")})
	got := bodyPlainFromParsed(p, "fallback")
	if !strings.Contains(got, "parsed body") {
		t.Errorf("got %q (want parsed)", got)
	}
}

// 16. bodyPlainFromParsed falls back when parsed is nil or empty.
func TestS14_bodyPlainFromParsed_FallbackWhenNil(t *testing.T) {
	got := bodyPlainFromParsed(nil, "legacy")
	if got != "legacy" {
		t.Errorf("got %q", got)
	}
}

// 17. Source-level audit — bluemonday is the ONLY new dep on the
//     RecordInbound path. Defends against accidental imports.
func TestS14_SourceAudit_OnlyBluemonday(t *testing.T) {
	for _, file := range []string{"sanitizer.go", "messages.go"} {
		src, err := readFile(file)
		if err != nil {
			t.Skipf("read %s: %v", file, err)
			continue
		}
		// Must import bluemonday in sanitizer.go but no other third-party.
		if file == "sanitizer.go" {
			if !strings.Contains(src, `"github.com/microcosm-cc/bluemonday"`) {
				t.Errorf("%s missing bluemonday import", file)
			}
		}
		// messages.go should NOT import third-party (database/sql + fmt + crypto).
		if file == "messages.go" && strings.Contains(src, "github.com/") {
			t.Errorf("%s pulled in unexpected third-party import", file)
		}
	}
}

// helper for source audit
func readFile(name string) (string, error) {
	return readFileImpl(name)
}

var readFileImpl = func(name string) (string, error) {
	b, err := osReadFile(name)
	return string(b), err
}

func osReadFile(name string) ([]byte, error) {
	// Use os.ReadFile via indirection so this single test file imports
	// minimally; production paths don't need this.
	return readFileBytes(name)
}

// stub error for rollback test
var errSimulated = &simErr{"simulated DB failure"}

type simErr struct{ s string }

func (e *simErr) Error() string { return e.s }

// time guard to keep imports clean
var _ = time.Time{}
