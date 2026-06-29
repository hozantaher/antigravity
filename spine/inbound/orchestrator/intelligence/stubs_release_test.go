package intelligence

import (
	"context"
	"errors"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// fakeHoldReleaser implements mailbox.HoldReleaser for tests.
type fakeHoldReleaser struct{ err error }

func (f *fakeHoldReleaser) ReleaseHold(_ context.Context, _ string) error { return f.err }

// TestAutoReleaseBounceHold_OneCandidate_Released tests the happy path where
// one mailbox qualifies (HeldHours >= 168h standard window) and is released.
func TestAutoReleaseBounceHold_OneCandidate_Released(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// CandidatesForRelease query: one row with updated_at 200h ago → HeldHours≈200 >= 168
	updatedAt := time.Now().Add(-200 * time.Hour)
	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}).AddRow(42, "jan@test.local", 5, updatedAt, 10))

	// ReleaseCandidateWithCanary: UPDATE canary state
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// ReleaseCandidateWithCanary: UPDATE cooldown log
	mock.ExpectExec(`UPDATE mailbox_cooldown_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	bp := &fakeHoldReleaser{}
	released, err := autoReleaseBounceHold(context.Background(), db, bp, 7)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if released != 1 {
		t.Errorf("released = %d, want 1", released)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestAutoReleaseBounceHold_ReleaseFails_Continue tests that a release failure
// is logged (slog.Warn) and the function continues (released=0, err=nil).
func TestAutoReleaseBounceHold_ReleaseFails_Continue(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	updatedAt := time.Now().Add(-200 * time.Hour)
	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}).AddRow(55, "fail@test.local", 3, updatedAt, 5))

	// bp.ReleaseHold fails → ReleaseCandidateWithCanary returns error → slog.Warn + continue
	bp := &fakeHoldReleaser{err: errors.New("release failed")}
	released, err := autoReleaseBounceHold(context.Background(), db, bp, 7)
	if err != nil {
		t.Fatalf("expected nil error (failure logged, not returned): %v", err)
	}
	if released != 0 {
		t.Errorf("released = %d, want 0 (release failed)", released)
	}
}

// TestAutoReleaseBounceHold_DBQueryError propagates a query error.
func TestAutoReleaseBounceHold_DBQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT m.id`).
		WillReturnError(errors.New("db down"))

	_, err = autoReleaseBounceHold(context.Background(), db, nil, 7)
	if err == nil {
		t.Fatal("expected error from query failure")
	}
}
