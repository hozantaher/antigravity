package mailbox

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// aFullMailboxRow returns a row with all nullable fields populated:
// daily_cap_override=50, imap_port=993, last_send_at=now.
func aFullMailboxRow(id int64, addr string) *sqlmock.Rows {
	now := time.Now()
	cap := int64(50)
	port := int64(993)
	return sqlmock.NewRows(mailboxCols()).AddRow(
		id, addr, "Test Box",
		"smtp.test", 587, "smtpuser",
		"imap.test", port, "imapuser",
		cap, "Europe/Prague", "cs",
		"active", "",
		now, 3, 10, 2,
		now, now, "secret", "", "production",
		"",          // preferred_country
		"warmup_d0", // lifecycle_phase
	)
}

// mailboxWithIMAP returns a fully populated Mailbox that passes Validate()
// and has non-empty IMAP credentials (triggers the nullable-arg branches in
// UpsertFromConfig, Create, and Update).
func mailboxWithIMAP() Mailbox {
	return Mailbox{
		FromAddress:  "test@example.com",
		DisplayName:  "Test Box",
		SMTPHost:     "smtp.test",
		SMTPPort:     587,
		SMTPUsername: "smtp",
		IMAPHost:     "imap.test",
		IMAPUsername: "user",
		IMAPPort:     993,
		Status:       StatusActive,
		TZ:           "Europe/Prague",
		Locale:       "cs",
	}
}

// ── TestScanMailbox_AllNullableFieldsPopulated ────────────────────────────────
// Exercises scanMailbox branches: dailyCap.Valid, imapPort.Valid, lastSendAt.Valid

func TestScanMailbox_AllNullableFieldsPopulated(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(aFullMailboxRow(1, "test@example.com"))

	m, err := s.UpsertFromConfig(context.Background(), mailboxWithIMAP())
	if err != nil {
		t.Fatalf("UpsertFromConfig: %v", err)
	}

	if m.DailyCapOverride == nil {
		t.Fatal("DailyCapOverride should not be nil")
	}
	if *m.DailyCapOverride != 50 {
		t.Errorf("DailyCapOverride = %d, want 50", *m.DailyCapOverride)
	}
	if m.IMAPPort != 993 {
		t.Errorf("IMAPPort = %d, want 993", m.IMAPPort)
	}
	if m.LastSendAt == nil {
		t.Error("LastSendAt should not be nil")
	}
}

// ── TestPGStore_UpsertFromConfig_WithIMAPCredentials ─────────────────────────
// Verifies that IMAPHost, IMAPUsername, IMAPPort, and SMTPUsername are passed
// as non-nil values (covering the `if m.IMAPHost != ""` branches).

func TestPGStore_UpsertFromConfig_WithIMAPCredentials(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(aFullMailboxRow(1, "test@example.com"))

	m, err := s.UpsertFromConfig(context.Background(), mailboxWithIMAP())
	if err != nil {
		t.Fatalf("UpsertFromConfig: %v", err)
	}
	if m.IMAPPort != 993 {
		t.Errorf("IMAPPort = %d, want 993", m.IMAPPort)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ── TestPGStore_Create_WithIMAPCredentials ────────────────────────────────────
// Covers the same nullable-arg branches in Create.

func TestPGStore_Create_WithIMAPCredentials(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(aFullMailboxRow(1, "test@example.com"))

	m, err := s.Create(context.Background(), mailboxWithIMAP())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if m.IMAPPort != 993 {
		t.Errorf("IMAPPort = %d, want 993", m.IMAPPort)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ── TestPGStore_Update_WithIMAPCredentials ────────────────────────────────────
// Covers the same nullable-arg branches in Update.

func TestPGStore_Update_WithIMAPCredentials(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()

	mock.ExpectQuery(`UPDATE outreach_mailboxes SET`).
		WillReturnRows(aFullMailboxRow(5, "test@example.com"))

	m, err := s.Update(context.Background(), 5, mailboxWithIMAP())
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if m.IMAPPort != 993 {
		t.Errorf("IMAPPort = %d, want 993", m.IMAPPort)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}
