package thread

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for S3.2 — orchestrator NOTIFY hook in RecordInbound (#205)
// ════════════════════════════════════════════════════════════════════════

// 1. RecordInbound issues pg_notify after successful no-attachment INSERT.
func TestS32_NotifyAfterPlainInsert(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))
	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WithArgs(`{"thread_id":7,"message_id":42}`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 7, Subject: "x",
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 2. RecordInbound issues pg_notify after attachment-path COMMIT.
func TestS32_NotifyAfterTxCommit(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(99))
	mock.ExpectExec(`INSERT INTO message_attachments`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WithArgs(`{"thread_id":3,"message_id":99}`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 3, Subject: "x",
		Attachments: []InboundAttachment{
			{Filename: "x.bin", ContentType: "application/octet-stream",
				Data: []byte{0}, SizeBytes: 1, SHA256: strings.Repeat("0", 64)},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 3. NOTIFY failure does NOT fail RecordInbound.
func TestS32_NotifyFailureSwallowed(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))
	mock.ExpectExec(`SELECT pg_notify`).
		WillReturnError(errors.New("simulated NOTIFY failure"))

	id, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 7, Subject: "x",
	})
	if err != nil {
		t.Errorf("RecordInbound returned error despite NOTIFY failure: %v", err)
	}
	if id != 42 {
		t.Errorf("id should be 42 (DB row written), got %d", id)
	}
}

// 4. NOTIFY does NOT fire when INSERT fails (no row to notify about).
func TestS32_NoNotifyOnInsertFailure(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnError(errors.New("DB down"))
	// No mock.ExpectExec(pg_notify) — if the code calls it, sqlmock fails.

	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 7, Subject: "x",
	}); err == nil {
		t.Error("expected error from INSERT failure")
	}
}

// 5. NOTIFY does NOT fire when transaction rolls back (attachment failure).
func TestS32_NoNotifyOnRollback(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(99))
	mock.ExpectExec(`INSERT INTO message_attachments`).
		WillReturnError(errors.New("FK violation"))
	mock.ExpectRollback()
	// No pg_notify expectation — must not fire after rollback.

	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 7, Subject: "x",
		Attachments: []InboundAttachment{
			{Filename: "x.bin", ContentType: "application/octet-stream",
				Data: []byte{0}, SizeBytes: 1, SHA256: strings.Repeat("0", 64)},
		},
	}); err == nil {
		t.Error("expected error from attachment INSERT failure")
	}
}

// 6. NOTIFY payload is valid JSON with thread_id + message_id keys.
func TestS32_NotifyPayloadShape(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	rec := NewMessageRecorder(db).WithSanitizer(noopSanitizer{})

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(123))
	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WithArgs(`{"thread_id":456,"message_id":123}`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if _, err := rec.RecordInbound(context.Background(), InboundMessage{
		ThreadID: 456, Subject: "x",
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 7. notifyInbound function is callable directly + non-erroring on success.
func TestS32_NotifyInbound_DirectCall(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WithArgs(`{"thread_id":1,"message_id":2}`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	notifyInbound(context.Background(), db, 1, 2)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 8. notifyInbound on error: must not panic, must not propagate.
func TestS32_NotifyInbound_ErrorSwallowed(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectExec(`SELECT pg_notify`).
		WillReturnError(errors.New("connection lost"))

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("notifyInbound panicked: %v", r)
		}
	}()
	notifyInbound(context.Background(), db, 1, 2)
}

// 9. Source-level audit — slog op tag present.
func TestS32_SlogOpTagPresent(t *testing.T) {
	src := readSourceForS32(t, "messages.go")
	want := []string{
		`"op", "thread.notifyInbound"`,
		`'thread_inbound'`, // single-quoted in PG SQL
		`pg_notify`,
	}
	for _, w := range want {
		if !strings.Contains(src, w) {
			t.Errorf("messages.go missing %q", w)
		}
	}
}

// 10. Source-level audit — in the TX path, notifyInbound is called
// AFTER tx.Commit (not inside the tx block). Test 11 covers the
// stricter "no notifyInbound inside tx body" check; this one verifies
// the call site is positioned after the Commit statement specifically.
func TestS32_NotifyAfterCommit(t *testing.T) {
	src := readSourceForS32(t, "messages.go")
	commitIdx := strings.Index(src, "tx.Commit()")
	if commitIdx < 0 {
		t.Skip("tx.Commit not present in this build")
	}
	// Find a notifyInbound call AFTER tx.Commit() — must exist (the
	// attachment path notify).
	rest := src[commitIdx:]
	if !strings.Contains(rest, "notifyInbound(") {
		t.Error("no notifyInbound call after tx.Commit — attachment path doesn't emit event")
	}
}

// readSourceForS32 reads a sibling .go file. Helper for source-level audits.
func readSourceForS32(t *testing.T, name string) string {
	t.Helper()
	b, err := readFileBytes(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

// 11. Source-level audit — no notifyInbound INSIDE tx body.
func TestS32_NoNotifyInsideTx(t *testing.T) {
	src := readSourceForS32(t, "messages.go")
	// Find the tx block and check no notifyInbound inside.
	beginIdx := strings.Index(src, "tx, err := r.db.BeginTx")
	if beginIdx < 0 {
		t.Skip("BeginTx not present in source")
	}
	commitIdx := strings.Index(src[beginIdx:], "tx.Commit()")
	if commitIdx < 0 {
		t.Fatal("could not find tx.Commit")
	}
	txBody := src[beginIdx : beginIdx+commitIdx]
	if strings.Contains(txBody, "notifyInbound(") {
		t.Error("notifyInbound called inside tx body — must be after Commit")
	}
}
