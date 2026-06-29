package bounce

// Regression tests for the 2026-04-21 Go audit — HIGH item H3
// (dropped QueryRow.Scan & bare p.db.Exec errors in bounce/processor.go).
//
// Failure modes the fix closes:
//   • CheckBlacklist Scan drop → transient DB error returned FALSE,
//     allowing a suppressed email to be sent. Fix fails closed (true).
//   • Process / soft-bounce softCount Scan drop → DB error silently
//     zeroed the counter so escalations never fired.
//   • Hard-bounce / complaint cascade Exec drops → corrupted suppression
//     state could silently pass.
//
// All tests seed the bug by returning an error from the relevant
// sqlmock expectation, then assert the fixed post-behavior.

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// captureSlogBounce mirrors the helper in the campaign tests.
func captureSlogBounce(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return &buf
}

// ── CheckBlacklist fail-closed on email Scan error ──
func TestCheckBlacklist_EmailScanError_FailsClosed_H3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	buf := captureSlogBounce(t)

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE email`).
		WillReturnError(errors.New("DB down"))

	p := NewProcessor(bdb)
	if !p.CheckBlacklist("anyone@firma.cz") {
		t.Fatal("CheckBlacklist must fail CLOSED (return true) on Scan error to prevent sending to potentially-suppressed addresses")
	}
	if !strings.Contains(buf.String(), "blacklist email check failed") {
		t.Errorf("expected fail-closed log; got: %s", buf.String())
	}
}

// ── CheckBlacklist fail-closed on domain Scan error ──
func TestCheckBlacklist_DomainScanError_FailsClosed_H3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	buf := captureSlogBounce(t)

	// Email query succeeds but returns 0.
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE email`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// Domain query errors out.
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist WHERE domain`).
		WillReturnError(errors.New("timeout"))

	p := NewProcessor(bdb)
	if !p.CheckBlacklist("someone@shaky.cz") {
		t.Fatal("must fail closed on domain check error")
	}
	if !strings.Contains(buf.String(), "blacklist domain check failed") {
		t.Errorf("expected domain fail-closed log; got: %s", buf.String())
	}
}

// ── Process: soft-bounce count Scan error → skip escalation (not silently zero) ──
func TestProcess_SoftBounce_ScanError_SkipsEscalation_H3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	buf := captureSlogBounce(t)

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(500, 51, "u@firma.cz", "mx@s.test"))

	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Soft count query errors → softCount would pre-fix default to 0 →
	// "below threshold" branch → NO escalation / pause, silently.
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnError(errors.New("connection reset"))

	// Post-fix: NO further SQL is run (we return after logging).

	p := NewProcessor(bdb)
	if err := p.Process(Event{
		OriginalMessageID: "bad@id",
		Type:              BounceSoft,
		Code:              "451",
	}); err != nil {
		t.Fatalf("Process should not error: %v", err)
	}

	if !strings.Contains(buf.String(), "failed to count soft bounces") {
		t.Errorf("expected Scan-error log; got: %s", buf.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected SQL issued after Scan error (pre-fix would have run the threshold branch with softCount=0): %v", err)
	}
}

// ── Process: hard-bounce contact update error is logged ──
func TestProcess_HardBounce_ContactUpdateError_IsLogged_H3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	buf := captureSlogBounce(t)

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(600, 61, "u2@firma.cz", ""))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Contact UPDATE errors — pre-fix: silently dropped.
	mock.ExpectExec(`UPDATE contacts SET status = 'bounced'`).
		WillReturnError(errors.New("serialization failure"))

	// Remaining statements must still run best-effort.
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE companies SET email_status = 'invalid'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewProcessor(bdb)
	if err := p.Process(Event{
		OriginalMessageID: "hb@id",
		Type:              BounceHard,
		Code:              "550",
	}); err != nil {
		t.Fatalf("Process should not abort on cascade failure: %v", err)
	}

	if !strings.Contains(buf.String(), "hard bounce contact status update failed") {
		t.Errorf("expected cascade-error log; got: %s", buf.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expected cascade to run best-effort through all steps: %v", err)
	}
}

// ── Process: complaint threads-close error is logged ──
func TestProcess_Complaint_ThreadsCloseError_IsLogged_H3(t *testing.T) {
	bdb, mock, cleanup := newBounceDB(t)
	defer cleanup()

	buf := captureSlogBounce(t)

	mock.ExpectQuery(`SELECT se.id, se.contact_id, c.email`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id", "email", "mailbox_used"}).
			AddRow(700, 71, "c@firma.cz", ""))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE send_events SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE contacts SET status = 'blacklisted'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO blacklist`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE companies SET email_status = 'risky'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// threads cascade errors — pre-fix: silent.
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("lock timeout"))

	p := NewProcessor(bdb)
	if err := p.Process(Event{
		OriginalMessageID: "cmp@id",
		Type:              BounceComplaint,
		Code:              "550",
	}); err != nil {
		t.Fatalf("Process should not error: %v", err)
	}

	if !strings.Contains(buf.String(), "complaint threads close failed") {
		t.Errorf("expected complaint-cascade log; got: %s", buf.String())
	}
}
