// Z3-B: tests for cron_bounce_rate_monitor.go.

package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── 1: above-threshold mailbox is paused + audit emitted ──

func TestBounceRateMonitor_PausesAndAuditsAboveThreshold(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`WITH recent AS`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "hard_bounces", "soft_bounces", "bounces", "total", "rate"}).
			AddRow("mb1@seznam.cz", 4, 1, 5, 50, 0.10))

	mock.ExpectQuery(`UPDATE outreach_mailboxes\s+SET status='paused'`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// Dedup path: lookup mailbox id, then check dedup, then insert alert.
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes WHERE from_address`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunBounceRateMonitorOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunBounceRateMonitorOnce: %v", err)
	}
	if res.Paused != 1 {
		t.Errorf("Paused = %d, want 1", res.Paused)
	}
	if res.AlertsEmitted != 1 {
		t.Errorf("AlertsEmitted = %d, want 1", res.AlertsEmitted)
	}
}

// ── 2: under threshold → query returns no rows → no pause ──

func TestBounceRateMonitor_BelowThresholdNoOp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`WITH recent AS`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "hard_bounces", "soft_bounces", "bounces", "total", "rate"}))

	res, err := RunBounceRateMonitorOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunBounceRateMonitorOnce: %v", err)
	}
	if res.Paused != 0 || res.AlertsEmitted != 0 {
		t.Errorf("expected zero pause/alerts, got %+v", res)
	}
}

// ── 3: already-paused mailbox (UPDATE RETURNING → no rows) — alert still dedup'd ──

func TestBounceRateMonitor_AlreadyPausedStillEmitsDedupedAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`WITH recent AS`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "hard_bounces", "soft_bounces", "bounces", "total", "rate"}).
			AddRow("mb2@seznam.cz", 5, 0, 5, 50, 0.10))
	// UPDATE ... RETURNING id with no matching row → Scan returns sql.ErrNoRows.
	mock.ExpectQuery(`UPDATE outreach_mailboxes\s+SET status='paused'`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	// Alert dedup path still runs.
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(8)))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true)) // already alerted
	// No INSERT into mailbox_alerts — dedup'd.

	res, err := RunBounceRateMonitorOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunBounceRateMonitorOnce: %v", err)
	}
	if res.Paused != 0 {
		t.Errorf("Paused = %d, want 0 (was already paused)", res.Paused)
	}
	if res.AlertsEmitted != 0 {
		t.Errorf("AlertsEmitted = %d, want 0 (dedup'd)", res.AlertsEmitted)
	}
}

// ── 4: SQL error on aggregate query → wrapped error ──

func TestBounceRateMonitor_AggregateErrorWrapped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`WITH recent AS`).
		WillReturnError(errors.New("connection broken"))

	if _, err := RunBounceRateMonitorOnce(context.Background(), db, nil); err == nil {
		t.Fatal("expected error, got nil")
	} else if !strings.Contains(err.Error(), "query mailbox bounce rates") {
		t.Errorf("error not wrapped: %v", err)
	}
}

// ── 5: redactEmail correctly hides PII ──

func TestBounceRateMonitor_RedactEmailHidesLocalPart(t *testing.T) {
	got := redactEmail("operator-secret@seznam.cz")
	if !strings.HasPrefix(got, "ope") || !strings.HasSuffix(got, "@seznam.cz") {
		t.Errorf("redacted form unexpected: %q", got)
	}
	if strings.Contains(got, "operator-secret") {
		t.Errorf("redacted form leaked local-part: %q", got)
	}
}

// ── 6: redactEmail handles malformed input safely ──

func TestBounceRateMonitor_RedactEmailMalformedSafe(t *testing.T) {
	if redactEmail("notanemail") != "[redacted]" {
		t.Error("malformed address should return [redacted]")
	}
}

// ── 7: dedup window — alert insert skipped when open alert exists ──

func TestBounceRateMonitor_DedupSkipsDuplicateAlert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Set up sole pause path.
	mock.ExpectQuery(`WITH recent AS`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "hard_bounces", "soft_bounces", "bounces", "total", "rate"}).
			AddRow("mb3@seznam.cz", 5, 1, 6, 50, 0.12))
	mock.ExpectQuery(`UPDATE outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(9)))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// dedup path returns existing open alert
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(9)))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	// No INSERT INTO mailbox_alerts expected.

	res, err := RunBounceRateMonitorOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunBounceRateMonitorOnce: %v", err)
	}
	if res.AlertsEmitted != 0 {
		t.Errorf("AlertsEmitted = %d, want 0 (dedup'd)", res.AlertsEmitted)
	}
	if res.Paused != 1 {
		t.Errorf("Paused = %d, want 1 (pause still happened)", res.Paused)
	}
}

