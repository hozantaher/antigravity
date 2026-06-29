package intelligence

import (
	"context"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─── statusToInt ─────────────────────────────────────────────────────────────

func TestStatusToInt_Active(t *testing.T) {
	if got := statusToInt("active"); got != 1 {
		t.Fatalf("expected 1 for active, got %d", got)
	}
}

func TestStatusToInt_Paused(t *testing.T) {
	if got := statusToInt("paused"); got != 2 {
		t.Fatalf("expected 2 for paused, got %d", got)
	}
}

func TestStatusToInt_BounceHold(t *testing.T) {
	if got := statusToInt("bounce_hold"); got != 3 {
		t.Fatalf("expected 3 for bounce_hold, got %d", got)
	}
}

func TestStatusToInt_Retired(t *testing.T) {
	if got := statusToInt("retired"); got != 4 {
		t.Fatalf("expected 4 for retired, got %d", got)
	}
}

func TestStatusToInt_Unknown(t *testing.T) {
	for _, s := range []string{"", "unknown", "invalid", "ACTIVE"} {
		if got := statusToInt(s); got != 0 {
			t.Fatalf("expected 0 for %q, got %d", s, got)
		}
	}
}

// ─── emitMailboxMetrics ───────────────────────────────────────────────────────

func TestEmitMailboxMetrics_DBError_NoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT from_address`).WillReturnError(sqlmock.ErrCancelled)

	// Should not panic — errors are swallowed with slog.Warn
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("emitMailboxMetrics panicked: %v", r)
		}
	}()
	emitMailboxMetrics(context.Background(), db)
}

func TestEmitMailboxMetrics_Rows_Processed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT from_address`).
		WillReturnRows(sqlmock.NewRows([]string{
			"from_address", "status", "consecutive_bounces", "canary_remaining", "circuit",
		}).
			AddRow("box1@test.com", "active", 0, 0, 0).
			AddRow("box2@test.com", "bounce_hold", 5, 3, 1).
			AddRow("box3@test.com", "retired", 0, 0, 0))

	// Should process all rows without panic
	emitMailboxMetrics(context.Background(), db)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEmitMailboxMetrics_ScanError_Skips(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Return a row with wrong column count to trigger scan error
	mock.ExpectQuery(`SELECT from_address`).
		WillReturnRows(sqlmock.NewRows([]string{"from_address"}).
			AddRow("box@test.com"))

	// Should not panic even on scan error
	emitMailboxMetrics(context.Background(), db)
}

// ─── autoReleaseBounceHold ────────────────────────────────────────────────────

func TestAutoReleaseBounceHold_NilDB_Error(t *testing.T) {
	_, err := autoReleaseBounceHold(context.Background(), nil, nil, 7)
	if err == nil {
		t.Fatal("expected error with nil DB")
	}
}

func TestAutoReleaseBounceHold_EmptyCandidates_ZeroReleased(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// CandidatesForRelease queries outreach_mailboxes where status = 'bounce_hold'
	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}))

	released, err := autoReleaseBounceHold(context.Background(), db, nil, 7)
	if err != nil {
		t.Fatal(err)
	}
	if released != 0 {
		t.Fatalf("expected 0 released, got %d", released)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ─── emitDeliverabilityMetrics ────────────────────────────────────────────────

func TestEmitDeliverabilityMetrics_DBError_NoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT email_status`).WillReturnError(sqlmock.ErrCancelled)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("emitDeliverabilityMetrics panicked: %v", r)
		}
	}()
	emitDeliverabilityMetrics(context.Background(), db)
}

func TestEmitDeliverabilityMetrics_Rows_Processed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT email_status`).
		WillReturnRows(sqlmock.NewRows([]string{"email_status", "count"}).
			AddRow("valid", int64(500)).
			AddRow("risky", int64(100)).
			AddRow("catch_all", int64(50)))

	emitDeliverabilityMetrics(context.Background(), db)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
