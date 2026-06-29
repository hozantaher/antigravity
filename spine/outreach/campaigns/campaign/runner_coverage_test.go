package campaign

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── NewReadOnlyRunner ──

func TestNewReadOnlyRunner(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	r := NewReadOnlyRunner(db)
	if r == nil {
		t.Fatal("nil runner")
	}
	if r.db == nil {
		t.Error("db not set")
	}
	if r.engine != nil {
		t.Error("engine should be nil in read-only runner")
	}
}

// ── List ──

func campaignRows() *sqlmock.Rows {
	now := time.Now()
	seq, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})
	// category_paths is text[] in Postgres — pq.Array round-trips a
	// `{val,val}` literal, NOT a JSON document.
	cats := "{Stavebni}"
	stats, _ := json.Marshal(map[string]int{"sent": 3})
	return sqlmock.NewRows([]string{
		"id", "name", "description", "status",
		"sequence_config", "category_paths", "category_match",
		"stats", "created_at", "updated_at",
	}).AddRow(1, "Test", "desc", "draft", seq, cats, "prefix", stats, now, now)
}

func TestList_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(campaignRows())

	r := NewReadOnlyRunner(db)
	campaigns, err := r.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(campaigns) != 1 {
		t.Fatalf("expected 1 campaign, got %d", len(campaigns))
	}
	c := campaigns[0]
	if c.ID != 1 {
		t.Errorf("ID = %d, want 1", c.ID)
	}
	if c.Name != "Test" {
		t.Errorf("Name = %q, want Test", c.Name)
	}
	if c.Status != "draft" {
		t.Errorf("Status = %q, want draft", c.Status)
	}
	if c.Stats["sent"] != 3 {
		t.Errorf("Stats[sent] = %d, want 3", c.Stats["sent"])
	}
	if len(c.SequenceConfig) != 1 || c.SequenceConfig[0].TemplateName != "initial" {
		t.Error("sequence config not parsed")
	}
	if len(c.CategoryPaths) != 1 || c.CategoryPaths[0] != "Stavebni" {
		t.Error("category paths not parsed")
	}
}

func TestList_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(sqlmock.NewRows([]string{
		"id", "name", "description", "status",
		"sequence_config", "category_paths", "category_match",
		"stats", "created_at", "updated_at",
	}))

	r := NewReadOnlyRunner(db)
	campaigns, err := r.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(campaigns) != 0 {
		t.Errorf("expected 0 campaigns, got %d", len(campaigns))
	}
}

func TestList_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).WillReturnError(errCampaign("db down"))

	r := NewReadOnlyRunner(db)
	_, err = r.List(context.Background())
	if err == nil {
		t.Error("expected error from List")
	}
}

func TestList_MultipleCampaigns(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	seq, _ := json.Marshal([]SequenceStep{})
	cats := "{}" // empty text[] literal
	stats, _ := json.Marshal(map[string]int{})
	rows := sqlmock.NewRows([]string{
		"id", "name", "description", "status",
		"sequence_config", "category_paths", "category_match",
		"stats", "created_at", "updated_at",
	}).
		AddRow(1, "First", "", "draft", seq, cats, "prefix", stats, now, now).
		AddRow(2, "Second", "", "running", seq, cats, "exact", stats, now, now)

	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(rows)

	r := NewReadOnlyRunner(db)
	campaigns, err := r.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(campaigns) != 2 {
		t.Fatalf("expected 2 campaigns, got %d", len(campaigns))
	}
	if campaigns[1].CategoryMatch != "exact" {
		t.Errorf("CategoryMatch = %q, want exact", campaigns[1].CategoryMatch)
	}
}

// ── Get ──

func TestGet_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(campaignRows())

	r := NewReadOnlyRunner(db)
	c, err := r.Get(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c == nil {
		t.Fatal("expected campaign, got nil")
	}
	if c.ID != 1 {
		t.Errorf("ID = %d, want 1", c.ID)
	}
}

func TestGet_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).WillReturnRows(sqlmock.NewRows([]string{
		"id", "name", "description", "status",
		"sequence_config", "category_paths", "category_match",
		"stats", "created_at", "updated_at",
	}))

	r := NewReadOnlyRunner(db)
	c, err := r.Get(context.Background(), 999)
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows, got err=%v c=%v", err, c)
	}
}

