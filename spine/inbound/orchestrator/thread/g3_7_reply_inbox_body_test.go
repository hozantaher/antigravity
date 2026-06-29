package thread

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"orchestrator/mime"
)

// fakeHeader implements the interface expected by replyInboxHeadersJSON.
type fakeHeader map[string]string

func (f fakeHeader) Get(key string) string { return f[key] }

// ── replyInboxAttachmentsMeta ─────────────────────────────────────────────────

func TestReplyInboxAttachmentsMeta_Single(t *testing.T) {
	atts := []mime.Attachment{
		{Filename: "contract.pdf", ContentType: "application/pdf", Data: make([]byte, 1024)},
	}
	raw := replyInboxAttachmentsMeta(atts)
	if raw == nil {
		t.Fatal("expected non-nil JSON, got nil")
	}
	var out []map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("attachments_meta is not valid JSON: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 attachment entry, got %d", len(out))
	}
	entry := out[0]
	if entry["filename"] != "contract.pdf" {
		t.Errorf("filename = %v, want contract.pdf", entry["filename"])
	}
	if entry["content_type"] != "application/pdf" {
		t.Errorf("content_type = %v, want application/pdf", entry["content_type"])
	}
	if entry["size_bytes"].(float64) != 1024 {
		t.Errorf("size_bytes = %v, want 1024", entry["size_bytes"])
	}
	// Verify raw binary data is NOT stored.
	raw2, _ := json.Marshal(out)
	if strings.Contains(string(raw2), "data") {
		t.Error("attachments_meta must not contain raw attachment data")
	}
}

func TestReplyInboxAttachmentsMeta_MultipleAttachments(t *testing.T) {
	atts := []mime.Attachment{
		{Filename: "a.pdf", ContentType: "application/pdf", Data: make([]byte, 512)},
		{Filename: "photo.jpg", ContentType: "image/jpeg", Data: make([]byte, 8192)},
	}
	raw := replyInboxAttachmentsMeta(atts)
	var out []map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(out))
	}
}

func TestReplyInboxAttachmentsMeta_Empty(t *testing.T) {
	if got := replyInboxAttachmentsMeta(nil); got != nil {
		t.Errorf("nil input should return nil, got %v", got)
	}
	if got := replyInboxAttachmentsMeta([]mime.Attachment{}); got != nil {
		t.Errorf("empty input should return nil, got %v", got)
	}
}

// ── replyInboxHeadersJSON ─────────────────────────────────────────────────────

func TestReplyInboxHeadersJSON_ExpectedFields(t *testing.T) {
	h := fakeHeader{
		"Message-Id":   "<abc123@seznam.cz>",
		"In-Reply-To":  "<orig@seznam.cz>",
		"References":   "<orig@seznam.cz>",
		"Date":         "Thu, 29 May 2026 10:00:00 +0200",
		"Content-Type": "text/plain; charset=utf-8",
	}
	// Build a RawInbound with a fake Received-SPF pass header + DKIM-Signature.
	raw := RawInbound{
		RawBytes: []byte("Received-SPF: pass (seznam.cz)\r\nDKIM-Signature: v=1; a=rsa-sha256\r\n\r\nbody"),
	}
	b := replyInboxHeadersJSON(h, raw)
	if b == nil {
		t.Fatal("expected non-nil JSON")
	}
	var out map[string]interface{}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("headers_json is not valid JSON: %v", err)
	}

	// Required scalar fields.
	for _, key := range []string{"message_id", "in_reply_to", "references", "date", "content_type"} {
		if _, ok := out[key]; !ok {
			t.Errorf("headers_json missing expected key %q", key)
		}
	}
	// Auth flags must be boolean, not raw values.
	if spfPass, ok := out["spf_pass"].(bool); !ok || !spfPass {
		t.Errorf("spf_pass should be true bool, got %v (%T)", out["spf_pass"], out["spf_pass"])
	}
	if dkimPresent, ok := out["dkim_present"].(bool); !ok || !dkimPresent {
		t.Errorf("dkim_present should be true bool, got %v (%T)", out["dkim_present"], out["dkim_present"])
	}
}

func TestReplyInboxHeadersJSON_NoRawIPs(t *testing.T) {
	h := fakeHeader{}
	// Simulate a Received header containing an IP address.
	raw := RawInbound{
		RawBytes: []byte(
			"Received: from mail.attacker.com ([192.0.2.1]) by mx.seznam.cz\r\n" +
				"Received-SPF: fail\r\n\r\nbody",
		),
	}
	b := replyInboxHeadersJSON(h, raw)
	if b == nil {
		t.Fatal("expected non-nil JSON")
	}
	content := string(b)
	// IP address must not appear in headers_json.
	if strings.Contains(content, "192.0.2.1") {
		t.Errorf("headers_json must not contain raw IP addresses, but found 192.0.2.1 in: %s", content)
	}
	// Full Received chain must not appear.
	if strings.Contains(content, "Received") {
		t.Errorf("headers_json must not include Received header chain, found in: %s", content)
	}
}

