package campaign

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"common/config"
	"campaigns/content"
	"campaigns/sender"
)

// TestRunCampaign_StopsOnMidTickPause locks the cooperative pause-detection
// contract: when the campaign's status flips from 'running' to 'paused'
// while a tick is still in flight, the runner must stop enqueueing further
// contacts within the next statusCheckEvery iterations.
//
// Background: a UI Pause click sets campaigns.status='paused' immediately,
// but the runner's contact loop reads the status only at tick start. With
// LIMIT 500, that means up to 500 emails can be queued AFTER the operator
// clicks Pause. The runner now re-reads campaigns.status every
// statusCheckEvery enqueued contacts and breaks the loop on a transition
// to a non-running/non-draft status.
//
// Test fixture: 25 contacts. Mock returns 'paused' on the first mid-tick
// status check (after 10 enqueues). Verify only 10 advance UPDATEs ran —
// the remaining 15 contacts must NOT be processed.
func TestRunCampaign_StopsOnMidTickPause(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	dir := makeTemplateDir(t, "step0", "Subject: Hi\n\nBody for {{.Firma}}")

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Pause Race", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 25 contacts ready to send. statusCheckEvery=10, so the runner
	// re-checks after enqueue 10 (and would re-check at 20 if still
	// running). We return 'paused' on the first re-check, so only 10
	// contacts get the advance UPDATE.
	rows := sqlmock.NewRows(contactCols)
	for i := 1; i <= 25; i++ {
		rows.AddRow(int64(i), int64(1000+i), 0,
			fmt.Sprintf("c%d@firma%d.cz", i, i),
			fmt.Sprintf("Jan%d", i),
			fmt.Sprintf("Firma %d", i),
			"Praha", "valid", "")
	}
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(rows)

	// First 10 enqueues: each fires an advance UPDATE. After the 10th,
	// the runner's mid-tick check reads campaigns.status — we return
	// 'paused' so the loop breaks and no further UPDATEs run.
	for i := 0; i < statusCheckEvery; i++ {
		mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
			WillReturnResult(sqlmock.NewResult(0, 1))
	}

	// Mid-tick status check returns 'paused'.
	mock.ExpectQuery(`SELECT status FROM campaigns WHERE id`).
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("paused"))

	// Per-tick audit row (enqueued > 0).
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	sendEngine := sender.NewEngine(
		[]config.MailboxConfig{{Address: "from@firma.cz"}},
		config.SendingConfig{MaxPerDomainHour: 1000},
		config.SafetyConfig{},
	)

	r := NewRunner(db, contentEngine, sendEngine)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met (would indicate either too many contacts processed past the pause, or too few): %v", err)
	}
}

// TestRunCampaign_ContinuesIfStatusStillRunning verifies the cooperative
// check does NOT halt the loop when the campaign is still running. With
// 12 contacts and statusCheckEvery=10, the check fires once at enqueue=10
// and returns 'running' — the remaining 2 contacts must still be enqueued.
func TestRunCampaign_ContinuesIfStatusStillRunning(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	dir := makeTemplateDir(t, "step0", "Subject: Hi\n\nBody for {{.Firma}}")

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Still Running", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows := sqlmock.NewRows(contactCols)
	for i := 1; i <= 12; i++ {
		rows.AddRow(int64(i), int64(2000+i), 0,
			fmt.Sprintf("c%d@firma%d.cz", i, i),
			fmt.Sprintf("Jan%d", i),
			fmt.Sprintf("Firma %d", i),
			"Praha", "valid", "")
	}
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(rows)

	// First 10 advances.
	for i := 0; i < statusCheckEvery; i++ {
		mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
			WillReturnResult(sqlmock.NewResult(0, 1))
	}

	// Status re-check: still running.
	mock.ExpectQuery(`SELECT status FROM campaigns WHERE id`).
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("running"))

	// Remaining 2 advances must still run.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	sendEngine := sender.NewEngine(
		[]config.MailboxConfig{{Address: "from@firma.cz"}},
		config.SendingConfig{MaxPerDomainHour: 1000},
		config.SafetyConfig{},
	)

	r := NewRunner(db, contentEngine, sendEngine)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("all 12 contacts should have been processed: %v", err)
	}
}

// TestRunCampaign_StatusCheckQueryFailureFailsOpen — a transient DB error
// on the mid-tick status re-check must not stall the tick. The runner logs
// and continues; the next tick will re-evaluate. Encodes the fail-open
// contract documented in runner.go.
func TestRunCampaign_StatusCheckQueryFailureFailsOpen(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	dir := makeTemplateDir(t, "step0", "Subject: Hi\n\nBody for {{.Firma}}")

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Fail Open", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rows := sqlmock.NewRows(contactCols)
	for i := 1; i <= 12; i++ {
		rows.AddRow(int64(i), int64(3000+i), 0,
			fmt.Sprintf("c%d@firma%d.cz", i, i),
			fmt.Sprintf("Jan%d", i),
			fmt.Sprintf("Firma %d", i),
			"Praha", "valid", "")
	}
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(rows)

	for i := 0; i < statusCheckEvery; i++ {
		mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
			WillReturnResult(sqlmock.NewResult(0, 1))
	}

	// Status re-check fails — runner must continue.
	mock.ExpectQuery(`SELECT status FROM campaigns WHERE id`).
		WillReturnError(fmt.Errorf("connection reset by peer"))

	// Remaining 2 contacts still processed.
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	sendEngine := sender.NewEngine(
		[]config.MailboxConfig{{Address: "from@firma.cz"}},
		config.SendingConfig{MaxPerDomainHour: 1000},
		config.SafetyConfig{},
	)

	r := NewRunner(db, contentEngine, sendEngine)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met: %v", err)
	}
}

// TestRunCampaign_NoStatusCheckUnderThreshold — guards that small ticks
// (< statusCheckEvery contacts) NEVER fire the mid-tick status query.
// This is the property that keeps the existing sqlmock test suite green
// without per-test edits. Discipline test: read runner.go and confirm
// the threshold guard.
func TestRunCampaign_NoStatusCheckUnderThreshold(t *testing.T) {
	src, err := os.ReadFile("runner.go")
	if err != nil {
		t.Skipf("cannot read runner.go: %v", err)
	}
	body := string(src)
	// Guard pattern: re-check only fires when enqueued > 0 AND a multiple
	// of statusCheckEvery. Without these conditions, every contact would
	// trigger a status query — too costly + would break every existing
	// fixture-based test.
	if !strings.Contains(body, "enqueued > 0") {
		t.Errorf("runner.go missing `enqueued > 0` guard on status re-check — small ticks will hit the DB unnecessarily")
	}
	if !strings.Contains(body, "statusCheckEvery") {
		t.Errorf("runner.go missing statusCheckEvery threshold reference")
	}
}
