package contactsweb

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// categoryColumns are the 8 columns returned by FindBySlug / ListChildren queries.
var categoryColumns = []string{
	"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at",
}

// categoryRow returns one populated category row for sqlmock.
func categoryRow(id int, path, slug, name, parentPath string) *sqlmock.Rows {
	return sqlmock.NewRows(categoryColumns).
		AddRow(id, path, slug, name, parentPath, 1, 5, time.Now())
}

// ── HandleCategoryDetail: action="" (return category + children) ──────────

// TestHandleCategoryDetail_Found_NoAction exercises the branch where
// FindBySlug returns a category and action is empty → 200 + children list.
func TestHandleCategoryDetail_Found_NoAction_Success(t *testing.T) {
	db, mock := newDBMock(t)

	// FindBySlug query (QueryRowContext → ExpectQuery)
	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	// ListChildren query
	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(2, "Remesla > Stolari", "remesla~stolari", "Stolaři", "Remesla"))

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "category") {
		t.Errorf("response body missing 'category' key: %s", body)
	}
	if !strings.Contains(body, "children") {
		t.Errorf("response body missing 'children' key: %s", body)
	}
}

// TestHandleCategoryDetail_Found_NoAction_EmptyChildren exercises the branch
// where FindBySlug finds the category but ListChildren returns empty.
func TestHandleCategoryDetail_Found_NoAction_EmptyChildren(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(sqlmock.NewRows(categoryColumns)) // empty

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestHandleCategoryDetail_Found_NoAction_ChildrenError exercises the error
// path after a successful FindBySlug: ListChildren DB error → 500.
func TestHandleCategoryDetail_Found_NoAction_ChildrenError(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on children error, got %d", w.Code)
	}
}

// ── HandleCategoryDetail: action="companies" ──────────────────────────────

// companyColumns are the 9 columns returned by Companies COUNT + data queries.
var companyColumns = []string{
	"id", "name", "email", "website",
	"address_locality", "icp_tier", "icp_score", "thread_count", "contact_count",
}

// TestHandleCategoryDetail_Companies_Success exercises the full companies branch.
func TestHandleCategoryDetail_Companies_Success(t *testing.T) {
	db, mock := newDBMock(t)

	// FindBySlug
	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	// Companies: COUNT query
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	// Companies: data query
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns).
			AddRow(10, "Firma A", "a@firma.cz", "firma-a.cz", "Praha", "A", 0.9, 3, 5).
			AddRow(11, "Firma B", "b@firma.cz", "firma-b.cz", "Brno", "B", 0.6, 1, 2))

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla/companies", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "companies") {
		t.Errorf("body missing 'companies': %s", body)
	}
	if !strings.Contains(body, "total") {
		t.Errorf("body missing 'total': %s", body)
	}
}

// TestHandleCategoryDetail_Companies_PrefixFalse exercises prefix=false branch.
func TestHandleCategoryDetail_Companies_PrefixFalse(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns)) // empty

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla/companies?prefix=false", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestHandleCategoryDetail_Companies_WithLimitOffset exercises limit+offset parsing.
func TestHandleCategoryDetail_Companies_WithLimitOffset(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Stavebni", "stavebni", "Stavební", ""))

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(10))

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns))

	req := httptest.NewRequest(http.MethodGet, "/api/categories/stavebni/companies?limit=5&offset=10", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	// Response should echo the parsed limit and offset
	if !strings.Contains(body, `"limit":5`) {
		t.Errorf("body missing limit=5: %s", body)
	}
	if !strings.Contains(body, `"offset":10`) {
		t.Errorf("body missing offset=10: %s", body)
	}
}

// TestHandleCategoryDetail_Companies_InvalidLimitOffset_Defaults verifies
// invalid limit/offset values fall back to defaults (50/0).
func TestHandleCategoryDetail_Companies_InvalidLimitOffset_Defaults(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns))

	req := httptest.NewRequest(http.MethodGet,
		"/api/categories/remesla/companies?limit=abc&offset=-5", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	// Default limit=50, default offset=0
	if !strings.Contains(body, `"limit":50`) {
		t.Errorf("expected default limit 50 in body: %s", body)
	}
	if !strings.Contains(body, `"offset":0`) {
		t.Errorf("expected default offset 0 in body: %s", body)
	}
}

