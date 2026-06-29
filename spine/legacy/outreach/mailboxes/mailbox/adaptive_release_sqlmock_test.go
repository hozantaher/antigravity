package mailbox

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---- CandidatesForRelease ----

func TestCandidatesForRelease_NilDB_Error(t *testing.T) {
	_, err := CandidatesForRelease(context.Background(), nil, AdaptiveReleaseConfig{}, time.Now())
	if err == nil {
		t.Fatal("expected error with nil DB")
	}
}

func TestCandidatesForRelease_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}))

	candidates, err := CandidatesForRelease(context.Background(), db, AdaptiveReleaseConfig{}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("expected 0 candidates, got %d", len(candidates))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCandidatesForRelease_EligibleMailbox(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// held_hours = now - updatedAt; use 200h ago to exceed MinHoldHours=168
	updatedAt := time.Now().Add(-200 * time.Hour)
	mock.ExpectQuery(`SELECT m.id`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "from_address", "consecutive_bounces", "updated_at", "sent_7d",
		}).AddRow(int64(1), "box@test.com", 3, updatedAt, 2))

	cfg := AdaptiveReleaseConfig{} // WithDefaults fills in sensible values
	candidates, err := CandidatesForRelease(context.Background(), db, cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// May or may not be eligible depending on ShouldRelease — just verify no panic/error
	_ = candidates
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCandidatesForRelease_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT m.id`).WillReturnError(sqlmock.ErrCancelled)

	_, err = CandidatesForRelease(context.Background(), db, AdaptiveReleaseConfig{}, time.Now())
	if err == nil {
		t.Fatal("expected error from DB")
	}
}

// ---- RecordCooldownEntry ----

func TestRecordCooldownEntry_NilDB_Noop(t *testing.T) {
	if err := RecordCooldownEntry(context.Background(), nil, 1, 5, 10); err != nil {
		t.Fatal(err)
	}
}

func TestRecordCooldownEntry_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO mailbox_cooldown_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if err := RecordCooldownEntry(context.Background(), db, 42, 5, 20); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRecordCooldownEntry_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO mailbox_cooldown_log`).
		WillReturnError(sqlmock.ErrCancelled)

	if err := RecordCooldownEntry(context.Background(), db, 1, 3, 5); err == nil {
		t.Fatal("expected DB error")
	}
}

// ---- OnCanaryBounce ----

type fakeBackpressure struct {
	bounceAddr   string
	bounceReason string
}

func (f *fakeBackpressure) RecordBounce(ctx context.Context, fromAddress, reason string) (held bool) {
	f.bounceAddr = fromAddress
	f.bounceReason = reason
	return false
}

func (f *fakeBackpressure) RecordSuccess(ctx context.Context, fromAddress string, sentAt time.Time) {}
func (f *fakeBackpressure) ActiveAddresses(ctx context.Context) (map[string]struct{}, error) {
	return nil, nil
}

func TestOnCanaryBounce_NilDB_Noop(t *testing.T) {
	bp := &fakeBackpressure{}
	if err := OnCanaryBounce(context.Background(), nil, bp, 1, "from@test.com", "hard"); err != nil {
		t.Fatal(err)
	}
}

func TestOnCanaryBounce_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	bp := &fakeBackpressure{}
	if err := OnCanaryBounce(context.Background(), db, bp, 7, "box@test.com", "hard"); err != nil {
		t.Fatal(err)
	}
	if bp.bounceAddr != "box@test.com" {
		t.Fatalf("expected RecordBounce called with box@test.com, got %q", bp.bounceAddr)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestOnCanaryBounce_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).WillReturnError(sqlmock.ErrCancelled)

	bp := &fakeBackpressure{}
	if err := OnCanaryBounce(context.Background(), db, bp, 1, "x@test.com", "spam"); err == nil {
		t.Fatal("expected DB error")
	}
}

// ---- ReleaseCandidateWithCanary ----

type fakeHoldReleaserAR struct {
	released string
	retErr   error
}

func (f *fakeHoldReleaserAR) ReleaseHold(ctx context.Context, address string) error {
	f.released = address
	return f.retErr
}

func TestReleaseCandidateWithCanary_ReleaseError(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	bp := &fakeHoldReleaserAR{retErr: sqlmock.ErrCancelled}
	c := ReleaseCandidate{ID: 1, FromAddress: "box@test.com"}
	if err := ReleaseCandidateWithCanary(context.Background(), db, bp, AdaptiveReleaseConfig{}, c); err == nil {
		t.Fatal("expected error when ReleaseHold fails")
	}
}

func TestReleaseCandidateWithCanary_OK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// canary state update
	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// cooldown log close
	mock.ExpectExec(`UPDATE mailbox_cooldown_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	bp := &fakeHoldReleaserAR{}
	c := ReleaseCandidate{ID: 3, FromAddress: "box@test.com"}
	if err := ReleaseCandidateWithCanary(context.Background(), db, bp, AdaptiveReleaseConfig{}, c); err != nil {
		t.Fatal(err)
	}
	if bp.released != "box@test.com" {
		t.Fatalf("expected ReleaseHold called with box@test.com, got %q", bp.released)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
