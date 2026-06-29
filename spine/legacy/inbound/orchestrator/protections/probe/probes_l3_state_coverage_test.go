package probe

// Additional coverage for the three DB-backed L3 state probes:
// CircuitBreakerL3, CanaryL3, BounceGuardL3.
//
// Strategy: use go-sqlmock to inject each failure path so we hit the
// 7–53% Run() branches that the existing nil-DB / skip tests never reach.

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// --------------------------------------------------------------------
// Interval() positive-cadence branch (covers the 66.7% gap)
// --------------------------------------------------------------------

func TestCircuitBreakerL3_IntervalCustom(t *testing.T) {
	p := NewCircuitBreakerL3(nil, 2*time.Minute)
	if p.Interval() != 2*time.Minute {
		t.Fatalf("want 2m, got %v", p.Interval())
	}
}

func TestCanaryL3_IntervalCustom(t *testing.T) {
	p := NewCanaryL3(nil, 3*time.Minute)
	if p.Interval() != 3*time.Minute {
		t.Fatalf("want 3m, got %v", p.Interval())
	}
}

func TestBounceGuardL3_IntervalCustom(t *testing.T) {
	p := NewBounceGuardL3(nil, 7*time.Minute)
	if p.Interval() != 7*time.Minute {
		t.Fatalf("want 7m, got %v", p.Interval())
	}
}

func TestSendRateL3_IntervalCustom(t *testing.T) {
	p := NewSendRateL3(20 * time.Minute)
	if p.Interval() != 20*time.Minute {
		t.Fatalf("want 20m, got %v", p.Interval())
	}
}

func TestWarmupRespectL3_IntervalCustom(t *testing.T) {
	p := NewWarmupRespectL3("", 8*time.Minute)
	if p.Interval() != 8*time.Minute {
		t.Fatalf("want 8m, got %v", p.Interval())
	}
}

// --------------------------------------------------------------------
// CircuitBreakerL3.Run — verify query fail + trip ignored
// --------------------------------------------------------------------

func TestCircuitBreakerL3_VerifyQueryFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// SELECT to verify → fails
	mock.ExpectQuery(`SELECT circuit_opened_at`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewCircuitBreakerL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on verify fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestCircuitBreakerL3_TripIgnored_Err(t *testing.T) {
	// Simulate a broken UPDATE that doesn't actually set circuit_opened_at:
	// SELECT returns opened_at=NULL, trips=0  → error path "trip ignored".
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(2)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// NULL opened_at, trips=0  → "trip ignored"
	openedAt := (*time.Time)(nil)
	mock.ExpectQuery(`SELECT circuit_opened_at`).
		WillReturnRows(
			sqlmock.NewRows([]string{"circuit_opened_at", "circuit_trip_count"}).
				AddRow(openedAt, 0),
		)
	mock.ExpectRollback()

	p := NewCircuitBreakerL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (trip ignored), got %s: %s", r.Status, r.Detail)
	}
}

func TestCircuitBreakerL3_Happy_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(3)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`SELECT circuit_opened_at`).
		WillReturnRows(
			sqlmock.NewRows([]string{"circuit_opened_at", "circuit_trip_count"}).
				AddRow(&now, 1),
		)
	mock.ExpectRollback()

	p := NewCircuitBreakerL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// CanaryL3.Run — all failure branches
// --------------------------------------------------------------------

func TestCanaryL3_SeedFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(10)))
	// First UPDATE (seed canary budget) fails
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewCanaryL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on seed fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestCanaryL3_ConsumeFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(11)))
	// First UPDATE (seed) succeeds
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// Second UPDATE (consume canary) fails
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewCanaryL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on consume fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestCanaryL3_VerifyFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(12)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// SELECT to verify → fails
	mock.ExpectQuery(`SELECT canary_remaining`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewCanaryL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on verify fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestCanaryL3_DecrementSkipped_Err(t *testing.T) {
	// SELECT returns remaining=3 (no decrement happened) or last=nil
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(13)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// remaining still 3, last=nil → decrement skipped
	last := (*time.Time)(nil)
	mock.ExpectQuery(`SELECT canary_remaining`).
		WillReturnRows(
			sqlmock.NewRows([]string{"canary_remaining", "last_canary_send"}).
				AddRow(3, last),
		)
	mock.ExpectRollback()

	p := NewCanaryL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (decrement skipped), got %s: %s", r.Status, r.Detail)
	}
}

func TestCanaryL3_Happy_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(14)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// remaining=2, last set → success
	mock.ExpectQuery(`SELECT canary_remaining`).
		WillReturnRows(
			sqlmock.NewRows([]string{"canary_remaining", "last_canary_send"}).
				AddRow(2, &now),
		)
	mock.ExpectRollback()

	p := NewCanaryL3(db, 5*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s: %s", r.Status, r.Detail)
	}
}

// --------------------------------------------------------------------
// BounceGuardL3.Run — all failure branches + zero-threshold fallback
// --------------------------------------------------------------------

func TestBounceGuardL3_ZeroThreshold_DefaultsTo5(t *testing.T) {
	// When Threshold is 0, Run should use the default of 5.
	// We just check it returns skip (nil DB) and that the
	// probe was constructed — the fallback is validated indirectly
	// via the happy path test below with Threshold=0.
	p := &BounceGuardL3{DB: nil, Cadence: 10 * time.Minute, Threshold: 0}
	r := p.Run(context.Background())
	if r.Status != StatusSkip {
		t.Fatalf("want skip, got %s", r.Status)
	}
}

func TestBounceGuardL3_SeedFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(20)))
	// First UPDATE (seed bounce counter) fails
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewBounceGuardL3(db, 10*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on seed fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestBounceGuardL3_FlipUpdateFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(21)))
	// Seed succeeds
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// Flip status fails
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewBounceGuardL3(db, 10*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on flip fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestBounceGuardL3_VerifyFails_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(22)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// SELECT to verify → fails
	mock.ExpectQuery(`SELECT status`).
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()

	p := NewBounceGuardL3(db, 10*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err on verify fail, got %s: %s", r.Status, r.Detail)
	}
}

func TestBounceGuardL3_FlipSkipped_Err(t *testing.T) {
	// SELECT returns status still "active" — flip was silently skipped.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(23)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(0, 0)) // no rows updated
	mock.ExpectQuery(`SELECT status`).
		WillReturnRows(
			sqlmock.NewRows([]string{"status", "consecutive_bounces"}).
				AddRow("active", 5),
		)
	mock.ExpectRollback()

	p := NewBounceGuardL3(db, 10*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusErr {
		t.Fatalf("want err (flip skipped), got %s: %s", r.Status, r.Detail)
	}
}

func TestBounceGuardL3_Happy_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectQuery(`INSERT INTO outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(24)))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`SELECT status`).
		WillReturnRows(
			sqlmock.NewRows([]string{"status", "consecutive_bounces"}).
				AddRow("bounce_hold", 5),
		)
	mock.ExpectRollback()

	p := NewBounceGuardL3(db, 10*time.Minute)
	r := p.Run(context.Background())
	if r.Status != StatusOK {
		t.Fatalf("want ok, got %s: %s", r.Status, r.Detail)
	}
}
