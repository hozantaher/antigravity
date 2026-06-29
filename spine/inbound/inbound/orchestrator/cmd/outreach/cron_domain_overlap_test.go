// Sprint AH2 — tests for cron_domain_overlap.go.

package main

import (
	"context"
	"errors"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── 1: matched (campaign, domain) above threshold → alert + audit ──

func TestDomainOverlap_AboveThresholdEmitsAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Aggregate query returns one row above threshold.
	mock.ExpectQuery(`SELECT cc\.campaign_id`).
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id", "domain", "n"}).
			AddRow(int64(457), "renofarmy.cz", 12))

	// Dedup lookup → not seen.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	// Alert insert.
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// Audit insert (via audit.Log).
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunDomainOverlapOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDomainOverlapOnce: %v", err)
	}
	if res.Checked != 1 {
		t.Errorf("Checked = %d, want 1", res.Checked)
	}
	if res.AlertsEmitted != 1 {
		t.Errorf("AlertsEmitted = %d, want 1", res.AlertsEmitted)
	}
}

// ── 2: below threshold → query returns no rows → no alert ──

func TestDomainOverlap_BelowThresholdNoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT cc\.campaign_id`).
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id", "domain", "n"}))

	res, err := RunDomainOverlapOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDomainOverlapOnce: %v", err)
	}
	if res.Checked != 0 || res.AlertsEmitted != 0 {
		t.Errorf("expected zero overlap, got %+v", res)
	}
}

// ── 3: freemail domain → filtered, no alert ──

func TestDomainOverlap_FreemailFiltered(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// gmail.com would be a normal HAVING > N hit in any prod campaign;
	// the cron must skip it before emitting an alert.
	mock.ExpectQuery(`SELECT cc\.campaign_id`).
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id", "domain", "n"}).
			AddRow(int64(457), "gmail.com", 500))

	res, err := RunDomainOverlapOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDomainOverlapOnce: %v", err)
	}
	if res.AlertsEmitted != 0 {
		t.Errorf("AlertsEmitted = %d, want 0 (freemail filtered)", res.AlertsEmitted)
	}
	if res.Checked != 0 {
		t.Errorf("Checked = %d, want 0 (freemail filtered before count)", res.Checked)
	}
}

// ── 4: dedup window hit → no alert, no audit ──

func TestDomainOverlap_DedupWindowSuppressesAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT cc\.campaign_id`).
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id", "domain", "n"}).
			AddRow(int64(457), "iex.cz", 8))

	// Dedup lookup → already open alert.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	// No INSERT into mailbox_alerts, no audit row.

	res, err := RunDomainOverlapOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDomainOverlapOnce: %v", err)
	}
	if res.AlertsEmitted != 0 {
		t.Errorf("AlertsEmitted = %d, want 0 (dedup'd)", res.AlertsEmitted)
	}
}

// ── 5: multiple campaigns above threshold → multiple alerts ──

func TestDomainOverlap_MultipleCampaignsEmitMultipleAlerts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT cc\.campaign_id`).
		WillReturnRows(sqlmock.NewRows([]string{"campaign_id", "domain", "n"}).
			AddRow(int64(457), "renofarmy.cz", 12).
			AddRow(int64(458), "iex.cz", 7))

	// First (campaign, domain) — fresh.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Second — also fresh.
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunDomainOverlapOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunDomainOverlapOnce: %v", err)
	}
	if res.Checked != 2 {
		t.Errorf("Checked = %d, want 2", res.Checked)
	}
	if res.AlertsEmitted != 2 {
		t.Errorf("AlertsEmitted = %d, want 2", res.AlertsEmitted)
	}
}

// ── 6: aggregate query SQL error → wrapped + returned ──

func TestDomainOverlap_AggregateErrorReturned(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT cc\.campaign_id`).
		WillReturnError(errors.New("connection broken"))

	if _, err := RunDomainOverlapOnce(context.Background(), db, nil); err == nil {
		t.Fatal("expected wrapped error, got nil")
	}
}

// ── 7: helper — freemail set covers expected domains ──

func TestIsFreemailForOverlap_CoversCommon(t *testing.T) {
	cases := []struct {
		domain string
		want   bool
	}{
		{"gmail.com", true},
		{"seznam.cz", true},
		{"GMAIL.COM", true}, // case-insensitive
		{"  email.cz  ", true},
		{"renofarmy.cz", false},
		{"iex.cz", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := isFreemailForOverlap(tc.domain); got != tc.want {
			t.Errorf("isFreemailForOverlap(%q) = %v, want %v", tc.domain, got, tc.want)
		}
	}
}
