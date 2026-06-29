package inbox

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/textproto"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

type fakeSessionFactory struct {
	session imapSession
	err     error
}

type staticAttachmentPolicy struct {
	action string
	reason string
}

func defaultAttachmentPolicyForTest() DefaultAttachmentPolicy {
	return DefaultAttachmentPolicy{
		MaxBytes: defaultAttachmentMaxBytes,
		BlockedContentTypes: map[string]struct{}{
			"application/x-msdownload": {},
			"application/x-dosexec":    {},
			"application/x-sh":         {},
			"application/x-executable": {},
			"application/java-archive": {},
			"text/x-shellscript":       {},
		},
	}
}

type fakeSession struct {
	uids         []string
	messages     map[string][]byte
	fetchedUIDs  []string
	loginCalled  bool
	selectBox    string
	logoutCalled bool
}

func (f fakeSessionFactory) New(context.Context, IMAPSyncConfig) (imapSession, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.session, nil
}

func (p staticAttachmentPolicy) Apply(attachment model.InboxAttachment) model.InboxAttachment {
	attachment.PolicyAction = p.action
	attachment.PolicyReason = p.reason
	return attachment
}

func (f *fakeSession) Login(string, string) error       { f.loginCalled = true; return nil }
func (f *fakeSession) Select(mailbox string) error      { f.selectBox = mailbox; return nil }
func (f *fakeSession) SearchAllUIDs() ([]string, error) { return append([]string(nil), f.uids...), nil }
func (f *fakeSession) FetchMessageByUID(uid string) ([]byte, error) {
	f.fetchedUIDs = append(f.fetchedUIDs, uid)
	return f.messages[uid], nil
}
func (f *fakeSession) Logout() error { f.logoutCalled = true; return nil }
func (f *fakeSession) Close() error  { return nil }

func TestNewIMAPSyncerRejectsMissingConfig(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	if _, err := NewIMAPSyncer(IMAPSyncConfig{}, store, cursors); err != ErrIMAPNotConfigured {
		t.Fatalf("expected ErrIMAPNotConfigured, got %v", err)
	}
}

func TestNewIMAPSyncerRejectsPartialConfig(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	if _, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "imap-user",
	}, store, cursors); err != ErrIMAPIncompleteConfig {
		t.Fatalf("expected ErrIMAPIncompleteConfig, got %v", err)
	}
}

func TestNewIMAPSyncerRejectsMissingStore(t *testing.T) {
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	if _, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "imap-user",
		Password: "imap-pass",
	}, nil, cursors); err == nil {
		t.Fatal("expected missing store error")
	}
}

func TestNewIMAPSyncerRejectsMissingCursorStore(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	if _, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "imap-user",
		Password: "imap-pass",
	}, store, nil); err == nil {
		t.Fatal("expected missing cursor store error")
	}
}

func TestIMAPSyncerSyncFetchesAndStoresMessages(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	syncer, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "imap-user",
		Password: "imap-pass",
	}, store, cursors)
	if err != nil {
		t.Fatalf("NewIMAPSyncer() error = %v", err)
	}

	session := &fakeSession{
		uids: []string{"1", "2"},
		messages: map[string][]byte{
			"1": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Hello\r\nDate: Fri, 03 Apr 2026 10:00:00 +0000\r\n\r\nFirst body"),
			"2": []byte("From: another@example.com\r\nTo: ops@relay.example\r\nSubject: Second\r\nDate: Fri, 03 Apr 2026 11:00:00 +0000\r\n\r\nSecond body"),
		},
	}
	syncer.sessions = fakeSessionFactory{session: session}

	count, err := syncer.Sync(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"})
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 synced messages, got %d", count)
	}
	if !session.loginCalled {
		t.Fatal("expected login to be called")
	}
	if session.selectBox != "INBOX" {
		t.Fatalf("expected default mailbox INBOX, got %s", session.selectBox)
	}
	if !session.logoutCalled {
		t.Fatal("expected logout to be called")
	}

	messages, err := store.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected 2 stored messages, got %d", len(messages))
	}
	if messages[0].ProviderUID != "2" {
		t.Fatalf("expected most recent message first, got UID %s", messages[0].ProviderUID)
	}
	cursor, err := cursors.Load(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cursor != "2" {
		t.Fatalf("expected cursor 2, got %q", cursor)
	}
}

