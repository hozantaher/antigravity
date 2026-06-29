package campaign

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// TestRunCampaign_AcceptsActiveStatus locks the contract that 'active' is a
// runnable status. Background: the dashboard BFF (server.js) sets
// status='active' on the Activate button. scheduler_postgres.go
// ListRunningCampaigns picks up campaigns whose status is in
// ('running','active'). If RunCampaign rejects 'active', every
// scheduler tick lists the campaign, calls RunCampaign, and immediately
// errors — generating an error log on every tick while the campaign
// silently never sends.
func TestRunCampaign_AcceptsActiveStatus(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Active Campaign", "active", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc\.id, cc\.contact_id, cc\.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("'active' must be a runnable status — runner rejected: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestRunCampaign_RejectsTerminalStatus locks the negative case — paused,
// completed, archived must remain non-runnable. Catches an over-eager
// permissive change to the gate.
func TestRunCampaign_RejectsTerminalStatus(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	for _, status := range []string{"paused", "completed", "archived", "stopped"} {
		t.Run(status, func(t *testing.T) {
			db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}})
			mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
				WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
					AddRow("X", status, steps))

			r := NewRunner(db, nil, nil)
			err = r.RunCampaign(context.Background(), 1)
			if err == nil {
				t.Errorf("status=%q should be rejected as non-runnable", status)
			}
		})
	}
}

// TestRunCampaign_StartedAtSetOnceOnly locks the COALESCE semantic: the
// runner must not bump started_at on every tick. Previously the SQL was
// `started_at = now()` unconditionally, so the dashboard's "campaign
// started" timestamp showed the LAST tick start, not the actual first
// activation. Discipline test reads runner.go and asserts COALESCE wraps
// started_at in the status UPDATE.
func TestRunCampaign_StartedAtSetOnceOnly(t *testing.T) {
	src, err := os.ReadFile("runner.go")
	if err != nil {
		t.Skipf("cannot read runner.go: %v", err)
	}
	body := string(src)
	idx := strings.Index(body, "UPDATE campaigns SET status = 'running'")
	if idx < 0 {
		t.Fatal("status-update SQL not found in runner.go — refactor likely")
	}
	// Take ~200 chars of context starting at the UPDATE.
	end := idx + 200
	if end > len(body) {
		end = len(body)
	}
	stmt := body[idx:end]
	if !strings.Contains(stmt, "COALESCE(started_at, now())") {
		t.Errorf("status UPDATE must use COALESCE(started_at, now()) so first-tick timestamp is preserved across subsequent ticks; got:\n%s", stmt)
	}
	if strings.Contains(stmt, "started_at = now()") &&
		!strings.Contains(stmt, "COALESCE(started_at, now())") {
		t.Error("unconditional `started_at = now()` resets timestamp on every tick — operator dashboards lose real activation time")
	}
}
