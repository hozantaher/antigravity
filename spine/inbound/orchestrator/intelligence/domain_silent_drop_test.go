package intelligence

// Regression tests for the 2026-04-21 Go audit — HIGH item H5
// (bare ExecContext on domain suppression + daily_send_cap updates in
// intelligence/domain.go).
//
// Pre-fix: a failed UPDATE SET is_suppressed = true was silently
// dropped, so the "domain suppressed" slog.Warn fired even though the
// row was still is_suppressed = false. The next tick of the outreach
// pipeline happily kept sending to the bad domain. Post-fix: the
// error is logged with "SEND GATE NOT APPLIED", and shouldFlag stays
// false so downstream metrics don't lie.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func captureSlogIntel(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return &buf
}

// Suppression UPDATE error must be logged with SEND GATE NOT APPLIED
// signal and flagged count must NOT increase for the failed row.
func TestCheckDomainHealth_SuppressionUpdateError_LogsGateMiss_H5(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := captureSlogIntel(t)

	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(77, "badmail.cz", 50, 20, 0, 0.40, 3, false))

	// is_suppressed UPDATE errors out — pre-fix silently dropped.
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnError(errors.New("serialization failure"))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil {
		t.Fatalf("CheckDomainHealth should NOT abort on UPDATE failure: %v", err)
	}
	if checked != 1 {
		t.Errorf("checked = %d, want 1", checked)
	}
	// Flagged MUST stay 0 because the suppression didn't actually happen.
	if flagged != 0 {
		t.Errorf("flagged = %d, want 0 — failed suppression must not count as flagged", flagged)
	}

	if !strings.Contains(buf.String(), "SEND GATE NOT APPLIED") {
		t.Errorf("expected 'SEND GATE NOT APPLIED' log; got: %s", buf.String())
	}
}

// Cap UPDATE failure logs a warning but does not affect flagged count.
func TestCheckDomainHealth_CapUpdateError_IsLogged_H5(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := captureSlogIntel(t)

	// Medium bounce rate branch: > 0.08 && < 0.15 with totalSent >= 10
	// → reduces cap, shouldFlag = true, then UPDATE cap.
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(88, "medium.cz", 30, 4, 0, 0.10, 4, false))

	mock.ExpectExec(`UPDATE outreach_domains SET daily_send_cap`).
		WillReturnError(errors.New("lock timeout"))

	_, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// flagged IS incremented because the decision to flag happened — only the
	// persistence failed, which we log separately.
	if flagged != 1 {
		t.Errorf("flagged = %d, want 1", flagged)
	}

	if !strings.Contains(buf.String(), "daily_send_cap update failed") {
		t.Errorf("expected cap-update warning; got: %s", buf.String())
	}
}

// Row scan error is logged and we move on — pre-fix the error was dropped
// and we'd read zero-valued fields silently.
func TestCheckDomainHealth_RowScanError_IsLoggedAndSkipped_H5(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := captureSlogIntel(t)

	// Return a row that has the wrong column types to force Scan to fail.
	// We intentionally produce a domain-type mismatch: string where
	// bounce_rate expects float.
	mock.ExpectQuery(`SELECT id, domain, total_sent`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "domain", "total_sent", "total_bounced", "total_complained",
			"bounce_rate", "daily_send_cap", "is_suppressed",
		}).AddRow(99, "scan.cz", 10, 1, 0, "not-a-number", 5, false))

	checked, flagged, err := CheckDomainHealth(context.Background(), db)
	if err != nil {
		t.Fatalf("should not propagate row-scan error: %v", err)
	}
	if checked != 0 {
		t.Errorf("checked = %d, want 0 (row was skipped)", checked)
	}
	if flagged != 0 {
		t.Errorf("flagged = %d, want 0", flagged)
	}

	if !strings.Contains(buf.String(), "domain-health row scan failed") {
		t.Errorf("expected row-scan log; got: %s", buf.String())
	}
}
