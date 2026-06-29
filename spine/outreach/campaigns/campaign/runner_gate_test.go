package campaign

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// contactCols are the columns returned by RunCampaign's contact query.
var contactCols = []string{
	"id", "contact_id", "current_step", "email", "first_name", "company_name", "region",
	"email_status", "parent_ico",
}

func runnerWithOneStep(t *testing.T) ([]byte, func()) {
	t.Helper()
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})
	return steps, func() { os.Unsetenv("SKIP_CALENDAR_CHECK") }
}

func expectCampaignLoad(mock sqlmock.Sqlmock, steps []byte) {
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Gate Test Campaign", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
}

// TestRunCampaign_EmailStatusBlocked exercises the EmailStatusAllowed gate
// (line ~161 in runner.go): contacts with email_status != "valid" are skipped.
func TestRunCampaign_EmailStatusBlocked(t *testing.T) {
	steps, cleanup := runnerWithOneStep(t)
	defer cleanup()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	expectCampaignLoad(mock, steps)

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			// email_status="risky" → EmailStatusAllowed returns false → skipped
			AddRow(int64(10), int64(1), 0, "jan@firma.cz", "Jan", "Firma", "Praha", "risky", ""))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// TestRunCampaign_EmailStatusCatchAllBlocked validates catch_all is also blocked.
func TestRunCampaign_EmailStatusCatchAllBlocked(t *testing.T) {
	steps, cleanup := runnerWithOneStep(t)
	defer cleanup()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	expectCampaignLoad(mock, steps)

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(11), int64(2), 0, "jan@firma.cz", "Jan", "Firma", "Praha", "catch_all", ""))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestRunCampaign_HoldingClusterBlocked exercises the parent_ico dedup gate
// (line ~167): second contact with same parent_ico is blocked (HoldingClusterCap=1).
func TestRunCampaign_HoldingClusterBlocked(t *testing.T) {
	steps, cleanup := runnerWithOneStep(t)
	defer cleanup()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	expectCampaignLoad(mock, steps)

	// Two contacts with the same parent_ico — first has currentStep >= len(steps)
	// so it hits the "completed" path, second should be blocked by holding cluster gate.
	// Both contacts have email_status="" (not "valid") OR we can use currentStep >= steps.
	// Simpler: first contact has currentStep past end → marked completed (needs UPDATE mock).
	// Second contact with same parent_ico → blocked by holding cluster.
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			// First: email_status=valid, parent_ico="ICO123" → passes gate, steps exhausted → completed
			AddRow(int64(20), int64(10), 99, "a@firma.cz", "A", "Holding A", "Praha", "valid", "ICO123").
			// Second: same parent_ico → blocked (seenParentICO["ICO123"]=0+1=1 >= HoldingClusterCap=1... wait
			// Actually first one has step>=len(steps), so it goes to the completed branch, NOT incrementing seenParentICO.
			// Let me think... The seenParentICO is incremented at line 172-174 AFTER passing the holding gate check.
			// For contact with step>=len(steps), it hits "continue" before the gate check at line 167.
			// So I need the first contact to PASS both gates AND increment seenParentICO.
			// But if it passes gates AND has valid currentStep, it hits content.Render which is nil → panic.
			// Use email_status="risky" to skip before seenParentICO increment? No, that skip is before seenParentICO too.
			// Actually the seenParentICO increment is at line 172-174, AFTER the holding gate check (167-171).
			// So first contact must pass email gate AND holding gate to increment seenParentICO.
			// With nil content.Engine, we'd panic at Render.
			// Solution: both contacts have step>=len(steps) but the FIRST one has parentICO that won't be seen.
			// Actually that doesn't work either since we need seenParentICO["ICO123"] >= 1 for the second.
			// Real solution: let first contact pass all gates AND have step past the end (not calling Render).
			// But the past-end check is AFTER the gate checks. Let me re-read the code.
			// Line 161: if !EmailStatusAllowed → skip
			// Line 167: if parentICO != "" && seenParentICO >= Cap → skip
			// Line 172: if parentICO != "" { seenParentICO[parentICO]++ }
			// Line 177: if currentStep >= len(steps) → mark completed, continue  ← AFTER incrementing!
			// So flow for first contact with valid email_status, parentICO="ICO123", currentStep=99:
			//   - passes email gate (valid)
			//   - passes holding gate (seenParentICO["ICO123"]=0 < 1)
			//   - increments seenParentICO["ICO123"] = 1
			//   - currentStep(99) >= len(steps)(1) → UPDATE + continue
			// Flow for second contact with valid email_status, parentICO="ICO123":
			//   - passes email gate (valid)
			//   - seenParentICO["ICO123"]=1 >= HoldingClusterCap=1 → BLOCKED → continue ✓
			AddRow(int64(21), int64(11), 0, "b@firma.cz", "B", "Holding B", "Praha", "valid", "ICO123"))

	// First contact (step=99 >= len=1): UPDATE to completed
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(20)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Second contact should be blocked by holding cluster — no further SQL

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// TestRunCampaign_ParentICOEmpty_NotTracked verifies that empty parent_ico
// contacts do NOT increment the holding cluster counter.
func TestRunCampaign_ParentICOEmpty_NotTracked(t *testing.T) {
	steps, cleanup := runnerWithOneStep(t)
	defer cleanup()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	expectCampaignLoad(mock, steps)

	// 3 contacts, all with empty parent_ico, each on a distinct domain
	// (so domain rotation gate does not interfere with this holding-cluster test).
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(30), int64(20), 99, "a@firma-a.cz", "A", "FA", "Praha", "valid", "").
			AddRow(int64(31), int64(21), 99, "b@firma-b.cz", "B", "FB", "Praha", "valid", "").
			AddRow(int64(32), int64(22), 99, "c@firma-c.cz", "C", "FC", "Praha", "valid", ""))

	// Each contact at step 99 → UPDATE to completed
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).WithArgs(int64(30)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).WithArgs(int64(31)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).WithArgs(int64(32)).WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
