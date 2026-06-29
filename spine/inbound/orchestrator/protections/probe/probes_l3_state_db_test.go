package probe

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// withShadowMailbox is exercised through CircuitBreakerL3 with a nil DB (Skip path)
// and a mock DB (begin/insert/body path).

func TestCircuitBreakerL3_NilDB_Skip(t *testing.T) {
	p := NewCircuitBreakerL3(nil, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

func TestCircuitBreakerL3_BeginFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin().WillReturnError(context.DeadlineExceeded)

	p := NewCircuitBreakerL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err on begin failure, got %s", r.Status)
	}
}

func TestCircuitBreakerL3_ShadowUpsertFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewCircuitBreakerL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err on shadow upsert failure, got %s", r.Status)
	}
}

func TestCircuitBreakerL3_TripUpdateFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewCircuitBreakerL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err on trip update failure, got %s", r.Status)
	}
}

func TestCanaryL3_NilDB_Skip(t *testing.T) {
	p := NewCanaryL3(nil, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

func TestBounceGuardL3_NilDB_Skip(t *testing.T) {
	p := NewBounceGuardL3(nil, 10*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("expected skip, got %s", r.Status)
	}
}

func TestScheduler_Add(t *testing.T) {
	sink := &fakeSink{}
	s := NewScheduler(sink)
	initial := len(s.probers)

	p := NewDBPoolL2(nil, 30*time.Second)
	s.Add(p)

	if len(s.probers) != initial+1 {
		t.Fatalf("expected %d probers, got %d", initial+1, len(s.probers))
	}
}
