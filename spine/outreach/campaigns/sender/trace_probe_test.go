package sender

import (
	"context"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- BuildCanaryMessage ----

func TestBuildCanaryMessage_NonEmpty(t *testing.T) {
	msg := BuildCanaryMessage(
		"from@test.com", "to@test.com",
		"Subject", "plain body", "<b>html</b>",
		nil,
	)
	if len(msg) == 0 {
		t.Fatal("expected non-empty canary message")
	}
}

func TestBuildCanaryMessage_ContainsSubject(t *testing.T) {
	msg := BuildCanaryMessage(
		"from@test.com", "to@test.com",
		"Canary Subject", "body", "",
		nil,
	)
	if !strings.Contains(string(msg), "Canary Subject") {
		t.Fatal("expected subject in canary message")
	}
}

func TestBuildCanaryMessage_CustomHeader(t *testing.T) {
	msg := BuildCanaryMessage(
		"from@test.com", "to@test.com",
		"S", "b", "",
		map[string]string{"X-Probe": "canary"},
	)
	if !strings.Contains(string(msg), "X-Probe") {
		t.Fatal("expected custom header X-Probe in canary message")
	}
}

func TestBuildCanaryMessage_NilHeaders_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with nil headers: %v", r)
		}
	}()
	BuildCanaryMessage("f@t.com", "t@t.com", "S", "b", "", nil)
}

// ---- ProtectionTrace ----

func TestNewProtectionTrace_NotNil(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	pt := NewProtectionTrace(db)
	if pt == nil {
		t.Fatal("expected non-nil ProtectionTrace")
	}
}

func TestProtectionTrace_NilReceiver_NoOp(t *testing.T) {
	var pt *ProtectionTrace
	if err := pt.Record(context.Background(), "msg-1", map[string]string{"l": "ok"}); err != nil {
		t.Fatalf("nil receiver should be no-op, got: %v", err)
	}
}

func TestProtectionTrace_NilDB_NoOp(t *testing.T) {
	pt := &ProtectionTrace{DB: nil}
	if err := pt.Record(context.Background(), "msg-1", map[string]string{"l": "ok"}); err != nil {
		t.Fatalf("nil DB should be no-op, got: %v", err)
	}
}

func TestProtectionTrace_EmptyMessageID_NoOp(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	pt := NewProtectionTrace(db)
	// Empty messageID → early return, no DB call
	if err := pt.Record(context.Background(), "", map[string]string{"l": "ok"}); err != nil {
		t.Fatalf("empty messageID should be no-op, got: %v", err)
	}
}

func TestProtectionTrace_RecordOK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO protection_trace`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	pt := NewProtectionTrace(db)
	if err := pt.Record(context.Background(), "<msg@test>", map[string]string{"l2": "ok", "l3": "skip"}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestProtectionTrace_RecordDBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO protection_trace`).
		WillReturnError(sqlmock.ErrCancelled)

	pt := NewProtectionTrace(db)
	if err := pt.Record(context.Background(), "<msg@test>", map[string]string{}); err == nil {
		t.Fatal("expected DB error")
	}
}
