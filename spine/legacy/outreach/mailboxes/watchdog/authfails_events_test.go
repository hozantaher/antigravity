package watchdog

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- AuthFailStore ----

func TestAuthFailStore_NilDB_Record(t *testing.T) {
	s := NewAuthFailStore(nil)
	if err := s.Record(context.Background(), 1, "535 auth failed"); err != nil {
		t.Fatal(err)
	}
}

func TestAuthFailStore_NilDB_CountRecent(t *testing.T) {
	s := NewAuthFailStore(nil)
	n, err := s.CountRecent(context.Background(), 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestAuthFailStore_NilDB_ResolveAll(t *testing.T) {
	s := NewAuthFailStore(nil)
	if err := s.ResolveAll(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
}

func TestAuthFailStore_Record_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO mailbox_auth_fails`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	s := NewAuthFailStore(db)
	if err := s.Record(context.Background(), 42, "535 auth failed"); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthFailStore_CountRecent_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))

	s := NewAuthFailStore(db)
	n, err := s.CountRecent(context.Background(), 42, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("expected 3, got %d", n)
	}
}

func TestAuthFailStore_ResolveAll_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE mailbox_auth_fails`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	s := NewAuthFailStore(db)
	if err := s.ResolveAll(context.Background(), 42); err != nil {
		t.Fatal(err)
	}
}

// ---- EventRecorder ----

func TestEventRecorder_NilDB_Record(t *testing.T) {
	r := NewEventRecorder(nil)
	if err := r.Record(context.Background(), Event{Type: EventHeartbeat}); err != nil {
		t.Fatal(err)
	}
}

func TestEventRecorder_NilDB_ListByMailbox(t *testing.T) {
	r := NewEventRecorder(nil)
	events, err := r.ListByMailbox(context.Background(), 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if events != nil {
		t.Fatal("expected nil from nil-db")
	}
}

func TestEventRecorder_Record_NoMetadata(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO watchdog_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	r := NewEventRecorder(db)
	id := int64(1)
	if err := r.Record(context.Background(), Event{
		MailboxID:  &id,
		Type:       EventHeartbeat,
		AutoHealed: false,
		Reason:     "tick",
	}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEventRecorder_Record_WithMetadata(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO watchdog_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	r := NewEventRecorder(db)
	if err := r.Record(context.Background(), Event{
		Type:   EventProxySwap,
		Reason: "auth_fail_spike",
		Metadata: map[string]any{
			"old_proxy": "socks5://a",
			"new_proxy": "socks5://b",
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestEventRecorder_Record_GlobalEvent_NilMailbox(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO watchdog_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	r := NewEventRecorder(db)
	// nil MailboxID → global event
	if err := r.Record(context.Background(), Event{Type: EventHeartbeat, Reason: "daemon_tick"}); err != nil {
		t.Fatal(err)
	}
}

func TestEventRecorder_ListByMailbox_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	mbID := int64(42)
	rows := sqlmock.NewRows([]string{"id", "mailbox_id", "event_type", "auto_healed", "reason", "metadata", "created_at"}).
		AddRow(int64(1), mbID, "proxy_swap", true, "auth_fail_spike", []byte(`{"old":"a"}`), now).
		AddRow(int64(2), mbID, "heartbeat", false, "tick", []byte(`{}`), now)
	mock.ExpectQuery(`SELECT id`).WillReturnRows(rows)

	r := NewEventRecorder(db)
	events, err := r.ListByMailbox(context.Background(), 42, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	if events[0].Type != EventProxySwap {
		t.Fatalf("unexpected type: %s", events[0].Type)
	}
}

func TestEventRecorder_ListByMailbox_DefaultLimit(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "mailbox_id", "event_type", "auto_healed", "reason", "metadata", "created_at"}))

	r := NewEventRecorder(db)
	// limit=0 → default 10
	if _, err := r.ListByMailbox(context.Background(), 1, 0); err != nil {
		t.Fatal(err)
	}
}

// ---- RunChecks ----

func TestRunChecks_PingOK_HasDuration(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectPing()
	res, err := RunChecks(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if res.Duration < 0 {
		t.Fatal("expected non-negative duration")
	}
}

func TestRunChecks_PingOK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectPing()

	res, err := RunChecks(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if res.Duration <= 0 {
		t.Fatal("expected non-zero duration")
	}
}
