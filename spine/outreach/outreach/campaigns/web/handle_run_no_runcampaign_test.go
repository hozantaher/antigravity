package campaignsweb

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// F3-2 — locks the rule that POST /api/campaigns/:id/run does NOT call
// RunCampaign. NewReadOnlyRunner has no Engine wired; calling
// RunCampaign would silently no-op the Enqueue (logged as "engine nil
// at Enqueue") and advance current_step in DB without sending. The
// real send happens on the next scheduler tick.
//
// Goes RED if anyone re-introduces the runner.RunCampaign call into
// HandleCampaignDetail.

func TestHandleRun_DoesNotCallRunCampaign(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Only the SetStatus UPDATE. NO `SELECT name FROM campaigns`
	// (which is what RunCampaign issues first).
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WithArgs("running", int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/42/run", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met (likely RunCampaign was called): %v", err)
	}
}

func TestHandleRun_ResponseCarriesSchedulerHint(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/42/run", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if !strings.Contains(w.Body.String(), "scheduler") {
		t.Errorf("body should contain 'scheduler' hint, got: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Errorf("body should contain ok:true, got: %s", w.Body.String())
	}
}

func TestHandleRun_StatusFlippedToRunning(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WithArgs("running", int64(123)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/123/run", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("status not set to running with id=123: %v", err)
	}
}

// Source-level audit: handler MUST NOT contain `runner.RunCampaign(`.
// Goes RED if anyone reverts.
func TestHandleRun_SourceAudit_NoRunCampaignCall(t *testing.T) {
	src, err := os.ReadFile("campaigns.go")
	if err != nil {
		t.Fatalf("read campaigns.go: %v", err)
	}
	// Find the /run case branch.
	// Go's regexp caps repeat count at 1000.
	rx := regexp.MustCompile(`(?s)r\.Method == http\.MethodPost && action == "run":.{0,999}`)
	region := rx.FindString(string(src))
	if region == "" {
		t.Fatal("could not locate /run case in campaigns.go")
	}
	// Truncate at the next case to keep the region tight.
	if idx := strings.Index(region, "case r.Method == http.MethodPost && action == \"pause\""); idx > 0 {
		region = region[:idx]
	}
	if strings.Contains(region, "runner.RunCampaign(") {
		t.Errorf("/run case must NOT call runner.RunCampaign — that path silently no-ops with NewReadOnlyRunner")
	}
	if !strings.Contains(region, "runner.SetStatus(") {
		t.Error("/run case must call SetStatus to flip to 'running'")
	}
	if !strings.Contains(region, "scheduler") {
		t.Error("/run case must mention scheduler in the response hint or comment")
	}
}
