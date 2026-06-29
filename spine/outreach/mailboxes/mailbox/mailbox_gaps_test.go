package mailbox

import (
	"context"
	"errors"
	"testing"
	"time"

	"common/config"
	"github.com/DATA-DOG/go-sqlmock"
)

var errMB = errors.New("mailbox test error")

// ── postgres.go: List scan error (line 79-81) ──

func TestList_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "bad"))

	s := NewPGStore(db)
	_, err = s.List(context.Background(), Filter{Limit: 10})
	if err == nil {
		t.Error("expected scan error from List")
	}
}

// ── postgres.go: TouchLastSend → ExecContext error (line 199-201) ──

func TestTouchLastSend_ExecError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).WillReturnError(errMB)

	s := NewPGStore(db)
	err = s.TouchLastSend(context.Background(), 1, time.Now())
	if err == nil {
		t.Error("expected error from TouchLastSend when ExecContext fails")
	}
}

// ── postgres.go: TouchLastSend → ErrMailboxNotFound (line 203-205) ──

func TestTouchLastSend_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := NewPGStore(db)
	err = s.TouchLastSend(context.Background(), 999, time.Now())
	if err != ErrMailboxNotFound {
		t.Errorf("expected ErrMailboxNotFound, got %v", err)
	}
}

// ── sync.go: OverlayRegistry store.List error (line 147-149) ──

func TestOverlayRegistry_ListError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).WillReturnError(errMB)

	s := NewPGStore(db)
	cfg := &config.Config{}
	_, _, err = OverlayRegistry(context.Background(), s, cfg)
	if err == nil {
		t.Error("expected error from OverlayRegistry when List fails")
	}
}

// ── adaptive_release.go: CandidatesForRelease scan error (line 108-110) ──

func TestCandidatesForRelease_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	_, err = CandidatesForRelease(context.Background(), db, AdaptiveReleaseConfig{}.WithDefaults(), time.Now())
	if err == nil {
		t.Error("expected scan error from CandidatesForRelease")
	}
}

// ── adaptive_release.go: ReleaseCandidateWithCanary warnings (lines 134-136, 142-144) ──

type stubHoldReleaser struct{}

func (s *stubHoldReleaser) ReleaseHold(ctx context.Context, addr string) error { return nil }

func TestReleaseCandidateWithCanary_ExecsFail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE outreach_mailboxes`).WillReturnError(errMB)
	mock.ExpectExec(`UPDATE mailbox_cooldown_log`).WillReturnError(errMB)

	err = ReleaseCandidateWithCanary(context.Background(), db, &stubHoldReleaser{},
		AdaptiveReleaseConfig{}.WithDefaults(), ReleaseCandidate{ID: 1, FromAddress: "x@x.cz"})
	if err != nil {
		t.Errorf("expected nil (warns non-fatal), got %v", err)
	}
}

// ── backpressure.go: ReleaseHold UpdateStatus error (line 132-134) ──

func buildMailboxRow(id int64, addr, status string) *sqlmock.Rows {
	now := time.Now()
	return sqlmock.NewRows(mailboxCols()).AddRow(
		id, addr, "Test Box",
		"smtp.test", 587, "",
		"", nil, "",
		nil, "Europe/Prague", "cs",
		status, "",
		nil, 0, 0, 0,
		now, now, "", "", "production",
		"",          // preferred_country
		"warmup_d0", // lifecycle_phase
	)
}

func TestReleaseHold_UpdateStatusError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// GetByAddress → SELECT
	mock.ExpectQuery(`SELECT`).WillReturnRows(buildMailboxRow(1, "x@x.cz", string(StatusBounceHold)))
	// UpdateStatus → QueryRowContext (RETURNING) → returns error
	mock.ExpectQuery(`UPDATE outreach_mailboxes`).WillReturnError(errMB)

	s := NewPGStore(db)
	bp := NewBackpressure(s)
	err = bp.ReleaseHold(context.Background(), "x@x.cz")
	if err == nil {
		t.Error("expected error from ReleaseHold when UpdateStatus fails")
	}
}

func TestReleaseHold_ResetBounceWarning(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// GetByAddress
	mock.ExpectQuery(`SELECT`).WillReturnRows(buildMailboxRow(1, "x@x.cz", string(StatusBounceHold)))
	// UpdateStatus (QueryRowContext RETURNING)
	mock.ExpectQuery(`UPDATE outreach_mailboxes`).WillReturnRows(buildMailboxRow(1, "x@x.cz", string(StatusActive)))
	// ResetBounce (ExecContext) fails → slog.Warn, non-fatal
	mock.ExpectExec(`UPDATE outreach_mailboxes`).WillReturnError(errMB)

	s := NewPGStore(db)
	bp := NewBackpressure(s)
	err = bp.ReleaseHold(context.Background(), "x@x.cz")
	if err != nil {
		t.Errorf("expected nil (ResetBounce error non-fatal): %v", err)
	}
}