// TestHandleCategoryDetail_Companies_CountError exercises error on count query.
func TestHandleCategoryDetail_Companies_CountError(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla/companies", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on count error, got %d", w.Code)
	}
}

// TestHandleCategoryDetail_UnknownAction_Found_Returns404 exercises the
// "action != companies" branch when slug is found (404 for unknown action).
func TestHandleCategoryDetail_UnknownAction_Found_Returns404(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(1, "Remesla", "remesla", "Řemesla", ""))

	req := httptest.NewRequest(http.MethodGet, "/api/categories/remesla/banana", nil)
	w := httptest.NewRecorder()
	HandleCategoryDetail(db, w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404 for unknown action, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// ── HandleCategories: success path ────────────────────────────────────────

// TestHandleCategories_Roots_Success exercises the happy-path for listing roots.
func TestHandleCategories_Roots_Success(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(
			sqlmock.NewRows(categoryColumns).
				AddRow(1, "Remesla", "remesla", "Řemesla", "", 0, 10, time.Now()).
				AddRow(2, "Stavebni", "stavebni", "Stavební", "", 0, 7, time.Now()),
		)

	req := httptest.NewRequest(http.MethodGet, "/api/categories", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "categories") {
		t.Errorf("body missing 'categories': %s", body)
	}
	if !strings.Contains(body, `"total":2`) {
		t.Errorf("body missing total=2: %s", body)
	}
}

// TestHandleCategories_Search_Success exercises the search query branch.
func TestHandleCategories_Search_Success(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(3, "Stavebni > Omitky", "stavebni~omitky", "Omítky", "Stavebni"))

	req := httptest.NewRequest(http.MethodGet, "/api/categories?q=omitky", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "Omítky") && !strings.Contains(body, "omitky") {
		t.Errorf("body missing expected category: %s", body)
	}
}

// TestHandleCategories_Parent_Success exercises the parent/children branch.
func TestHandleCategories_Parent_Success(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(categoryRow(4, "Remesla > Tesari", "remesla~tesari", "Tesaři", "Remesla"))

	req := httptest.NewRequest(http.MethodGet, "/api/categories?parent=Remesla", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestHandleCategories_LimitParam_Valid exercises a valid positive limit.
func TestHandleCategories_LimitParam_Valid(t *testing.T) {
	db, mock := newDBMock(t)

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(sqlmock.NewRows(categoryColumns))

	req := httptest.NewRequest(http.MethodGet, "/api/categories?q=x&limit=10", nil)
	w := httptest.NewRecorder()
	HandleCategories(db, w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// ── Monkey / property tests ────────────────────────────────────────────────

// safeASCII strips non-printable and non-ASCII characters so that
// httptest.NewRequest doesn't panic on surrogate or invalid rune inputs.
func safeASCII(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r <= 0x7E {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// TestHandleCategoryDetail_NeverPanics_Property verifies HandleCategoryDetail
// never panics on arbitrary ASCII URL paths using testing/quick.
func TestHandleCategoryDetail_NeverPanics_Property(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }()

		db, _, err := sqlmock.New()
		if err != nil {
			return true
		}
		defer db.Close()

		// DB will return error (no expectations set) — that's fine.
		// We only verify no panic.
		req := httptest.NewRequest(http.MethodGet, "/api/categories/"+safeASCII(s), nil)
		w := httptest.NewRecorder()
		HandleCategoryDetail(db, w, req)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("HandleCategoryDetail panicked: %v", err)
	}
}

// TestHandleCategories_NeverPanics_Property verifies HandleCategories never
// panics on arbitrary ASCII query strings.
func TestHandleCategories_NeverPanics_Property(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }()

		db, _, err := sqlmock.New()
		if err != nil {
			return true
		}
		defer db.Close()

		req := httptest.NewRequest(http.MethodGet, "/api/categories?q="+safeASCII(s), nil)
		w := httptest.NewRecorder()
		HandleCategories(db, w, req)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("HandleCategories panicked: %v", err)
	}
}

// TestWriteJSON_NeverPanics_Property ensures writeJSON never panics on
// various input types.
func TestWriteJSON_NeverPanics_Property(t *testing.T) {
	f := func(key, val string) bool {
		defer func() { recover() }()
		w := httptest.NewRecorder()
		writeJSON(w, map[string]string{key: val})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("writeJSON panicked: %v", err)
	}
}