func TestIMAPSyncerSyncInitialBackfillRespectsFetchLimit(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	syncer, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:       "imap.example.com",
		Username:   "imap-user",
		Password:   "imap-pass",
		FetchLimit: 1,
	}, store, cursors)
	if err != nil {
		t.Fatalf("NewIMAPSyncer() error = %v", err)
	}

	session := &fakeSession{
		uids: []string{"1", "2"},
		messages: map[string][]byte{
			"1": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Hello\r\nDate: Fri, 03 Apr 2026 10:00:00 +0000\r\n\r\nFirst body"),
			"2": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Hello again\r\nDate: Fri, 03 Apr 2026 12:00:00 +0000\r\n\r\nSecond body"),
		},
	}
	syncer.sessions = fakeSessionFactory{session: session}

	if _, err := syncer.Sync(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}); err != nil {
		t.Fatalf("Sync() error = %v", err)
	}

	messages, err := store.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 deduplicated message, got %d", len(messages))
	}
	if messages[0].ProviderUID != "2" {
		t.Fatalf("expected only newest UID 2 due to fetch limit, got %s", messages[0].ProviderUID)
	}
	if len(session.fetchedUIDs) != 1 || session.fetchedUIDs[0] != "2" {
		t.Fatalf("expected only UID 2 fetched, got %+v", session.fetchedUIDs)
	}
}

func TestIMAPSyncerSyncUsesCursorForIncrementalFetch(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursorPath := filepath.Join(t.TempDir(), "imap-sync-state.json")
	cursors, err := NewCursorStore(cursorPath)
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	if err := cursors.Save(context.Background(), actor, "2"); err != nil {
		t.Fatalf("preload cursor Save() error = %v", err)
	}

	syncer, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:       "imap.example.com",
		Username:   "imap-user",
		Password:   "imap-pass",
		FetchLimit: 2,
	}, store, cursors)
	if err != nil {
		t.Fatalf("NewIMAPSyncer() error = %v", err)
	}

	session := &fakeSession{
		uids: []string{"1", "2", "3", "4", "5"},
		messages: map[string][]byte{
			"3": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Three\r\nDate: Fri, 03 Apr 2026 13:00:00 +0000\r\n\r\nThird body"),
			"4": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Four\r\nDate: Fri, 03 Apr 2026 14:00:00 +0000\r\n\r\nFourth body"),
			"5": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Five\r\nDate: Fri, 03 Apr 2026 15:00:00 +0000\r\n\r\nFifth body"),
		},
	}
	syncer.sessions = fakeSessionFactory{session: session}

	count, err := syncer.Sync(context.Background(), actor)
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 synced messages, got %d", count)
	}
	if got := strings.Join(session.fetchedUIDs, ","); got != "3,4" {
		t.Fatalf("expected incremental fetch of 3,4 got %s", got)
	}

	reloadedCursors, err := NewCursorStore(cursorPath)
	if err != nil {
		t.Fatalf("reloaded NewCursorStore() error = %v", err)
	}
	cursor, err := reloadedCursors.Load(context.Background(), actor)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cursor != "4" {
		t.Fatalf("expected cursor to advance to 4, got %q", cursor)
	}
}

func TestIMAPSyncerPropagatesSessionFactoryError(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}

	syncer, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "imap-user",
		Password: "imap-pass",
	}, store, cursors)
	if err != nil {
		t.Fatalf("NewIMAPSyncer() error = %v", err)
	}
	syncer.sessions = fakeSessionFactory{err: errors.New("dial failed")}

	if _, err := syncer.Sync(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"}); err == nil {
		t.Fatal("expected session factory error")
	}
}

func TestParseIMAPMessageFallsBackToActorPrimaryEmail(t *testing.T) {
	msg, err := parseIMAPMessage(model.Actor{
		ID:           "user-1",
		TenantID:     "tenant-1",
		PrimaryEmail: "user@example.com",
	}, "99", []byte("From: sender@example.com\r\nSubject: Hello\r\n\r\nBody"), nil)
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.AliasEmail != "user@example.com" {
		t.Fatalf("expected primary email fallback, got %s", msg.AliasEmail)
	}
	if msg.ProviderUID != "99" {
		t.Fatalf("expected provider UID 99, got %s", msg.ProviderUID)
	}
}

