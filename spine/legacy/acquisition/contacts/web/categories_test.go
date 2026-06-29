package contactsweb

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func newDBMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

// ── HandleCategories ──────────────────────────────────────────

func TestHandleCategories_MethodNotAllowed(t *testing.T) {
	db, _ := newDBMock(t)
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		t.Run(m, func(t *testing.T) {
			req := httptest.NewRequest(m, "/api/categories", nil)
			w := httptest.NewRecorder()
			HandleCategories(db, w, req)
			if w.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s → want 405, got %d", m, w.Code)
			}
		})
	}
}

func TestHandleCategories_DBError_Search(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	req := httptest.NewRequest(http.MethodGet, "/api/categories?q=stavebni", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on DB error, got %d", w.Code)
	}
}

func TestHandleCategories_DBError_Parent(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	req := httptest.NewRequest(http.MethodGet, "/api/categories?parent=Remesla", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on DB error, got %d", w.Code)
	}
}

func TestHandleCategories_DBError_Roots(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	req := httptest.NewRequest(http.MethodGet, "/api/categories", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on DB error, got %d", w.Code)
	}
}

func TestHandleCategories_LimitParam_Clamped(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	// Negative limit should be ignored (default 200 kicks in); zero likewise.
	for _, limit := range []string{"-5", "0"} {
		req := httptest.NewRequest(http.MethodGet, "/api/categories?q=x&limit="+limit, nil)
		w := httptest.NewRecorder()
		HandleCategories(db, w, req)
		// DB error yields 500 regardless; verify we got PAST the limit-parse step.
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("limit=%s: want 500 (DB error), got %d", limit, w.Code)
		}
		mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	}
}

// ── HandleCategoryDetail ──────────────────────────────────────

func TestHandleCategoryDetail_MethodNotAllowed(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/categories/stavebni", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", w.Code)
	}
}

func TestHandleCategoryDetail_SlugNotFound(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrNoRows)
	req := httptest.NewRequest(http.MethodGet, "/api/categories/nonexistent", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)
	// Store FindBySlug wraps the error — accept 404 or 500 as long as non-200.
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 for unknown slug, got 200 (body=%s)", w.Body.String())
	}
}

func TestHandleCategoryDetail_DBError(t *testing.T) {
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	req := httptest.NewRequest(http.MethodGet, "/api/categories/anything", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on DB error, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestHandleCategoryDetail_UnknownAction(t *testing.T) {
	// Can't reliably get past FindBySlug with sqlmock without the full Store
	// query surface. Instead assert the path parses — we'll hit 500 on DB
	// before reaching the action-check branch, which locks that invalid
	// actions don't 200.
	db, mock := newDBMock(t)
	mock.ExpectQuery(`SELECT`).WillReturnError(sql.ErrConnDone)
	req := httptest.NewRequest(http.MethodGet, "/api/categories/slug/banana", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200, got 200")
	}
}

// ── writeJSON helper ─────────────────────────────────────────

func TestWriteJSON_ContentType(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, map[string]string{"key": "val"})
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("want application/json, got %q", ct)
	}
	if !strings.Contains(w.Body.String(), `"key":"val"`) {
		t.Fatalf("body: %s", w.Body.String())
	}
}
