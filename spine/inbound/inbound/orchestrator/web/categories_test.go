package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── handleCategories ─────────────────────────────────────────────────────────

func TestHandleCategories_WrongMethod(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/categories", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleCategories_GET_Roots_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).WillReturnError(errWeb("db error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestHandleCategories_GET_Roots_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["total"] != float64(0) {
		t.Errorf("expected total=0, got %v", body["total"])
	}
}

func TestHandleCategories_GET_Search_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).WillReturnError(errWeb("search error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories?q=stroj", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestHandleCategories_GET_Parent_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).WillReturnError(errWeb("children error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories?parent=Remesla", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestHandleCategories_GET_Limit_Param(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories?limit=10", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestHandleCategories_GET_InvalidLimit_UsesDefault(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories?limit=invalid", nil)
	w := httptest.NewRecorder()
	s.handleCategories(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

// ── handleCategoryDetail ──────────────────────────────────────────────────────

func TestHandleCategoryDetail_WrongMethod(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/categories/stavby", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_FindBySlug_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT`).WillReturnError(errWeb("find error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// FindBySlug returns nil (no rows)
	cols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/nonexistent", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_GET_Category_WithChildren(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}

	// FindBySlug — returns one row
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(cols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 10, time.Now(),
		))

	// ListChildren — returns empty
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(cols))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["category"] == nil {
		t.Error("expected category in response")
	}
}

func TestHandleCategoryDetail_GET_Category_ChildrenDBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	cols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}

	// FindBySlug
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(cols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 10, time.Now(),
		))

	// ListChildren fails
	mock.ExpectQuery(`SELECT`).WillReturnError(errWeb("children error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on children error, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_GET_Companies_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	catCols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	companyCols := []string{"id", "name", "email", "website", "address_locality", "icp_tier", "icp_score", "thread_count", "contact_count"}

	// FindBySlug
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(catCols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 5, time.Now(),
		))

	// Companies query — returns count + rows (the store returns total separately)
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(companyCols).
			AddRow(1, "Firma A", "a@test.cz", "https://a.cz", "Praha", "tier1", 0.85, 2, 3).
			AddRow(2, "Firma B", "b@test.cz", "", "Brno", "tier2", 0.65, 1, 2))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby/companies", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["total"] != float64(2) {
		t.Errorf("expected total=2, got %v", resp["total"])
	}
}

func TestHandleCategoryDetail_GET_Companies_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	catCols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}

	// FindBySlug
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(catCols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 5, time.Now(),
		))

	// Companies COUNT fails
	mock.ExpectQuery(`SELECT COUNT`).WillReturnError(errWeb("companies error"))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby/companies", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on companies error, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_GET_UnknownAction(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	catCols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(catCols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 5, time.Now(),
		))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby/unknown", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown action, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_GET_Companies_WithLimitOffset(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	catCols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	companyCols := []string{"id", "name", "email", "website", "address_locality", "icp_tier", "icp_score", "thread_count", "contact_count"}

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(catCols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 20, time.Now(),
		))

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(20))
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(companyCols).
			AddRow(5, "Firma C", "c@test.cz", "", "Ostrava", "tier1", 0.9, 3, 5))

	s := NewServer(db, "")
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby/companies?limit=5&offset=10&prefix=false", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["limit"] != float64(5) {
		t.Errorf("expected limit=5, got %v", resp["limit"])
	}
	if resp["offset"] != float64(10) {
		t.Errorf("expected offset=10, got %v", resp["offset"])
	}
}

func TestHandleCategoryDetail_GET_Companies_InvalidLimitOffset(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	catCols := []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
	companyCols := []string{"id", "name", "email", "website", "address_locality", "icp_tier", "icp_score", "thread_count", "contact_count"}

	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows(catCols).AddRow(
			1, "Stavby", "stavby", "Stavby", "", 0, 5, time.Now(),
		))

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyCols))

	s := NewServer(db, "")
	// invalid limit and offset → should use defaults (50, 0)
	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavby/companies?limit=bad&offset=bad", nil)
	w := httptest.NewRecorder()
	s.handleCategoryDetail(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 with invalid limit/offset, got %d", w.Code)
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["limit"] != float64(50) {
		t.Errorf("expected default limit=50, got %v", resp["limit"])
	}
}