func TestReplyInboxHeadersJSON_SPFFailFlagFalse(t *testing.T) {
	h := fakeHeader{}
	raw := RawInbound{
		RawBytes: []byte("Received-SPF: fail (no SPF record)\r\n\r\nbody"),
	}
	b := replyInboxHeadersJSON(h, raw)
	var out map[string]interface{}
	_ = json.Unmarshal(b, &out)
	if spfPass, _ := out["spf_pass"].(bool); spfPass {
		t.Error("spf_pass should be false for SPF fail")
	}
	if dkimPresent, _ := out["dkim_present"].(bool); dkimPresent {
		t.Error("dkim_present should be false when no DKIM-Signature header")
	}
}

// ── insertReplyInbox (sqlmock integration) ────────────────────────────────────

func makeTestInboundProcessor(t *testing.T) (*InboundProcessor, sqlmock.Sqlmock) {
	t.Helper()
	db, mock := newMockDB(t)
	return &InboundProcessor{db: db}, mock
}

func TestInsertReplyInbox_WithBody(t *testing.T) {
	p, mock := makeTestInboundProcessor(t)

	rb := replyInboxMatch{
		ContactID:   42,
		CampaignID:  7,
		MailboxID:   3,
		SendEventID: 99,
		FromEmail:   "lead@firma.cz",
	}
	raw := RawInbound{
		Subject:    "Re: Poptávka",
		ReceivedAt: time.Now().UTC(),
		BodyPlain:  "Ano, mám zájem.",
	}
	parsed := &mime.ParsedMessage{
		BodyPlain: "Ano, mám zájem.",
		BodyHTML:  "<p>Ano, mám zájem.</p>",
	}

	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := p.insertReplyInbox(ctx, raw, rb, parsed); err != nil {
		t.Fatalf("insertReplyInbox returned error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations not met: %v", err)
	}
}

func TestInsertReplyInbox_WithAttachments(t *testing.T) {
	p, mock := makeTestInboundProcessor(t)

	rb := replyInboxMatch{ContactID: 10, CampaignID: 1, MailboxID: 1, SendEventID: 1}
	raw := RawInbound{Subject: "Smlouva", ReceivedAt: time.Now().UTC()}
	parsed := &mime.ParsedMessage{
		BodyPlain: "V příloze smlouva.",
		Attachments: []mime.Attachment{
			{Filename: "smlouva.pdf", ContentType: "application/pdf", Data: make([]byte, 2048)},
		},
	}

	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := p.insertReplyInbox(ctx, raw, rb, parsed); err != nil {
		t.Fatalf("insertReplyInbox: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations: %v", err)
	}
}

func TestInsertReplyInbox_NilParsed_GracefulNullBody(t *testing.T) {
	// When parsed is nil (legacy two-literal fetch), body columns should be
	// omitted (NULL) without error.
	p, mock := makeTestInboundProcessor(t)

	rb := replyInboxMatch{ContactID: 5, CampaignID: 2}
	raw := RawInbound{Subject: "Legacy reply", ReceivedAt: time.Now().UTC()}

	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := p.insertReplyInbox(ctx, raw, rb, nil); err != nil {
		t.Fatalf("insertReplyInbox with nil parsed: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations: %v", err)
	}
}

// TestInsertReplyInbox_DedupKeyedOnMessageID locks in the FIX 3 idempotency
// key: when the inbound carries a real Message-ID and headers_json is written
// (parsed != nil), the INSERT's dedup parameter ($12) is the cleaned
// (bracket-stripped) Message-ID — NOT the unstable received_at. This keeps a
// re-poll / watermark reset from duplicating the reply.
func TestInsertReplyInbox_DedupKeyedOnMessageID(t *testing.T) {
	p, mock := makeTestInboundProcessor(t)

	rb := replyInboxMatch{ContactID: 42, CampaignID: 7, MailboxID: 3, FromEmail: "lead@firma.cz"}
	raw := RawInbound{
		MessageID:  "<abc.123@firma.cz>",
		Subject:    "Re: Poptávka",
		ReceivedAt: time.Now().UTC(),
		BodyPlain:  "Ano.",
		RawBytes:   []byte("Message-Id: <abc.123@firma.cz>\r\n\r\nAno."),
	}
	parsed := &mime.ParsedMessage{BodyPlain: "Ano."}

	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WithArgs(
			int64(7),           // $1 campaign_id
			int64(42),          // $2 contact_id
			int64(3),           // $3 mailbox_id
			nil,                // $4 send_event_id
			"lead@firma.cz",    // $5 from_email
			"Re: Poptávka",     // $6 subject
			sqlmock.AnyArg(),   // $7 received_at
			sqlmock.AnyArg(),   // $8 body_text
			nil,                // $9 body_html (empty)
			nil,                // $10 attachments_meta (none)
			sqlmock.AnyArg(),   // $11 headers_json (parsed != nil)
			"abc.123@firma.cz", // $12 dedup message-id (brackets stripped)
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := p.insertReplyInbox(ctx, raw, rb, parsed); err != nil {
		t.Fatalf("insertReplyInbox: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations: %v", err)
	}
}