// ── 8: thresholds loaded from operator_settings (operatorconfig path) ──

func TestBounceRateMonitor_DefaultThresholdsWithNilLoader(t *testing.T) {
	crit, minV := LoadBounceRateMonitorThresholds(context.Background(), nil)
	if crit != defaultBounceRateCriticalThreshold {
		t.Errorf("critical = %f, want default", crit)
	}
	if minV != defaultMailboxMinVolumeForRateCheck {
		t.Errorf("minV = %d, want default", minV)
	}
}

// ── 9: multiple mailboxes — each processed independently ──

func TestBounceRateMonitor_MultipleMailboxes(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`WITH recent AS`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "hard_bounces", "soft_bounces", "bounces", "total", "rate"}).
			AddRow("a@seznam.cz", 3, 2, 5, 50, 0.10).
			AddRow("b@seznam.cz", 6, 0, 6, 50, 0.12))

	// mailbox A
	mock.ExpectQuery(`UPDATE outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(10)))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(10)))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).WillReturnResult(sqlmock.NewResult(1, 1))

	// mailbox B
	mock.ExpectQuery(`UPDATE outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(11)))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(11)))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).WillReturnResult(sqlmock.NewResult(1, 1))

	res, err := RunBounceRateMonitorOnce(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("RunBounceRateMonitorOnce: %v", err)
	}
	if res.Paused != 2 {
		t.Errorf("Paused = %d, want 2", res.Paused)
	}
	if res.AlertsEmitted != 2 {
		t.Errorf("AlertsEmitted = %d, want 2", res.AlertsEmitted)
	}
}

// ── 10: env gate respected — DISABLE_BOUNCE_RATE_MONITOR_CRON=1 → loop no-op ──

func TestBounceRateMonitor_DisableEnvGateRespected(t *testing.T) {
	t.Setenv("DISABLE_BOUNCE_RATE_MONITOR_CRON", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// nil DB — if loop ever ticks, it'll panic; the gate must stop it short.
	StartBounceRateMonitorLoop(ctx, nil, nil)
}

// ── 11: status_reason MUST start with "auto:" so the mailbox-healing
// daemon (cron_mailbox_healing.go EvaluateAutoResume) considers the
// pause platform-driven and can auto-resume once the bounce window
// clears. Sprint AA1 — historical bug: rows paused by this monitor
// stayed paused forever because the healing daemon treats non-"auto:"
// reasons as operator-intentional.

func TestBounceRateMonitor_StatusReasonHasAutoPrefix(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`WITH recent AS`).
		WillReturnRows(sqlmock.NewRows([]string{"mailbox_used", "hard_bounces", "soft_bounces", "bounces", "total", "rate"}).
			AddRow("mb1@seznam.cz", 4, 1, 5, 50, 0.10))

	// Assert that the UPDATE carries an "auto:" prefix in the reason
	// argument. sqlmock supports per-arg matchers via WithArgs.
	mock.ExpectQuery(`UPDATE outreach_mailboxes\s+SET status='paused'`).
		WithArgs(
			sqlmock.AnyArg(), // $1 = mailbox_used (from_address)
			autoPrefixMatcher{}, // $2 = reason — must start with "auto:"
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes WHERE from_address`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	mock.ExpectQuery(`SELECT EXISTS`).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`INSERT INTO mailbox_alerts`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	if _, err := RunBounceRateMonitorOnce(context.Background(), db, nil); err != nil {
		t.Fatalf("RunBounceRateMonitorOnce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock expectations not met: %v", err)
	}
}

// autoPrefixMatcher is a sqlmock.Argument matcher that asserts the
// string argument starts with "auto:". Implements sqlmock.Argument.
type autoPrefixMatcher struct{}

func (autoPrefixMatcher) Match(v driver.Value) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	return strings.HasPrefix(s, "auto:")
}

