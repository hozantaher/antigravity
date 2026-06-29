package mailbox

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// mailboxCols returns the 25-column list matching mailboxColumns (migration 065 adds preferred_country, 071 adds lifecycle_phase).
func mailboxCols() []string {
	return []string{
		"id", "from_address", "display_name",
		"smtp_host", "smtp_port", "smtp_username",
		"imap_host", "imap_port", "imap_username",
		"daily_cap_override", "tz", "locale",
		"status", "status_reason",
		"last_send_at", "consecutive_bounces", "total_sent", "total_bounced",
		"created_at", "updated_at", "password", "proxy_url", "environment",
		"preferred_country", "lifecycle_phase",
	}
}

// aMailboxRow returns a minimal valid row for sqlmock.
func aMailboxRow(id int64, addr string) *sqlmock.Rows {
	now := time.Now()
	return sqlmock.NewRows(mailboxCols()).AddRow(
		id, addr, "Test Box",
		"smtp.test", 587, "",
		"", nil, "",
		nil, "Europe/Prague", "cs",
		"active", "",
		nil, 0, 0, 0,
		now, now, "", "", "production",
		"",          // preferred_country
		"warmup_d0", // lifecycle_phase
	)
}

// validTestMailbox returns the minimum Mailbox that passes Validate().
func validTestMailbox() Mailbox {
	return Mailbox{
		FromAddress: "test@example.com",
		DisplayName: "Test Box",
		SMTPHost:    "smtp.test",
		SMTPPort:    587,
		Status:      StatusActive,
		TZ:          "Europe/Prague",
		Locale:      "cs",
	}
}

// ---- Create ----

func TestPGStore_Create_ValidationError(t *testing.T) {
	s, _, done := newMockStore(t)
	defer done()
	_, err := s.Create(context.Background(), Mailbox{}) // missing required fields
	if err == nil {
		t.Fatal("expected validation error for empty mailbox")
	}
}

func TestPGStore_Create_DBNoRows_MapsNotFound(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows(mailboxCols())) // empty → sql.ErrNoRows
	_, err := s.Create(context.Background(), validTestMailbox())
	if err != ErrMailboxNotFound {
		t.Fatalf("expected ErrMailboxNotFound, got %v", err)
	}
}

func TestPGStore_Create_OK(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(aMailboxRow(7, "test@example.com"))
	m, err := s.Create(context.Background(), validTestMailbox())
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != 7 {
		t.Fatalf("expected ID=7, got %d", m.ID)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ---- Update ----

func TestPGStore_Update_ValidationError(t *testing.T) {
	s, _, done := newMockStore(t)
	defer done()
	_, err := s.Update(context.Background(), 1, Mailbox{})
	if err == nil {
		t.Fatal("expected validation error for empty mailbox")
	}
}

func TestPGStore_Update_NotFound(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectQuery(`UPDATE outreach_mailboxes SET`).
		WillReturnRows(sqlmock.NewRows(mailboxCols()))
	_, err := s.Update(context.Background(), 999, validTestMailbox())
	if err != ErrMailboxNotFound {
		t.Fatalf("expected ErrMailboxNotFound, got %v", err)
	}
}

func TestPGStore_Update_OK(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectQuery(`UPDATE outreach_mailboxes SET`).
		WillReturnRows(aMailboxRow(5, "test@example.com"))
	m, err := s.Update(context.Background(), 5, validTestMailbox())
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != 5 {
		t.Fatalf("expected ID=5, got %d", m.ID)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ---- Delete ----

func TestPGStore_Delete_OK(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectExec(`DELETE FROM outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if err := s.Delete(context.Background(), 42); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPGStore_Delete_NotFound(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectExec(`DELETE FROM outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	err := s.Delete(context.Background(), 999)
	if err != ErrMailboxNotFound {
		t.Fatalf("expected ErrMailboxNotFound, got %v", err)
	}
}

func TestPGStore_Delete_DBError(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectExec(`DELETE FROM outreach_mailboxes`).
		WillReturnError(sqlmock.ErrCancelled)
	err := s.Delete(context.Background(), 1)
	if err == nil {
		t.Fatal("expected error from DB")
	}
}

// ---- ResetBounce (71.4% → 100%) ----

func TestPGStore_ResetBounce_OK(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectExec(`UPDATE outreach_mailboxes SET consecutive_bounces`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	if err := s.ResetBounce(context.Background(), 3); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPGStore_ResetBounce_DBError(t *testing.T) {
	s, mock, done := newMockStore(t)
	defer done()
	mock.ExpectExec(`UPDATE outreach_mailboxes SET consecutive_bounces`).
		WillReturnError(sqlmock.ErrCancelled)
	if err := s.ResetBounce(context.Background(), 1); err == nil {
		t.Fatal("expected DB error")
	}
}
