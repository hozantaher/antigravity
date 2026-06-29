package campaignsweb

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
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

// ── HandleCampaigns — method routing ───────────────────────────────

func TestHandleCampaigns_MethodNotAllowed(t *testing.T) {
	db, _ := newDBMock(t)
	for _, m := range []string{http.MethodPut, http.MethodDelete, http.MethodPatch} {
		t.Run(m, func(t *testing.T) {
			req := httptest.NewRequest(m, "/api/campaigns", nil)
			w := httptest.NewRecorder()
			HandleCampaigns(db, w, req)
			if w.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s → want 405, got %d", m, w.Code)
			}
		})
	}
}

// ── createCampaign — validation branches ──────────────────────────

func TestCreateCampaign_InvalidJSON(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(`not json`))
	w := httptest.NewRecorder()
	HandleCampaigns(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
	// S-H2: 400 body is now the generic "invalid request" — server-side
	// slog still carries the underlying decode error.
	if !strings.Contains(w.Body.String(), "invalid request") {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestCreateCampaign_NameRequired(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(`{"name":""}`))
	w := httptest.NewRecorder()
	HandleCampaigns(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "name is required") {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestCreateCampaign_MinScoreOutOfRange(t *testing.T) {
	db, _ := newDBMock(t)
	for _, body := range []string{
		`{"name":"x","min_score":-0.1}`,
		`{"name":"x","min_score":1.5}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(body))
		w := httptest.NewRecorder()
		HandleCampaigns(db, w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %q: want 400, got %d", body, w.Code)
		}
	}
}

func TestCreateCampaign_InvalidCategoryMatch(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(`{"name":"x","category_match":"banana"}`))
	w := httptest.NewRecorder()
	HandleCampaigns(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "prefix") {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestCreateCampaign_ValidCategoryMatch_PrefixAndExact(t *testing.T) {
	// Valid category_match values should pass validation (not 400 on that rule).
	// DB will fail downstream — we just verify we get PAST the validation.
	for _, match := range []string{"prefix", "exact"} {
		t.Run("match="+match, func(t *testing.T) {
			db, _ := newDBMock(t)
			req := httptest.NewRequest(http.MethodPost, "/api/campaigns", strings.NewReader(`{"name":"x","category_match":"`+match+`"}`))
			w := httptest.NewRecorder()
			HandleCampaigns(db, w, req)
			// Shouldn't be 400 on category_match validation; DB error yields 500.
			if w.Code == http.StatusBadRequest {
				if strings.Contains(w.Body.String(), "category_match") {
					t.Fatalf("match %q should pass validation, got 400 with: %s", match, w.Body.String())
				}
			}
		})
	}
}

// ── HandleCampaignDetail — path parsing + method routing ──────────

func TestHandleCampaignDetail_InvalidID(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/abc", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for non-numeric id, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_UnknownActionMethodMix(t *testing.T) {
	db, _ := newDBMock(t)
	// PATCH is not a registered method on detail path → 404.
	req := httptest.NewRequest(http.MethodPatch, "/api/campaigns/42", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404 for unregistered method, got %d", w.Code)
	}
}

func TestHandleCampaignDetail_GetAction_UnknownID(t *testing.T) {
	// Non-sqlmock path — just verify that an unknown id with no mocks returns
	// a 5xx rather than panicking (DB will error, handler wraps).
	db, _, _ := sqlmock.New()
	defer db.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/999999", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	// Handler returns 404 OR 500 depending on whether sqlmock returns
	// ErrNoRows or a more generic error. Accept both — lock that we don't
	// 200 on a clearly-invalid path.
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 for unknown id, got 200")
	}
}

// ── writeJSON helper ──────────────────────────────────────────────

func TestWriteJSON_SetsContentType(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, map[string]string{"k": "v"})
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("want application/json, got %q", got)
	}
	if !strings.Contains(w.Body.String(), `"k":"v"`) {
		t.Fatalf("body: %s", w.Body.String())
	}
}
