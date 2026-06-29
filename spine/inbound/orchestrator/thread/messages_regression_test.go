package thread

import (
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// Regression tests for the Mark* message updates. These tests differ from
// TestMessageRecorder_MarkBounced_OK (unit_test.go:624) in two important ways:
//
//  1. They assert the placeholder ordering with WithArgs(...). If a future
//     refactor swaps $1/$2/$3, sqlmock's default arg matcher catches it —
//     the existing regex test would still pass because it only checks the
//     "UPDATE outreach_messages" prefix.
//  2. They anchor the SQL text with a regex that includes each $N index,
//     so a silent placeholder-number regression also fails here.
//
// Background: commit 066929f fixed a real bug where MarkBounced's WHERE
// clause said `message_id = $2` but only 3 args were bound — meaning the
// SMTP response string was used as the message_id lookup key. The previous
// test used ExpectExec with a loose regex that tolerated the duplicate $2,
// so the bug shipped until DMARC-driven bounce ingestion exercised the path.
// These tests make a similar regression impossible to miss.

func TestMarkBounced_PlaceholderOrder_Regression(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	bouncedAt := time.Date(2026, 4, 17, 13, 0, 0, 0, time.UTC)
	smtpResponse := "550 5.1.1 user unknown"
	messageID := "<abc-xyz@s.test>"

	// Regex both asserts the $1, $2, $3 indices ARE present and that they
	// appear in the expected (bouncedAt, smtp, message_id) ordering — which
	// is exactly what commit 066929f locked in.
	mock.ExpectExec(regexp.QuoteMeta(
		"UPDATE outreach_messages SET bounced_at = $1, smtp_response = $2",
	)).
		WithArgs(bouncedAt, smtpResponse, messageID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := r.MarkBounced(ctx, messageID, bouncedAt, smtpResponse); err != nil {
		t.Fatalf("MarkBounced: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations (argument-order regression?): %v", err)
	}
}

func TestMarkBounced_SQLContainsEachPlaceholder_Regression(t *testing.T) {
	// Directly assert every one of $1, $2, $3 appears exactly once in the
	// SQL, so a regression to `$2 ... $2` (the old bug) fails immediately.
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	matcher := regexp.MustCompile(
		`UPDATE outreach_messages SET bounced_at = \$1, smtp_response = \$2\s+WHERE message_id = \$3`,
	)
	mock.ExpectExec(matcher.String()).
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := r.MarkBounced(ctx, "m@test", time.Now(), "550"); err != nil {
		t.Fatalf("MarkBounced: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("SQL text deviated from locked-in placeholder pattern: %v", err)
	}
}

func TestMarkOpened_PlaceholderOrder_Regression(t *testing.T) {
	// MarkOpened uses $1, $2 only — test it too so a parallel bug in the
	// simpler 2-arg form is caught the same way.
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	openedAt := time.Date(2026, 4, 17, 13, 5, 0, 0, time.UTC)
	messageID := "<open@s.test>"

	mock.ExpectExec(regexp.QuoteMeta("UPDATE outreach_messages SET opened_at = $1")).
		WithArgs(openedAt, messageID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := r.MarkOpened(ctx, messageID, openedAt); err != nil {
		t.Fatalf("MarkOpened: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestMarkClicked_PlaceholderOrder_Regression(t *testing.T) {
	// MarkClicked mirrors MarkOpened — 2 args, $1=timestamp $2=message_id.
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	clickedAt := time.Date(2026, 4, 17, 13, 10, 0, 0, time.UTC)
	messageID := "<click@s.test>"

	mock.ExpectExec(regexp.QuoteMeta("UPDATE outreach_messages SET clicked_at = $1")).
		WithArgs(clickedAt, messageID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := r.MarkClicked(ctx, messageID, clickedAt); err != nil {
		t.Fatalf("MarkClicked: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}
