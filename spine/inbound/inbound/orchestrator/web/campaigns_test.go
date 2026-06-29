package web

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── handleCampaigns ─────────────────────────────────────────────────────────

func TestHandleCampaigns_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/campaigns", nil)
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleCampaigns_GET_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnError(errWeb("db down"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns", nil)
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on DB error, got %d", w.Code)
	}
}

func TestHandleCampaigns_GET_EmptyList(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "name", "description", "status", "sequence_config", "category_paths", "category_match", "stats", "created_at", "updated_at"}
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns", nil)
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["total"] != float64(0) {
		t.Errorf("expected total=0, got %v", body["total"])
	}
}

func TestHandleCampaigns_POST_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader("{invalid json"))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 on invalid JSON, got %d", w.Code)
	}
}

func TestHandleCampaigns_POST_MissingName(t *testing.T) {
	s := newTestServer(t)
	body := `{"description": "no name"}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 on missing name, got %d", w.Code)
	}
}

func TestHandleCampaigns_POST_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// EstimateEnrollment query
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnError(errWeb("estimate error"))

	// CreateCampaign INSERT — triggered after estimate
	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnError(errWeb("insert failed"))

	s := NewServer(db, "")
	body := `{"name": "Test Campaign", "steps": [{"step":0,"delay_days":0,"template":"initial"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	// Estimate error is silently ignored; CreateCampaign INSERT fails → 500.
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when CreateCampaign INSERT fails, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleCampaigns_POST_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// EstimateEnrollment
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(42))

	// CreateCampaign INSERT
	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7))

	// enrollContacts INSERT INTO campaign_contacts
	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	s := NewServer(db, "")
	body := `{"name": "Test Campaign", "steps": [{"step":0,"delay_days":0,"template":"initial"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] != float64(7) {
		t.Errorf("expected id=7, got %v", resp["id"])
	}
	if resp["estimate"] != float64(42) {
		t.Errorf("expected estimate=42, got %v", resp["estimate"])
	}
}

func TestHandleCampaigns_POST_DefaultSteps(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// EstimateEnrollment
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(10))

	// CreateCampaign with default 3-step sequence
	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// enrollContacts
	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	s := NewServer(db, "")
	// No steps → default sequence assigned
	body := `{"name": "Auto Steps Campaign"}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201 with default steps, got %d: %s", w.Code, w.Body.String())
	}
}

// ── handleCampaignDetail ────────────────────────────────────────────────────

func TestHandleCampaignDetail_InvalidID(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/notanumber", nil)
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_GET_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "name", "description", "status", "sequence_config", "category_paths", "category_match", "stats", "created_at", "updated_at"}
	// Get returns empty rows → sql.ErrNoRows
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/99", nil)
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-existent campaign, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_GET_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "name", "description", "status", "sequence_config", "category_paths", "category_match", "stats", "created_at", "updated_at"}
	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(cols).AddRow(
			1, "Campaign One", "", "draft",
			[]byte(`[{"step":0,"delay_days":0,"template":"initial"}]`),
			[]byte(`{}`), "prefix", []byte(`{}`), now, now,
		))

	// Stats query
	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}).AddRow("pending", 5))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/1", nil)
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["campaign"] == nil {
		t.Error("expected campaign in response")
	}
}

// F3-2 (PR #174) changed /run to "flip status only". The previous behavior
// — SetStatus + RunCampaign — was a silent no-op because the read-only
// runner had no Engine wired. After F3-2 the handler only does SetStatus
// and the actual send happens on the next scheduler tick.
//
// This test now exercises the error path of the new behavior: when
// SetStatus's UPDATE returns a SQL error, the handler returns 500.
func TestHandleCampaignDetail_POST_Run_SetStatusError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// SetStatus UPDATE fails — simulates DB connectivity / lock issue.
	mock.ExpectExec(`UPDATE campaigns`).
		WillReturnError(sql.ErrConnDone)

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/1/run", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when SetStatus errors, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_POST_Pause_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaigns`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/1/pause", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 on pause, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Errorf("expected ok=true, got %v", resp["ok"])
	}
}

func TestHandleCampaignDetail_POST_Pause_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE campaigns`).
		WillReturnError(errWeb("db error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/1/pause", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_GET_Estimate_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Get campaign
	cols := []string{"id", "name", "description", "status", "sequence_config", "category_paths", "category_match", "stats", "created_at", "updated_at"}
	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(cols).AddRow(
			1, "Campaign", "", "draft",
			[]byte(`[]`), []byte(`{}`), "prefix", []byte(`{}`), now, now,
		))

	// EstimateEnrollment
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(15))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/1/estimate", nil)
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 on estimate, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["count"] != float64(15) {
		t.Errorf("expected count=15, got %v", resp["count"])
	}
}

func TestHandleCampaignDetail_GET_Estimate_CampaignNotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "name", "description", "status", "sequence_config", "category_paths", "category_match", "stats", "created_at", "updated_at"}
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(cols)) // empty

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/99/estimate", nil)
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_UnknownAction(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/1/unknown-action", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown action, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_DELETE_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/campaigns/1", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleCampaignDetail(w, req)
	// No matching switch case for DELETE with empty action → 404 default branch
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for DELETE on campaign detail, got %d", w.Code)
	}
}

// ── writeJSON ───────────────────────────────────────────────────────────────

func TestWriteJSON_SetsContentType(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, map[string]any{"key": "value"})
	if w.Header().Get("Content-Type") != "application/json" {
		t.Errorf("expected application/json, got %s", w.Header().Get("Content-Type"))
	}
}

func TestWriteJSON_ValidJSON(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, map[string]any{"count": 5, "ok": true})

	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}
	if result["count"] != float64(5) {
		t.Errorf("count: %v", result["count"])
	}
}

func TestCreateCampaign_InvalidMinScore(t *testing.T) {
	s := newTestServer(t)
	body := `{"name": "Test", "min_score": 1.5}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for min_score 1.5, got %d", w.Code)
	}
}

func TestCreateCampaign_MinScoreNegative(t *testing.T) {
	s := newTestServer(t)
	body := `{"name": "Test", "min_score": -0.1}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for min_score -0.1, got %d", w.Code)
	}
}

func TestCreateCampaign_InvalidCategoryMatch(t *testing.T) {
	s := newTestServer(t)
	body := `{"name": "Test", "category_match": "fuzzy"}`
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleCampaigns(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for category_match 'fuzzy', got %d", w.Code)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

// newTestServer returns a Server with nil DB for testing endpoints that don't
// reach the database.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	return NewServer(nil, "http://localhost:8080")
}
