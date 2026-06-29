package thread

// Regression tests for the 2026-04-21 Go audit — HIGH item H4
// (bare ExecContext on domain counters in thread/events.go).
//
// Before fix: a failed outreach_domains counter UPDATE silently
// dropped the error, so intelligence.DetectDomainIssues gated on a
// drifted counter. After fix: slog.Warn fires so the drift is
// observable.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func captureSlogThread(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return &buf
}

func TestLogBounced_DomainCounterError_IsLogged_H4(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := captureSlogThread(t)

	// event INSERT succeeds
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	// contact counter UPDATE succeeds
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// domain counter UPDATE errors (pre-fix: silently dropped)
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnError(errors.New("DB down"))

	logger := NewEventLogger(db)
	if err := logger.LogBounced(context.Background(), 42, 7, 1, "hard"); err != nil {
		t.Fatalf("LogBounced should NOT propagate the domain-counter error (non-fatal), got: %v", err)
	}

	if !strings.Contains(buf.String(), "outreach_domains bounce counter update failed") {
		t.Errorf("expected H4 log line; got: %s", buf.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock: %v", err)
	}
}

func TestLogComplained_DomainCounterError_IsLogged_H4(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := captureSlogThread(t)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnError(errors.New("serialization failure"))

	logger := NewEventLogger(db)
	if err := logger.LogComplained(context.Background(), 42, 7, 1); err != nil {
		t.Fatalf("LogComplained should NOT propagate domain error, got: %v", err)
	}

	if !strings.Contains(buf.String(), "outreach_domains complaint counter update failed") {
		t.Errorf("expected H4 complaint log line; got: %s", buf.String())
	}
}

// Happy path must remain silent (no H4 log unless something actually broke).
func TestLogBounced_HappyPath_NoH4LogNoise_H4(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := captureSlogThread(t)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(3))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	logger := NewEventLogger(db)
	if err := logger.LogBounced(context.Background(), 42, 7, 1, "hard"); err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}

	if strings.Contains(buf.String(), "outreach_domains") {
		t.Errorf("happy path must not emit H4 warning; got: %s", buf.String())
	}
}