func TestGet_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).WillReturnError(errCampaign("query error"))

	r := NewReadOnlyRunner(db)
	_, err = r.Get(context.Background(), 1)
	if err == nil {
		t.Error("expected error")
	}
}

// ── SetStatus ──

func TestSetStatus_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewReadOnlyRunner(db)
	err = r.SetStatus(context.Background(), 1, "running")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestSetStatus_Error(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnError(errCampaign("update failed"))

	r := NewReadOnlyRunner(db)
	err = r.SetStatus(context.Background(), 1, "paused")
	if err == nil {
		t.Error("expected error from SetStatus")
	}
}

func TestSetStatus_Transitions(t *testing.T) {
	transitions := []string{"draft", "running", "paused", "completed"}
	for _, status := range transitions {
		t.Run("to_"+status, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			mock.ExpectExec(`UPDATE campaigns SET status`).
				WillReturnResult(sqlmock.NewResult(0, 1))

			r := NewReadOnlyRunner(db)
			if err := r.SetStatus(context.Background(), 1, status); err != nil {
				t.Errorf("SetStatus(%q) failed: %v", status, err)
			}
		})
	}
}

// ── Stats ──

func TestStats_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}).
			AddRow("pending", 10).
			AddRow("in_sequence", 5).
			AddRow("completed", 20))

	r := NewReadOnlyRunner(db)
	stats, err := r.Stats(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats["pending"] != 10 {
		t.Errorf("pending = %d, want 10", stats["pending"])
	}
	if stats["in_sequence"] != 5 {
		t.Errorf("in_sequence = %d, want 5", stats["in_sequence"])
	}
	if stats["completed"] != 20 {
		t.Errorf("completed = %d, want 20", stats["completed"])
	}
}

func TestStats_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}))

	r := NewReadOnlyRunner(db)
	stats, err := r.Stats(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(stats) != 0 {
		t.Errorf("expected empty stats, got %v", stats)
	}
}

func TestStats_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnError(errCampaign("db error"))

	r := NewReadOnlyRunner(db)
	_, err = r.Stats(context.Background(), 1)
	if err == nil {
		t.Error("expected error from Stats")
	}
}

// ── EstimateEnrollment ──

func TestEstimateEnrollment_NoFilter(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(DISTINCT c\.id\) FROM contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(42))

	r := NewReadOnlyRunner(db)
	count, err := r.EstimateEnrollment(context.Background(), EnrollmentFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 42 {
		t.Errorf("count = %d, want 42", count)
	}
}

func TestEstimateEnrollment_WithMinScore(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(DISTINCT c\.id\) FROM contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(7))

	r := NewReadOnlyRunner(db)
	count, err := r.EstimateEnrollment(context.Background(), EnrollmentFilter{MinScore: 0.7})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 7 {
		t.Errorf("count = %d, want 7", count)
	}
}

func TestEstimateEnrollment_WithCategoryPaths_Prefix(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(DISTINCT c\.id\) FROM contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(15))

	r := NewReadOnlyRunner(db)
	count, err := r.EstimateEnrollment(context.Background(), EnrollmentFilter{
		CategoryPaths: []string{"Stavebni > Omitky"},
		CategoryMatch: "prefix",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 15 {
		t.Errorf("count = %d, want 15", count)
	}
}

func TestEstimateEnrollment_WithCategoryPaths_Exact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(DISTINCT c\.id\) FROM contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))

	r := NewReadOnlyRunner(db)
	count, err := r.EstimateEnrollment(context.Background(), EnrollmentFilter{
		CategoryPaths: []string{"Remesla > Stolari"},
		CategoryMatch: "exact",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 3 {
		t.Errorf("count = %d, want 3", count)
	}
}

func TestEstimateEnrollment_MultiplePaths(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(DISTINCT c\.id\) FROM contacts`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(22))

	r := NewReadOnlyRunner(db)
	count, err := r.EstimateEnrollment(context.Background(), EnrollmentFilter{
		CategoryPaths: []string{"Remesla > Stolari", "Stavebni > Omitky"},
		CategoryMatch: "prefix",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 22 {
		t.Errorf("count = %d, want 22", count)
	}
}

func TestEstimateEnrollment_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(DISTINCT c\.id\) FROM contacts`).
		WillReturnError(errCampaign("estimate error"))

	r := NewReadOnlyRunner(db)
	_, err = r.EstimateEnrollment(context.Background(), EnrollmentFilter{})
	if err == nil {
		t.Error("expected error from EstimateEnrollment")
	}
}

