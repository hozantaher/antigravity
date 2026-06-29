package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// segmentCols mirrors what handleSegments scans from the DB.
var segmentCols = []string{
	"id", "name", "description", "query",
	"company_count", "last_built_at", "created_at", "updated_at",
}

func sampleSegmentQuery() string {
	return `{"op":"AND","conditions":[]}`
}

// ── handleSegments ────────────────────────────────────────────────────────────

func TestHandleSegments_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/segments", nil)
	w := httptest.NewRecorder()
	s.handleSegments(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleSegments_GET_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segmentCols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/segments", nil)
	w := httptest.NewRecorder()
	s.handleSegments(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["total"] != float64(0) {
		t.Errorf("total: %v", body["total"])
	}
	if _, ok := body["segments"]; !ok {
		t.Error("response missing segments key")
	}
}

func TestHandleSegments_GET_WithRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segmentCols).AddRow(
			1, "ICP Tier 1", "Best customers", sampleSegmentQuery(),
			10, nil, now, now,
		))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/segments", nil)
	w := httptest.NewRecorder()
	s.handleSegments(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["total"] != float64(1) {
		t.Errorf("total = %v, want 1", body["total"])
	}
}

func TestHandleSegments_GET_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnError(errWeb("db down"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/segments", nil)
	w := httptest.NewRecorder()
	s.handleSegments(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestHandleSegments_POST_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/segments", strings.NewReader("{invalid"))
	w := httptest.NewRecorder()
	s.handleSegments(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleSegments_POST_MissingName(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/segments", strings.NewReader(`{"description":"x"}`))
	w := httptest.NewRecorder()
	s.handleSegments(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 on missing name, got %d", w.Code)
	}
}

func TestHandleSegments_POST_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO segments`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(5)))

	s := NewServer(db, "")
	body := `{"name":"NACE-43","description":"Demolice"}`
	req := httptest.NewRequest(http.MethodPost, "/api/segments", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleSegments(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] != float64(5) {
		t.Errorf("id = %v, want 5", resp["id"])
	}
}

func TestHandleSegments_POST_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO segments`).
		WillReturnError(errWeb("insert failed"))

	s := NewServer(db, "")
	body := `{"name":"Fail"}`
	req := httptest.NewRequest(http.MethodPost, "/api/segments", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleSegments(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

// ── handleSegmentDetail ───────────────────────────────────────────────────────

func TestHandleSegmentDetail_InvalidID(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/segments/notanumber", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_GET_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segmentCols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/segments/99", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_GET_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segmentCols).AddRow(
			3, "ICP Tier 1", "Best", sampleSegmentQuery(), 7, nil, now, now,
		))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/segments/3", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["segment"] == nil {
		t.Error("response missing segment key")
	}
}

func TestHandleSegmentDetail_PATCH_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPatch, "/api/segments/1", strings.NewReader("{bad"))
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_PATCH_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE segments`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewServer(db, "")
	body := `{"name":"Updated","description":"New desc"}`
	req := httptest.NewRequest(http.MethodPatch, "/api/segments/1", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Errorf("expected ok=true, got %v", resp["ok"])
	}
}

func TestHandleSegmentDetail_PATCH_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE segments`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPatch, "/api/segments/999", strings.NewReader(`{"name":"X"}`))
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_DELETE_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM segments`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodDelete, "/api/segments/7", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Errorf("expected ok=true, got %v", resp["ok"])
	}
}

func TestHandleSegmentDetail_DELETE_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM segments`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodDelete, "/api/segments/404", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_POST_Rebuild_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	// Get segment for rebuild
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segmentCols).AddRow(
			2, "NACE-43", "", sampleSegmentQuery(), 0, nil, now, now,
		))
	// BuildMemberships uses a transaction
	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 12))
	mock.ExpectExec(`UPDATE segments`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/segments/2/rebuild", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Errorf("expected ok=true, got %v", resp["ok"])
	}
	if resp["companies"] != float64(12) {
		t.Errorf("companies = %v, want 12", resp["companies"])
	}
}

func TestHandleSegmentDetail_POST_UnknownAction(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/segments/1/unknown", bytes.NewReader(nil))
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown action, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPut, "/api/segments/1", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleSegmentDetail_POST_Verify_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\)`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(27))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodPost, "/api/segments/4/verify", nil)
	w := httptest.NewRecorder()
	s.handleSegmentDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["count"] != float64(27) {
		t.Errorf("count = %v, want 27", resp["count"])
	}
	if resp["ready"] != true {
		t.Errorf("ready should be true; got %v", resp)
	}
}
