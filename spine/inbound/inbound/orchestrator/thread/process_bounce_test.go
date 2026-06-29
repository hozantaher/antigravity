package thread

import (
	"context"
	"errors"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// processBounce — hard bounce path (InReplyTo set)
func TestProcessBounce_HardBounce_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. RecordInbound → INSERT INTO outreach_messages RETURNING id
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(99))

	// 2. Mark original outbound as bounced (InReplyTo non-empty)
	mock.ExpectExec(`UPDATE outreach_messages SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 3. Hard bounce: UPDATE outreach_threads SET status = 'bounced'
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 4. LogBounced → Log → INSERT INTO outreach_events RETURNING id
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// 5. LogBounced: UPDATE outreach_contacts SET total_bounced
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 6. LogBounced: UPDATE outreach_domains (error silently ignored)
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 7. Hard bounce: UPDATE outreach_contacts SET status = 'bounced'
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<bounce1@test.local>",
		InReplyTo:  "<orig1@test.local>",
		Subject:    "Undelivered Mail Returned",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1", Diagnostic: "User unknown"}

	if err := p.processBounce(context.Background(), raw, 10, 20, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// processBounce — soft bounce path (no InReplyTo)
func TestProcessBounce_SoftBounce_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(100))

	// 2. No UPDATE outreach_messages — InReplyTo is empty

	// 3. Soft bounce: Pause → UPDATE outreach_threads SET status = 'paused'
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 4. LogBounced → INSERT INTO outreach_events
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))

	// 5. UPDATE outreach_contacts SET total_bounced
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 6. UPDATE outreach_domains (silently ignored)
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 7. No UPDATE outreach_contacts SET status='bounced' for soft bounces

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<soft1@test.local>",
		InReplyTo:  "", // empty
		Subject:    "Temporary failure",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceSoft, DSNCode: "4.2.2", Diagnostic: "Mailbox full"}

	if err := p.processBounce(context.Background(), raw, 11, 21, bounce); err != nil {
		t.Fatalf("processBounce soft: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// processBounce — RecordInbound failure → error propagated
func TestProcessBounce_RecordInboundError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnError(errors.New("insert failed"))

	p := NewInboundProcessor(db)
	raw := RawInbound{MessageID: "<x@test>", ReceivedAt: time.Now()}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}

	if err := p.processBounce(context.Background(), raw, 1, 1, bounce); err == nil {
		t.Fatal("expected error from RecordInbound failure")
	}
}
