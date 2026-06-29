package bounce

import (
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// All uncovered paths are non-fatal slog.Warn paths triggered by Exec failures.

// ── Process: send_events UPDATE fails (line 90-92, non-fatal) + hard bounce ──

func TestProcess_SendEventUpdateFails_NonFatal(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(100, 42, "user@firma.cz", "jan@sender.test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(1, 1))
	// send_events UPDATE fails → slog.Warn (non-fatal)
	mock.ExpectExec(`UPDATE send_events`).WillReturnError(errBounce("send_event update failed"))
	// Hard bounce continues
	mock.ExpectExec(`UPDATE contacts SET status`).WillReturnResult(sqlmock.NewResult(0, 1))
	// blacklist INSERT fails → slog.Warn (line 114-116)
	mock.ExpectExec(`INSERT INTO blacklist`).WillReturnError(errBounce("blacklist insert failed"))
	// companies email_status UPDATE succeeds
	mock.ExpectExec(`UPDATE companies SET email_status`).WillReturnResult(sqlmock.NewResult(0, 1))
	// outreach_threads cascade fails → slog.Warn (line 134-136)
	mock.ExpectExec(`UPDATE outreach_threads`).WillReturnError(errBounce("threads cascade failed"))

	p := NewProcessor(bdb)
	err := p.Process(Event{OriginalMessageID: "msg-1", Type: BounceHard, Code: "550"})
	if err != nil {
		t.Errorf("expected nil (all non-fatal), got: %v", err)
	}
}

// ── Process: soft bounce scan error → returns nil (line 194-196) ──

func TestProcess_SoftBounce_ScanErr_ReturnsNil(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(200, 50, "soft@firma.cz", "sender@test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	// COUNT soft bounces scan fails → slog.Error; return nil
	mock.ExpectQuery(`SELECT COUNT`).WillReturnError(errBounce("scan error"))

	p := NewProcessor(bdb)
	err := p.Process(Event{OriginalMessageID: "msg-2", Type: BounceSoft, Code: "421"})
	if err != nil {
		t.Errorf("expected nil (scan err returns nil): %v", err)
	}
}

// ── Process: soft bounce high count, non-fatal Exec failures ──

func TestProcess_SoftBounce_HighCount_NonFatalExecs(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(201, 51, "soft2@firma.cz", "sender@test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	// softCount = 3 (>= 2 but < 5)
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))
	// Pause thread succeeds
	mock.ExpectExec(`UPDATE outreach_threads`).WillReturnResult(sqlmock.NewResult(0, 1))
	// Companies risky update fails → non-fatal
	mock.ExpectExec(`UPDATE companies`).WillReturnError(errBounce("risky update failed"))

	p := NewProcessor(bdb)
	err := p.Process(Event{OriginalMessageID: "msg-3", Type: BounceSoft, Code: "451"})
	if err != nil {
		t.Errorf("expected nil (non-fatal warns): %v", err)
	}
}

// ── Process: softCount >= 5 companies invalid error (line 194-196) ──

func TestProcess_SoftBounce_Count5_InvalidEscalationFails(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(202, 52, "soft3@firma.cz", "sender@test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	// softCount = 5 (>= 2, >= 5)
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))
	// Pause thread succeeds
	mock.ExpectExec(`UPDATE outreach_threads`).WillReturnResult(sqlmock.NewResult(0, 1))
	// Companies invalid update fails → slog.Warn (line 194-196)
	mock.ExpectExec(`UPDATE companies SET email_status`).WillReturnError(errBounce("invalid update failed"))

	p := NewProcessor(bdb)
	err := p.Process(Event{OriginalMessageID: "msg-4", Type: BounceSoft, Code: "451"})
	if err != nil {
		t.Errorf("expected nil (non-fatal warn): %v", err)
	}
}

// ── Process: complaint bounce error paths (lines 210-212, 218-220) ──

func TestProcess_Complaint_NonFatalExecs(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(300, 60, "spam@firma.cz", "sender@test"))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	// contacts SET status blacklisted fails → slog.Warn (line 210-212)
	mock.ExpectExec(`UPDATE contacts SET status`).WillReturnError(errBounce("contacts update failed"))
	// blacklist INSERT fails → slog.Warn (line 218-220)
	mock.ExpectExec(`INSERT INTO blacklist`).WillReturnError(errBounce("blacklist insert failed"))
	// companies email_status risky update succeeds
	mock.ExpectExec(`UPDATE companies`).WillReturnResult(sqlmock.NewResult(0, 1))
	// threads cascade succeeds
	mock.ExpectExec(`UPDATE outreach_threads`).WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	err := p.Process(Event{OriginalMessageID: "msg-5", Type: BounceComplaint, Code: "FBL"})
	if err != nil {
		t.Errorf("expected nil (non-fatal warns): %v", err)
	}
}
