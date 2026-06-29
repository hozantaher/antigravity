package watchdog

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- hasPrefix ----

func TestHasPrefix_Matches(t *testing.T) {
	if !hasPrefix("circuit_breaker:reason", "circuit_breaker:") {
		t.Fatal("expected match")
	}
}

func TestHasPrefix_NoMatch(t *testing.T) {
	if hasPrefix("operator_paused", "circuit_breaker:") {
		t.Fatal("expected no match")
	}
}

func TestHasPrefix_TooShort(t *testing.T) {
	if hasPrefix("short", "circuit_breaker:") {
		t.Fatal("expected no match for shorter string")
	}
}

func TestHasPrefix_Exact(t *testing.T) {
	if !hasPrefix("pfx", "pfx") {
		t.Fatal("expected exact match")
	}
}

func TestHasPrefix_EmptyPrefix(t *testing.T) {
	if !hasPrefix("anything", "") {
		t.Fatal("empty prefix should always match")
	}
}

// ---- PGCircuitBreakerStore (nil DB) ----

func TestPGCBStore_NilDB_GetState_Noop(t *testing.T) {
	s := &PGCircuitBreakerStore{}
	st, err := s.GetState(context.Background(), 99)
	if err != nil {
		t.Fatal(err)
	}
	if st.MailboxID != 99 {
		t.Fatalf("expected mailbox id 99, got %d", st.MailboxID)
	}
}

func TestPGCBStore_NilDB_TripCircuit_Noop(t *testing.T) {
	s := &PGCircuitBreakerStore{}
	if err := s.TripCircuit(context.Background(), 1, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestPGCBStore_NilDB_CloseCircuit_Noop(t *testing.T) {
	s := &PGCircuitBreakerStore{}
	if err := s.CloseCircuit(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
}

// ---- PGCircuitBreakerStore (sqlmock) ----

func TestPGCBStore_GetState_OpenedAt(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT circuit_opened_at`).
		WillReturnRows(sqlmock.NewRows([]string{"circuit_opened_at", "circuit_trip_count"}).
			AddRow(&now, 3))

	s := &PGCircuitBreakerStore{DB: db}
	st, err := s.GetState(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if st.CircuitTripCount != 3 {
		t.Fatalf("expected 3 trips, got %d", st.CircuitTripCount)
	}
	if st.CircuitOpenedAt == nil {
		t.Fatal("expected non-nil CircuitOpenedAt")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPGCBStore_GetState_Closed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT circuit_opened_at`).
		WillReturnRows(sqlmock.NewRows([]string{"circuit_opened_at", "circuit_trip_count"}).
			AddRow(nil, 0))

	s := &PGCircuitBreakerStore{DB: db}
	st, err := s.GetState(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if st.CircuitOpenedAt != nil {
		t.Fatal("expected nil CircuitOpenedAt for closed circuit")
	}
}

func TestPGCBStore_TripCircuit_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	s := &PGCircuitBreakerStore{DB: db}
	if err := s.TripCircuit(context.Background(), 42, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPGCBStore_CloseCircuit_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	s := &PGCircuitBreakerStore{DB: db}
	if err := s.CloseCircuit(context.Background(), 42); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