func TestParseIMAPMessagePrefersPlainTextFromMultipartAlternative(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: Hello multipart",
		`Content-Type: multipart/alternative; boundary="b1"`,
		"",
		"--b1",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Plain body",
		"",
		"--b1",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<html><body><p>HTML body</p></body></html>",
		"--b1--",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "100", []byte(raw), nil)
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.TextBody != "Plain body" {
		t.Fatalf("expected plain body, got %q", msg.TextBody)
	}
}

func TestParseIMAPMessageFallsBackToHTMLTextExtraction(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: HTML only",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<html><body><h1>Hello</h1><p>World</p></body></html>",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "101", []byte(raw), nil)
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.TextBody != "Hello World" {
		t.Fatalf("expected stripped HTML text, got %q", msg.TextBody)
	}
}

func TestParseIMAPMessageDecodesQuotedPrintableBody(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: Encoded",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"Hello=20world=21",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "102", []byte(raw), nil)
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.TextBody != "Hello world!" {
		t.Fatalf("expected decoded quoted-printable body, got %q", msg.TextBody)
	}
}

func TestParseIMAPMessageDecodesBase64Body(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: Encoded b64",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		"SGVsbG8gZnJvbSBiYXNlNjQh",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "103", []byte(raw), nil)
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.TextBody != "Hello from base64!" {
		t.Fatalf("expected decoded base64 body, got %q", msg.TextBody)
	}
}

func TestParseIMAPMessageCapturesAttachmentMetadata(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: With attachment",
		`Content-Type: multipart/mixed; boundary="mix1"`,
		"",
		"--mix1",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Plain body",
		"",
		"--mix1",
		`Content-Type: application/pdf; name="invoice.pdf"`,
		`Content-Disposition: attachment; filename="invoice.pdf"`,
		"Content-Transfer-Encoding: base64",
		"",
		"UERGREFUQQ==",
		"",
		"--mix1--",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "104", []byte(raw), defaultAttachmentPolicyForTest())
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.TextBody != "Plain body" {
		t.Fatalf("expected plain body, got %q", msg.TextBody)
	}
	if msg.AttachmentCount != 1 {
		t.Fatalf("expected 1 attachment, got %d", msg.AttachmentCount)
	}
	if len(msg.Attachments) != 1 {
		t.Fatalf("expected 1 attachment metadata entry, got %d", len(msg.Attachments))
	}
	attachment := msg.Attachments[0]
	if attachment.Filename != "invoice.pdf" {
		t.Fatalf("expected invoice.pdf filename, got %q", attachment.Filename)
	}
	if attachment.ContentType != "application/pdf" {
		t.Fatalf("expected application/pdf content type, got %q", attachment.ContentType)
	}
	if attachment.Disposition != "attachment" {
		t.Fatalf("expected attachment disposition, got %q", attachment.Disposition)
	}
	if attachment.SizeBytes == 0 {
		t.Fatal("expected non-zero attachment size")
	}
	if attachment.PolicyAction != "allowed_metadata" {
		t.Fatalf("expected allowed_metadata action, got %q", attachment.PolicyAction)
	}
}

func TestParseIMAPMessageCapturesNestedMultipartAttachments(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: Nested attachment",
		`Content-Type: multipart/mixed; boundary="outer"`,
		"",
		"--outer",
		`Content-Type: multipart/alternative; boundary="inner"`,
		"",
		"--inner",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>Hello <b>world</b></p>",
		"",
		"--inner--",
		"",
		"--outer",
		"Content-Type: image/png",
		"Content-Disposition: inline; filename=\"preview.png\"",
		"",
		"PNGDATA",
		"",
		"--outer--",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "105", []byte(raw), defaultAttachmentPolicyForTest())
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.TextBody != "Hello world" {
		t.Fatalf("expected HTML fallback text, got %q", msg.TextBody)
	}
	if msg.AttachmentCount != 1 || len(msg.Attachments) != 1 {
		t.Fatalf("expected one nested attachment, got count=%d len=%d", msg.AttachmentCount, len(msg.Attachments))
	}
	if msg.Attachments[0].Filename != "preview.png" {
		t.Fatalf("expected preview.png filename, got %q", msg.Attachments[0].Filename)
	}
}

