package probe

import (
	"context"
	"database/sql"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- WatchdogL2 DB paths ----

func TestWatchdogL2_NoEvents_Warn(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"max"}).AddRow(nil)
	mock.ExpectQuery(`SELECT MAX`).WillReturnRows(rows)

	p := NewWatchdogL2(db, 60*time.Second, 15*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("expected warn for no events, got %s", r.Status)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestWatchdogL2_RecentEvent_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"max"}).AddRow(sql.NullTime{Time: time.Now().Add(-1 * time.Minute), Valid: true})
	mock.ExpectQuery(`SELECT MAX`).WillReturnRows(rows)

	p := NewWatchdogL2(db, 60*time.Second, 15*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("expected ok for recent event, got %s: %s", r.Status, r.Detail)
	}
}

func TestWatchdogL2_StaleEvent_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"max"}).AddRow(sql.NullTime{Time: time.Now().Add(-20 * time.Minute), Valid: true})
	mock.ExpectQuery(`SELECT MAX`).WillReturnRows(rows)

	p := NewWatchdogL2(db, 60*time.Second, 15*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err for stale event, got %s", r.Status)
	}
}

func TestWatchdogL2_HalfwayEvent_Warn(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Age > maxAge/2 (7.5m) but < maxAge (15m) → warn
	rows := sqlmock.NewRows([]string{"max"}).AddRow(sql.NullTime{Time: time.Now().Add(-10 * time.Minute), Valid: true})
	mock.ExpectQuery(`SELECT MAX`).WillReturnRows(rows)

	p := NewWatchdogL2(db, 60*time.Second, 15*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("expected warn for halfway-stale event, got %s", r.Status)
	}
}

// ---- DBPoolL2 DB paths ----

func TestDBPoolL2_Select1_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT 1`).WillReturnRows(sqlmock.NewRows([]string{"1"}).AddRow(1))

	p := NewDBPoolL2(db, 30*time.Second)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("expected ok, got %s: %s", r.Status, r.Detail)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ---- SenderEngineL2 DB paths ----

func TestSenderEngineL2_NoHeartbeat_Warn(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT updated_at`).WillReturnError(sql.ErrNoRows)

	p := NewSenderEngineL2(db, 60*time.Second, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("expected warn for no heartbeat, got %s", r.Status)
	}
}

func TestSenderEngineL2_RecentHeartbeat_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"updated_at"}).
		AddRow(sql.NullTime{Time: time.Now().Add(-1 * time.Minute), Valid: true})
	mock.ExpectQuery(`SELECT updated_at`).WillReturnRows(rows)

	p := NewSenderEngineL2(db, 60*time.Second, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("expected ok for recent heartbeat, got %s: %s", r.Status, r.Detail)
	}
}

func TestSenderEngineL2_StaleHeartbeat_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"updated_at"}).
		AddRow(sql.NullTime{Time: time.Now().Add(-40 * time.Minute), Valid: true})
	mock.ExpectQuery(`SELECT updated_at`).WillReturnRows(rows)

	p := NewSenderEngineL2(db, 60*time.Second, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("expected err for stale heartbeat, got %s", r.Status)
	}
}

func TestSenderEngineL2_NullHeartbeat_Warn(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"updated_at"}).
		AddRow(sql.NullTime{Valid: false})
	mock.ExpectQuery(`SELECT updated_at`).WillReturnRows(rows)

	p := NewSenderEngineL2(db, 60*time.Second, 30*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusWarn {
		t.Fatalf("expected warn for null heartbeat, got %s", r.Status)
	}
}
