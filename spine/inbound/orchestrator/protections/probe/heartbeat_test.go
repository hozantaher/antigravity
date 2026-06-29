package probe

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func TestNewHeartbeat_Defaults(t *testing.T) {
	h := NewHeartbeat(nil, "", 0)
	if h.Key != "sender_heartbeat_at" {
		t.Fatalf("default key: %s", h.Key)
	}
	if h.Cadence != 30*time.Second {
		t.Fatalf("default cadence: %s", h.Cadence)
	}
}

func TestNewHeartbeat_CustomValues(t *testing.T) {
	h := NewHeartbeat(nil, "custom_key", 5*time.Minute)
	if h.Key != "custom_key" {
		t.Fatalf("key: %s", h.Key)
	}
	if h.Cadence != 5*time.Minute {
		t.Fatalf("cadence: %s", h.Cadence)
	}
}

func TestHeartbeat_NilDB_RunReturns(t *testing.T) {
	h := NewHeartbeat(nil, "", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	h.Run(ctx) // must return; nil DB → early return
}

func TestHeartbeat_WriteErr_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_config`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	h := NewHeartbeat(db, "sender_heartbeat_at", 30*time.Second)
	if err := h.writeErr(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeat_WriteErr_DBError_Wrapped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_config`).
		WillReturnError(context.DeadlineExceeded)

	h := NewHeartbeat(db, "sender_heartbeat_at", 30*time.Second)
	if err := h.writeErr(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

func TestHeartbeat_Write_SilencesError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO outreach_config`).
		WillReturnError(context.DeadlineExceeded)

	h := NewHeartbeat(db, "sender_heartbeat_at", 30*time.Second)
	// write() must not panic or propagate; just logs
	h.write(context.Background())
}

func TestHeartbeat_Run_WritesOnTick(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// initial write + at least 1 tick in 50ms window
	for i := 0; i < 10; i++ {
		mock.ExpectExec(`INSERT INTO outreach_config`).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	h := NewHeartbeat(db, "sender_heartbeat_at", 10*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	h.Run(ctx) // returns when ctx done
}
