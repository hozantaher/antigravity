package contactsweb

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── Method fuzz ──────────────────────────────────────────────────
func TestProperty_HandleCategories_MethodFuzz(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	methods := []string{
		http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions,
		"INVALID", "", "CUSTOM",
	}
	for _, m := range methods {
		t.Run("method="+m, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on method %q: %v", m, r)
				}
			}()
			req := httptest.NewRequest(m, "/api/categories", nil)
			w := httptest.NewRecorder()
			HandleCategories(db, w, req)
			if w.Code < 200 || w.Code >= 600 {
				t.Fatalf("invalid status %d for %q", w.Code, m)
			}
		})
	}
}

// ── Query param fuzz for HandleCategories ───────────────────────
func TestProperty_HandleCategories_QueryFuzz(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()

	queries := []string{
		"",
		"?q=",
		"?q=stavebni",
		"?parent=",
		"?parent=Remesla",
		"?limit=0",
		"?limit=-5",
		"?limit=99999",
		"?limit=abc",
		"?q=" + strings.Repeat("x", 1000),
		"?q=ěščřžýáíéůú",
		"?q=" + strings.Repeat("%", 100),
		"?q=%22sql-inject%22",
		"?q=foo&parent=bar&limit=10",
	}
	for _, q := range queries {
		t.Run("q="+q, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on %q: %v", q, r)
				}
			}()
			req := httptest.NewRequest(http.MethodGet, "/api/categories"+q, nil)
			w := httptest.NewRecorder()
			HandleCategories(db, w, req)
			if w.Code < 200 || w.Code >= 600 {
				t.Fatalf("invalid status %d for %q", w.Code, q)
			}
		})
	}
}

// ── Path fuzz for HandleCategoryDetail ─────────────────────────
func TestProperty_HandleCategoryDetail_PathFuzz(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()

	paths := []string{
		"/api/categories/",
		"/api/categories/abc",
		"/api/categories/with-hyphen",
		"/api/categories/with_underscore",
		"/api/categories/" + strings.Repeat("x", 500), // long slug
		"/api/categories/ěščř",
		"/api/categories/foo/companies",
		"/api/categories/foo/banana",
		"/api/categories/foo/..//bar",
		"/api/categories/foo/companies?prefix=true",
		"/api/categories/foo/companies?prefix=false",
		"/api/categories/foo/companies?limit=999999",
		"/api/categories/foo/companies?offset=-5",
	}
	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on %q: %v", p, r)
				}
			}()
			for _, m := range []string{http.MethodGet, http.MethodPost} {
				req := httptest.NewRequest(m, p, nil)
				w := httptest.NewRecorder()
				HandleCategoryDetail(db, w, req)
				if w.Code < 200 || w.Code >= 600 {
					t.Fatalf("invalid status %d for %s %s", w.Code, m, p)
				}
			}
		})
	}
}
