// Sprint AC6 — tests for cron_distribution_audit.go.
//
// Risk-proportional coverage: alert-emitting cron with state-mutating
// behaviour → 5 cases covering balanced, imbalanced, all-zero defence,
// env gate, single-mailbox guard.

package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── 1: balanced distribution (ratio below threshold) → no alert ──
func TestDistributionAudit_BalancedNoAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 3 mailboxes at 100/95/90 sends → ratio = (100-90)/100 = 0.10 (< 0.5).
	mock.ExpectQuery(`SELECT mailbox_used, count\(\*\) AS sends`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "sends"}).
			AddRow("mb1@seznam.cz", 100).
			AddRow("mb2@seznam.cz", 95).
			AddRow("mb3@seznam.cz", 90))

	res, err := RunDistributionAuditOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDistributionAuditOnce: %v", err)
	}
	if res.AlertEmitted {
		t.Errorf("AlertEmitted = true, want false (balanced ratio %.2f)", res.Ratio)
	}
	if res.MailboxCount != 3 {
		t.Errorf("MailboxCount = %d, want 3", res.MailboxCount)
	}
}

// ── 2: imbalanced distribution → cluster alert + audit row ──
func TestDistributionAudit_ImbalancedAlerts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 3 mailboxes at 100/50/10 → ratio = (100-10)/100 = 0.90 (> 0.5).
	mock.ExpectQuery(`SELECT mailbox_used, count\(\*\) AS sends`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "sends"}).
			AddRow("mb1@seznam.cz", 100).
			AddRow("mb2@seznam.cz", 50).
			AddRow("mb3@seznam.cz", 10))

	// Cluster alert path: dedup check (false) → INSERT cluster alert.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// Audit row.
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunDistributionAuditOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDistributionAuditOnce: %v", err)
	}
	if !res.AlertEmitted {
		t.Errorf("AlertEmitted = false, want true (ratio %.2f)", res.Ratio)
	}
	if res.MaxSends != 100 || res.MinSends != 10 {
		t.Errorf("MaxSends/MinSends = %d/%d, want 100/10", res.MaxSends, res.MinSends)
	}
}

// ── 3: single mailbox (no spread to measure) → no alert ──
func TestDistributionAudit_SingleMailboxNoAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT mailbox_used, count\(\*\) AS sends`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "sends"}).
			AddRow("mb1@seznam.cz", 100))

	res, err := RunDistributionAuditOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDistributionAuditOnce: %v", err)
	}
	if res.AlertEmitted {
		t.Errorf("AlertEmitted = true, want false (single mailbox)")
	}
	if res.MailboxCount != 1 {
		t.Errorf("MailboxCount = %d, want 1", res.MailboxCount)
	}
}

// ── 4: dedup window — existing alert blocks insert ──
func TestDistributionAudit_DedupSkipsExisting(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT mailbox_used, count\(\*\) AS sends`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "sends"}).
			AddRow("mb1@seznam.cz", 100).
			AddRow("mb2@seznam.cz", 10))

	// Dedup hit — no INSERT.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	// No INSERT INTO mailbox_alerts, no audit row.

	res, err := RunDistributionAuditOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDistributionAuditOnce: %v", err)
	}
	if res.AlertEmitted {
		t.Errorf("AlertEmitted = true, want false (dedup'd)")
	}
	// Ratio still computed for observability:
	if res.Ratio == 0 {
		t.Errorf("Ratio = 0, want >0 (dedup doesn't zero the computation)")
	}
}

// ── 5: env gate respected — DISABLE_DISTRIBUTION_AUDIT_CRON=1 → loop no-op ──
func TestDistributionAudit_DisableEnvGateRespected(t *testing.T) {
	t.Setenv("DISABLE_DISTRIBUTION_AUDIT_CRON", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// nil DB — gate must short-circuit before the loop touches DB.
	StartDistributionAuditLoop(ctx, nil, nil)
}

// ── 6: zero mailboxes (no rows) → no alert, no panic ──
func TestDistributionAudit_NoMailboxesNoAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT mailbox_used, count\(\*\) AS sends`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "sends"}))

	res, err := RunDistributionAuditOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDistributionAuditOnce: %v", err)
	}
	if res.MailboxCount != 0 {
		t.Errorf("MailboxCount = %d, want 0", res.MailboxCount)
	}
	if res.AlertEmitted {
		t.Error("AlertEmitted = true, want false (no mailboxes)")
	}
}

// ── 7: query error wrapped ──
func TestDistributionAudit_QueryErrorWrapped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT mailbox_used, count\(\*\) AS sends`).
		WillReturnError(errors.New("connection broken"))

	if _, err := RunDistributionAuditOnce(context.Background(), db, nil); err == nil {
		t.Fatal("expected error, got nil")
	} else if !strings.Contains(err.Error(), "query distribution audit") {
		t.Errorf("error not wrapped: %v", err)
	}
}

// ── 8: defaults when loader is nil ──
func TestDistributionAudit_DefaultThresholdWithNilLoader(t *testing.T) {
	got := LoadDistributionImbalanceThreshold(context.Background(), nil)
	if got != defaultDistributionImbalanceThreshold {
		t.Errorf("threshold = %f, want %f", got, defaultDistributionImbalanceThreshold)
	}
}
