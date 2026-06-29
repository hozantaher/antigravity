package campaign

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"common/config"
	"campaigns/content"
	"campaigns/sender"
)

// makeTemplateDir creates a temp dir with a minimal .tmpl file.
func makeTemplateDir(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/" + name + ".tmpl"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestRunCampaign_FullEnqueue exercises the render+enqueue path with a real
// content engine and sender engine. Contact is at step 0 of a 2-step campaign
// so nextSendAt is set → UPDATE with in_sequence status.
func TestRunCampaign_FullEnqueue(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	dir := makeTemplateDir(t, "step0", "Subject: Hello {{.Jmeno}}\n\nBody for {{.Firma}}")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 2-step campaign so step 0 has a next step → nextSendAt is set
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
		{Step: 1, DelayDays: 3, TemplateName: "step0"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Enqueue Test", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(50), int64(100), 0, "jan@firma.cz", "Jan", "Firma s.r.o.", "Praha", "valid", ""))

	// After successful render+enqueue: UPDATE to in_sequence with next_send_at
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	sendEngine := sender.NewEngine(
		[]config.MailboxConfig{{Address: "from@firma.cz"}},
		config.SendingConfig{MaxPerDomainHour: 100},
		config.SafetyConfig{},
	)

	r := NewRunner(db, contentEngine, sendEngine)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// TestRunCampaign_FullEnqueue_LastStep covers the single-step campaign path:
// after enqueue, nextStep >= len(steps) → UPDATE with completed status.
func TestRunCampaign_FullEnqueue_LastStep(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	dir := makeTemplateDir(t, "only", "Subject: Hi\n\nBody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Single-step campaign → nextStep=1 >= len(steps)=1 → completed
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "only"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Single Step", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(60), int64(200), 0, "ana@test.cz", "Ana", "Test s.r.o.", "Brno", "valid", ""))

	// Last step → UPDATE with completed (no next_send_at)
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	sendEngine := sender.NewEngine(
		[]config.MailboxConfig{{Address: "from@firma.cz"}},
		config.SendingConfig{},
		config.SafetyConfig{},
	)

	r := NewRunner(db, contentEngine, sendEngine)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// TestRunCampaign_RenderError covers the content.Render failure path.
func TestRunCampaign_RenderError(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	// Point engine at empty dir so Render fails (template not found)
	dir := t.TempDir()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "missing_template"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Render Fail", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(70), int64(300), 0, "x@test.cz", "X", "Test", "Praha", "valid", ""))

	contentEngine := content.NewEngine(dir, nil)
	sendEngine := sender.NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	r := NewRunner(db, contentEngine, sendEngine)
	// Render fails → slog.Error + continue → no error returned from RunCampaign
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign should not error on render failure: %v", err)
	}
}

// TestRunCampaign_ScanError covers the rows.Scan error path.
func TestRunCampaign_ScanError(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "t"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Scan Fail", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Return row with too few columns → Scan will fail
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(99)))

	r := NewRunner(db, nil, nil)
	// scan error → slog.Error + continue → no error returned
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign should not error on scan failure: %v", err)
	}
}