func TestParseIMAPMessageBlocksHighRiskAttachments(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: Blocked attachment",
		`Content-Type: multipart/mixed; boundary="mix2"`,
		"",
		"--mix2",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Plain body",
		"",
		"--mix2",
		`Content-Type: application/x-msdownload; name="run.exe"`,
		`Content-Disposition: attachment; filename="run.exe"`,
		"",
		"BINARY",
		"",
		"--mix2--",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(model.Actor{ID: "user-1", TenantID: "tenant-1"}, "106", []byte(raw), defaultAttachmentPolicyForTest())
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.AttachmentCount != 1 {
		t.Fatalf("expected 1 attachment, got %d", msg.AttachmentCount)
	}
	if msg.Attachments[0].PolicyAction != "blocked" {
		t.Fatalf("expected blocked action, got %q", msg.Attachments[0].PolicyAction)
	}
}

func TestParseIMAPMessageUsesCustomAttachmentPolicy(t *testing.T) {
	raw := strings.Join([]string{
		"From: sender@example.com",
		"To: support@relay.example",
		"Subject: Custom policy",
		`Content-Type: multipart/mixed; boundary="mix3"`,
		"",
		"--mix3",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Plain body",
		"",
		"--mix3",
		`Content-Type: application/pdf; name="doc.pdf"`,
		`Content-Disposition: attachment; filename="doc.pdf"`,
		"",
		"PDFDATA",
		"",
		"--mix3--",
		"",
	}, "\r\n")

	msg, err := parseIMAPMessage(
		model.Actor{ID: "user-1", TenantID: "tenant-1"},
		"107",
		[]byte(raw),
		staticAttachmentPolicy{action: "logged_only", reason: "custom test policy"},
	)
	if err != nil {
		t.Fatalf("parseIMAPMessage() error = %v", err)
	}
	if msg.Attachments[0].PolicyAction != "logged_only" {
		t.Fatalf("expected logged_only action, got %q", msg.Attachments[0].PolicyAction)
	}
	if msg.Attachments[0].PolicyReason != "custom test policy" {
		t.Fatalf("expected custom policy reason, got %q", msg.Attachments[0].PolicyReason)
	}
}

func TestIMAPHelpers(t *testing.T) {
	if got := imapTag(12); got != "A12" {
		t.Fatalf("expected A12, got %s", got)
	}
	if got := parseLiteralSize("* 1 FETCH (BODY[] {42}"); got != 42 {
		t.Fatalf("expected literal size 42, got %d", got)
	}
	if got := parseLiteralSize("* 1 FETCH BODY[]"); got != 0 {
		t.Fatalf("expected literal size 0, got %d", got)
	}
	if got := quoteIMAP(`a"b\c`); got != `"a\"b\\c"` {
		t.Fatalf("unexpected quoted IMAP string %s", got)
	}
	if got := strings.Join(selectSyncUIDs([]string{"1", "2", "3", "4"}, "", 2), ","); got != "3,4" {
		t.Fatalf("expected initial tail selection 3,4 got %s", got)
	}
	if got := strings.Join(selectSyncUIDs([]string{"1", "2", "3", "4", "5"}, "2", 2), ","); got != "3,4" {
		t.Fatalf("expected cursor selection 3,4 got %s", got)
	}
	if got := strings.Join(filterUIDsAfterCursor([]string{"x", "2", "3"}, "2"), ","); got != "3" {
		t.Fatalf("expected filtered UID 3, got %s", got)
	}
	if got := strings.Join(filterUIDsAfterCursor([]string{"1", "2"}, "bad"), ","); got != "1,2" {
		t.Fatalf("expected fallback to all UIDs, got %s", got)
	}
	if got := normalizeExtractedText("a\r\n\r\n\r\nb\r\n"); got != "a\n\nb" {
		t.Fatalf("expected normalized text, got %q", got)
	}
	if got := stripHTML("<p>Hello</p><div>World &amp; more</div>"); got != "Hello World & more " {
		t.Fatalf("expected stripped HTML, got %q", got)
	}
	if !isAttachmentPart("application/pdf", "attachment", "a.pdf") {
		t.Fatal("expected application/pdf attachment to be classified as attachment")
	}
	if isAttachmentPart("text/plain", "", "") {
		t.Fatal("expected plain text body not to be classified as attachment")
	}
	policy := DefaultAttachmentPolicy{
		MaxBytes: defaultAttachmentMaxBytes,
		BlockedContentTypes: map[string]struct{}{
			"application/x-msdownload": {},
		},
	}
	blocked := policy.Apply(model.InboxAttachment{ContentType: "application/x-msdownload", SizeBytes: 128})
	if blocked.PolicyAction != "blocked" {
		t.Fatalf("expected blocked policy action, got %q", blocked.PolicyAction)
	}
	oversized := policy.Apply(model.InboxAttachment{ContentType: "application/pdf", SizeBytes: defaultAttachmentMaxBytes + 1})
	if oversized.PolicyAction != "blocked" {
		t.Fatalf("expected oversized attachment to be blocked, got %q", oversized.PolicyAction)
	}
	allowed := policy.Apply(model.InboxAttachment{ContentType: "application/pdf", SizeBytes: 256})
	if allowed.PolicyAction != "allowed_metadata" {
		t.Fatalf("expected pdf attachment to be allowed_metadata, got %q", allowed.PolicyAction)
	}
}