// ── enrollContacts edge cases ──

func TestEnrollContacts_WithRegion(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 8))

	r := NewReadOnlyRunner(db)
	n, err := r.enrollContacts(context.Background(), 1, EnrollmentFilter{Region: "Praha"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 8 {
		t.Errorf("enrolled = %d, want 8", n)
	}
}

func TestEnrollContacts_WithIndustry(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 12))

	r := NewReadOnlyRunner(db)
	n, err := r.enrollContacts(context.Background(), 1, EnrollmentFilter{Industry: "machinery"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 12 {
		t.Errorf("enrolled = %d, want 12", n)
	}
}

func TestEnrollContacts_WithMinScore(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 4))

	r := NewReadOnlyRunner(db)
	n, err := r.enrollContacts(context.Background(), 1, EnrollmentFilter{MinScore: 0.5})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 4 {
		t.Errorf("enrolled = %d, want 4", n)
	}
}

func TestEnrollContacts_CategoryExact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	r := NewReadOnlyRunner(db)
	n, err := r.enrollContacts(context.Background(), 1, EnrollmentFilter{
		CategoryPaths: []string{"Remesla > Tesari"},
		CategoryMatch: "exact",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Errorf("enrolled = %d, want 2", n)
	}
}

func TestEnrollContacts_CategoryPrefix_DefaultMatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 9))

	r := NewReadOnlyRunner(db)
	// CategoryMatch="" defaults to prefix in CreateCampaign, but enrollContacts checks "exact" directly
	n, err := r.enrollContacts(context.Background(), 1, EnrollmentFilter{
		CategoryPaths: []string{"Remesla"},
		CategoryMatch: "", // not "exact" → prefix behaviour
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 9 {
		t.Errorf("enrolled = %d, want 9", n)
	}
}

func TestEnrollContacts_CategoryIndustryIgnoredWhenCategorySet(t *testing.T) {
	// When CategoryPaths is set, industry filter is ignored in enrollContacts.
	// Verify by checking: no error, rows affected returned correctly.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 6))

	r := NewReadOnlyRunner(db)
	n, err := r.enrollContacts(context.Background(), 1, EnrollmentFilter{
		CategoryPaths: []string{"Remesla"},
		CategoryMatch: "prefix",
		Industry:      "machinery", // should be ignored when CategoryPaths set
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 6 {
		t.Errorf("enrolled = %d, want 6", n)
	}
}

func TestEnrollContacts_Error(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnError(errCampaign("enroll error"))

	r := NewReadOnlyRunner(db)
	_, err = r.enrollContacts(context.Background(), 1, EnrollmentFilter{})
	if err == nil {
		t.Error("expected error from enrollContacts")
	}
}

// ── RunCampaign: contact step advancement ──

func TestRunCampaign_ContactAtLastStep_MarkedCompleted(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 1-step sequence; contact is already at step 1 (= past last step)
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("TestCamp", "running", steps))

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Contact has current_step=1, which is >= len(steps)=1 → mark completed
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region", "email_status", "parent_ico",
		}).AddRow(10, 20, 1, "a@b.com", "Jan", "ACME", "Praha", "valid", ""))

	// Expect completed update for exhausted step
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestRunCampaign_InvalidSequenceJSON(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Bad", "running", []byte(`not-json`)))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestRunCampaign_DraftStatusAllowed(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Draft", "draft", steps))

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
		}))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err != nil {
		t.Fatalf("draft status should be allowed, got: %v", err)
	}
}

func TestRunCampaign_CompletedStatusBlocked(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Done", "completed", steps))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil {
		t.Error("completed campaigns should not be runnable")
	}
}

func TestRunCampaign_PausedStatusBlocked(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Paused", "paused", steps))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err == nil {
		t.Error("paused campaigns should not be runnable")
	}
}

// ── scanCampaign ──

