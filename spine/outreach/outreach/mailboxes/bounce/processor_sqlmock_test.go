package bounce

import (
	"database/sql"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// bounceDB implements the bounce.DB interface wrapping *sql.DB
type bounceDB struct {
	db *sql.DB
}

func (b *bounceDB) QueryRow(query string, args ...any) *sql.Row {
	return b.db.QueryRow(query, args...)
}

func (b *bounceDB) Exec(query string, args ...any) (sql.Result, error) {
	return b.db.Exec(query, args...)
}

func newBounceDB(t *testing.T) (*bounceDB, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	return &bounceDB{db: db}, mock, func() { db.Close() }
}

// ── Process via sqlmock ──

func TestProcess_HardBounce(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	// Find send event
	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(100, 42, "user@firma.cz", "jan@sender.test"))

	// Insert bounce event
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Update send event status
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Hard bounce: update contacts
	mock.ExpectExec(`UPDATE contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Hard bounce: insert blacklist
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Hard bounce: feed back to companies email_status
	mock.ExpectExec(`UPDATE companies SET email_status = 'invalid'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// G17 cascade: mark outreach thread as error
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	err := p.Process(Event{
		OriginalMessageID: "msg@id",
		Type:              BounceHard,
		Code:              "550",
		Reason:            "user unknown",
		RawMessage:        "raw",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

func TestProcess_SoftBounce_BelowThreshold(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(200, 55, "test@example.cz", "jan@sender.test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// G17: count prior soft bounces — 1 (below threshold of 2)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	// No thread pause — still below threshold

	p := NewProcessor(bdb)
	err := p.Process(Event{
		OriginalMessageID: "msg2@id",
		Type:              BounceSoft,
		Code:              "421",
		Reason:            "try again later",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

func TestProcess_SoftBounce_PausesThreadAtThreshold(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(201, 56, "repeat@example.cz", "jan@sender.test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// G17: count prior soft bounces — 2 (at threshold)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	// G17 cascade: pause outreach thread for 7 days
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	err := p.Process(Event{
		OriginalMessageID: "msg3@id",
		Type:              BounceSoft,
		Code:              "421",
		Reason:            "temporarily unavailable",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

// Keep the original name as an alias so nothing referencing the old name breaks.
func TestProcess_SoftBounce(t *testing.T) {
	TestProcess_SoftBounce_BelowThreshold(t)
}

func TestProcess_ComplaintBounce(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(300, 77, "spam@firma.cz", "jan@sender.test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Complaint: update contacts to blacklisted
	mock.ExpectExec(`UPDATE contacts SET status = 'blacklisted'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Complaint: insert blacklist
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Complaint: feed back to companies email_status
	mock.ExpectExec(`UPDATE companies SET email_status = 'risky'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// G17 cascade: close outreach thread on complaint
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	err := p.Process(Event{
		OriginalMessageID: "complaint@id",
		Type:              BounceComplaint,
		Code:              "550",
		Reason:            "spam complaint",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

func TestProcess_SendEventNotFound(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnError(errBounce("no rows"))

	p := NewProcessor(bdb)
	err := p.Process(Event{
		OriginalMessageID: "unknown@id",
		Type:              BounceHard,
	})
	if err == nil {
		t.Error("expected error when send event not found")
	}
}

func TestProcess_InsertBounceError(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(100, 42, "user@firma.cz", "jan@sender.test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnError(errBounce("insert failed"))

	p := NewProcessor(bdb)
	err := p.Process(Event{
		OriginalMessageID: "msg@id",
		Type:              BounceHard,
	})
	if err == nil {
		t.Error("expected error from bounce_events insert")
	}
}

// ── CheckBlacklist via sqlmock ──

func TestCheckBlacklist_EmailFound(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	// Email check returns 1 (found)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE email`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	p := NewProcessor(bdb)
	if !p.CheckBlacklist("bad@firma.cz") {
		t.Error("expected blacklisted")
	}
}

func TestCheckBlacklist_DomainFound(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	// Email check returns 0 (not found)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE email`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// Domain check returns 1 (found)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE domain`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	p := NewProcessor(bdb)
	if !p.CheckBlacklist("user@blacklisted-domain.cz") {
		t.Error("expected blacklisted by domain")
	}
}

func TestCheckBlacklist_NotFound(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	// Email check: not found
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE email`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// Domain check: not found
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE domain`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	p := NewProcessor(bdb)
	if p.CheckBlacklist("good@safe-domain.cz") {
		t.Error("should not be blacklisted")
	}
}

func TestCheckBlacklist_NoAtSign(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	// Email check: not found (no @ means no domain check)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE email`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	p := NewProcessor(bdb)
	result := p.CheckBlacklist("notanemail")
	// "notanemail" has no @, so domain check is skipped → not blacklisted
	if result {
		t.Error("no-at-sign should not be blacklisted")
	}
}

type errBounce string

func (e errBounce) Error() string { return string(e) }

// Ensure time is imported (used in Process function)
var _ = time.Now

// ── Self-healing: soft bounce escalation ──

func TestProcess_SoftBounce_EscalatesToRiskyAt3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(400, 88, "risky@firma.cz", "sender@test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// softCount = 3 → pause threshold met
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// softCount >= 3 → escalate to risky
	mock.ExpectExec(`UPDATE companies SET email_status = 'risky'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	if err := p.Process(Event{
		OriginalMessageID: "soft3@id",
		Type:              BounceSoft,
		Code:              "451",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestProcess_SoftBounce_EscalatesToInvalidAt5(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(401, 89, "dead@firma.cz", "sender@test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// softCount = 5 → pause + invalid escalation
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// softCount >= 5 → escalate to invalid (skips risky branch)
	mock.ExpectExec(`UPDATE companies SET email_status = 'invalid'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	if err := p.Process(Event{
		OriginalMessageID: "soft5@id",
		Type:              BounceSoft,
		Code:              "451",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestProcess_SoftBounce_NoEscalationBelow3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(402, 90, "ok@firma.cz", "sender@test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// softCount = 2 → pause threshold not met, no escalation
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	// No UPDATE companies expected

	p := NewProcessor(bdb)
	if err := p.Process(Event{
		OriginalMessageID: "soft2@id",
		Type:              BounceSoft,
		Code:              "451",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}