func TestNetIMAPSessionCommandLifecycle(t *testing.T) {
	session, conn := newScriptedSession(
		"A0 OK LOGIN completed\r\n" +
			"* 1 EXISTS\r\n" +
			"A1 OK [READ-WRITE] SELECT completed\r\n" +
			"* BYE\r\n" +
			"A2 OK LOGOUT completed\r\n",
	)

	if err := session.Login("user", "pass"); err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if err := session.Select("INBOX"); err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if err := session.Logout(); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	writes := conn.Writes()
	if !strings.Contains(writes, "A0 LOGIN \"user\" \"pass\"\r\n") {
		t.Fatalf("unexpected login command stream %q", writes)
	}
	if !strings.Contains(writes, "A1 SELECT \"INBOX\"\r\n") {
		t.Fatalf("unexpected select command stream %q", writes)
	}
	if !strings.Contains(writes, "A2 LOGOUT\r\n") {
		t.Fatalf("unexpected logout command stream %q", writes)
	}
	if !conn.closed {
		t.Fatal("expected connection close to be called")
	}
}

func TestNetIMAPSessionSearchAndFetch(t *testing.T) {
	session, conn := newScriptedSession(
		"* SEARCH 10 11 12\r\n" +
			"A0 OK SEARCH completed\r\n" +
			"* 12 FETCH (BODY[] {55}\r\n" +
			"From: sender@example.com\r\nSubject: Hello\r\n\r\nBody text\r\n" +
			")\r\n" +
			"A1 OK FETCH completed\r\n",
	)

	uids, err := session.SearchAllUIDs()
	if err != nil {
		t.Fatalf("SearchAllUIDs() error = %v", err)
	}
	if len(uids) != 3 || uids[2] != "12" {
		t.Fatalf("unexpected UIDs %+v", uids)
	}

	raw, err := session.FetchMessageByUID("12")
	if err != nil {
		t.Fatalf("FetchMessageByUID() error = %v", err)
	}
	if !strings.Contains(string(raw), "Subject: Hello") {
		t.Fatalf("expected fetched message content, got %q", string(raw))
	}

	writes := conn.Writes()
	if !strings.Contains(writes, "A0 UID SEARCH ALL\r\n") {
		t.Fatalf("unexpected search command stream %q", writes)
	}
	if !strings.Contains(writes, "A1 UID FETCH 12 BODY.PEEK[]\r\n") {
		t.Fatalf("unexpected fetch command stream %q", writes)
	}
}

func newScriptedSession(serverStream string) (*netIMAPSession, *scriptedConn) {
	conn := &scriptedConn{reader: bytes.NewReader([]byte(serverStream))}
	return &netIMAPSession{conn: textproto.NewConn(conn)}, conn
}

type scriptedConn struct {
	reader *bytes.Reader
	writes bytes.Buffer
	closed bool
}

func (c *scriptedConn) Read(p []byte) (int, error)       { return c.reader.Read(p) }
func (c *scriptedConn) Write(p []byte) (int, error)      { return c.writes.Write(p) }
func (c *scriptedConn) Close() error                     { c.closed = true; return nil }
func (c *scriptedConn) LocalAddr() net.Addr              { return stubAddr("local") }
func (c *scriptedConn) RemoteAddr() net.Addr             { return stubAddr("remote") }
func (c *scriptedConn) SetDeadline(time.Time) error      { return nil }
func (c *scriptedConn) SetReadDeadline(time.Time) error  { return nil }
func (c *scriptedConn) SetWriteDeadline(time.Time) error { return nil }
func (c *scriptedConn) Writes() string                   { return c.writes.String() }

type stubAddr string

func (a stubAddr) Network() string { return "scripted" }
func (a stubAddr) String() string  { return string(a) }
