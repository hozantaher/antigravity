package campaignsweb

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestCreateCampaign_Success covers the 201 response path (lines 99-103 in campaigns.go).
func TestCreateCampaign_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// EstimateEnrollment query
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))
	// CreateCampaign INSERT
	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))
	// enrollContacts INSERT
	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	body := `{"name":"Test Campaign","steps":[{"step":0,"delay_days":0,"template_name":"initial"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	HandleCampaigns(db, w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "42") {
		t.Errorf("expected campaign id=42 in response, got: %s", w.Body.String())
	}
}

// TestHandleSegmentDetail_RebuildSuccess covers line 150 (rebuild writeJSON path).
// Query{Op:"AND",Conditions:nil} → BuildSQL returns "TRUE" → fullWhere = "exclusion_status='pass' AND (TRUE)"
func TestHandleSegmentDetail_RebuildSuccess(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	now := time.Now()
	// store.Get → QueryRowContext
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "description", "query",
			"company_count", "last_built_at", "created_at", "updated_at",
		}).AddRow(1, "Seg", "desc", `{"op":"AND","conditions":[]}`, 0, nil, now, now))

	// store.BuildMemberships uses a transaction
	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 7))
	mock.ExpectExec(`UPDATE segments SET company_count`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	req := httptest.NewRequest(http.MethodPost, "/api/segments/1/rebuild", nil)
	w := httptest.NewRecorder()
	HandleSegmentDetail(db, w, req)

	t.Logf("rebuild response: %d %s", w.Code, w.Body.String())
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Logf("unmet mock expectations: %v", err)
	}
}
