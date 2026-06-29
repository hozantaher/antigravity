package campaign

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RunCampaign via sqlmock ──

func TestRunCampaign_LoadError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnError(errCampaign("no rows"))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil { t.Error("expected error when campaign load fails") }
}

func TestRunCampaign_NotRunning(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Test Campaign", "paused", steps))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil { t.Error("expected error for non-running campaign") }
}

func TestRunCampaign_WeekendSkip(t *testing.T) {
	// Set SKIP_CALENDAR_CHECK to avoid weekend skip in CI
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	// Expect campaign load
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Campaign", "running", steps))

	// Expect campaign status update
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Expect contact query — returns empty (no pending contacts)
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
		}))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err != nil { t.Errorf("unexpected error: %v", err) }

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestRunCampaign_QueryContactsError(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Campaign", "draft", steps))

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnError(errCampaign("query error"))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil { t.Error("expected error from contact query") }
}

// ── CreateCampaign via sqlmock ──

func TestCreateCampaign_InsertError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnError(errCampaign("insert failed"))

	r := NewRunner(db, nil, nil)
	_, err = r.CreateCampaign(context.Background(), "Test", "", []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
	}, EnrollmentFilter{})
	if err == nil { t.Error("expected error from INSERT") }
}

func TestCreateCampaign_EnrollError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnError(errCampaign("enroll failed"))

	r := NewRunner(db, nil, nil)
	_, err = r.CreateCampaign(context.Background(), "Test", "", []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
	}, EnrollmentFilter{})
	if err == nil { t.Error("expected error from enroll INSERT") }
}

func TestCreateCampaign_WithFilters(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(10))

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	r := NewRunner(db, nil, nil)
	id, err := r.CreateCampaign(context.Background(), "Filtered", "", []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "step0"},
	}, EnrollmentFilter{Region: "Praha", Industry: "machinery", MinScore: 0.7})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if id != 10 { t.Errorf("campaign id = %d, want 10", id) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

func TestCreateCampaign_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(99))

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 100))

	r := NewRunner(db, nil, nil)
	id, err := r.CreateCampaign(context.Background(), "Big Campaign", "", []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 5, TemplateName: "followup"},
	}, EnrollmentFilter{})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if id != 99 { t.Errorf("campaign id = %d, want 99", id) }
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet sqlmock expectations: %v", err)
	}
}

// TestRunCampaign_ContactPastFinalStep_MarkedCompleted catches the
// `currentStep >= len(steps)` boundary mutations (`>= → <=`, `< → >`).
// A contact with currentStep == len(steps) must be SET to 'completed'
// without calling content.Render or engine.Enqueue (nil would panic).
func TestRunCampaign_ContactPastFinalStep_MarkedCompleted(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// 1-step campaign; contact has currentStep=2 (> len(steps)=1).
	// Using 2 > 1 rather than 1 == 1 so mutations >=/<=  produce different outcomes:
	//   original `>= 1`: 2 >= 1 = true → completed (correct)
	//   mutation `<= 1`: 2 <= 1 = false → tries steps[2] → index panic → test fails
	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Step Boundary", "running", steps))

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region", "email_status", "parent_ico",
		}).AddRow(77, 200, 2, "jan@firma.cz", "Jan", "Firma s.r.o.", "Praha", "valid", ""))

	// Must UPDATE contact to 'completed' — not call Render (nil engine panics).
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(77)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("SQL expectations not met: %v", err)
	}
}

type errCampaign string
func (e errCampaign) Error() string { return string(e) }