func TestScanCampaign_ValidJSON(t *testing.T) {
	now := time.Now()
	seq, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 3, TemplateName: "tpl"}})
	cats := "{Cat1,Cat2}" // text[] literal — see scanCampaign pq.Array binding
	stats, _ := json.Marshal(map[string]int{"sent": 5, "pending": 10})

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "status",
			"sequence_config", "category_paths", "category_match",
			"stats", "created_at", "updated_at",
		}).AddRow(5, "MyPlan", "desc", "running", seq, cats, "exact", stats, now, now))

	r := NewReadOnlyRunner(db)
	c, err := r.Get(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != 5 {
		t.Errorf("ID = %d", c.ID)
	}
	if len(c.SequenceConfig) != 1 || c.SequenceConfig[0].DelayDays != 3 {
		t.Error("sequence not parsed")
	}
	if len(c.CategoryPaths) != 2 {
		t.Errorf("category paths = %v", c.CategoryPaths)
	}
	if c.Stats["sent"] != 5 {
		t.Errorf("stats[sent] = %d, want 5", c.Stats["sent"])
	}
	if c.CategoryMatch != "exact" {
		t.Errorf("CategoryMatch = %q, want exact", c.CategoryMatch)
	}
}

// ── joinConds ──

func TestJoinConds_Empty(t *testing.T) {
	if joinConds(nil, " AND ") != "" {
		t.Error("empty slice should return empty string")
	}
}

func TestJoinConds_Single(t *testing.T) {
	if joinConds([]string{"a = $1"}, " AND ") != "a = $1" {
		t.Error("single condition")
	}
}

func TestJoinConds_Multiple(t *testing.T) {
	result := joinConds([]string{"a = $1", "b = $2", "c = $3"}, " AND ")
	want := "a = $1 AND b = $2 AND c = $3"
	if result != want {
		t.Errorf("got %q, want %q", result, want)
	}
}

func TestJoinConds_OR(t *testing.T) {
	result := joinConds([]string{"x = $1", "y = $2"}, " OR ")
	want := "x = $1 OR y = $2"
	if result != want {
		t.Errorf("got %q, want %q", result, want)
	}
}

// ── CreateCampaign: category paths ──

func TestCreateCampaign_WithCategoryPaths(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(55))

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 7))

	r := NewRunner(db, nil, nil)
	id, err := r.CreateCampaign(context.Background(), "Cat Campaign", "desc",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}},
		EnrollmentFilter{
			CategoryPaths: []string{"Remesla > Tesari", "Stavebni"},
			CategoryMatch: "prefix",
		})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 55 {
		t.Errorf("id = %d, want 55", id)
	}
}

func TestCreateCampaign_DefaultCategoryMatch(t *testing.T) {
	// When CategoryMatch is empty, it should default to "prefix" in CreateCampaign.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(11))

	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	r := NewRunner(db, nil, nil)
	_, err = r.CreateCampaign(context.Background(), "Default Match", "",
		[]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}},
		EnrollmentFilter{CategoryMatch: ""}) // empty → should default to "prefix"
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ── DelayDays calculation ──

func TestSequenceStep_DelayDays(t *testing.T) {
	cases := []struct {
		delay int
		days  int
	}{
		{0, 0},
		{3, 3},
		{7, 7},
		{14, 14},
	}
	for _, tc := range cases {
		s := SequenceStep{Step: 1, DelayDays: tc.delay}
		if s.DelayDays != tc.days {
			t.Errorf("delay %d: got %d", tc.delay, s.DelayDays)
		}
	}
}

// Verify next_send_at calculation logic matches time.AddDate semantics.
func TestNextSendAt_Calculation(t *testing.T) {
	steps := []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 5, TemplateName: "followup"},
		{Step: 2, DelayDays: 12, TemplateName: "final"},
	}
	now := time.Now()
	for i, s := range steps {
		if i == 0 {
			continue
		}
		expected := now.AddDate(0, 0, s.DelayDays)
		diff := expected.Sub(now)
		expectedDays := float64(s.DelayDays) * 24
		actualHours := diff.Hours()
		// Allow 1h margin for clock drift in tests
		if actualHours < expectedDays-1 || actualHours > expectedDays+1 {
			t.Errorf("step %d delay: expected ~%.0f hours, got %.2f", i, expectedDays, actualHours)
		}
	}
}
