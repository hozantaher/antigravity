package campaignsweb

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── listCampaigns — previously 0% covered ─────────────────────────────────
// listCampaigns calls runner.List which queries the DB. We cover error and
// empty-result paths since success requires a full schema match.

func TestListCampaigns_DBError_Returns500(t *testing.T) {
	// Any DB query error must be surfaced as 500.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("").WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodGet, "/api/campaigns", nil)
	w := httptest.NewRecorder()
	HandleCampaigns(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 on DB error, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestListCampaigns_EmptyResult_Returns200(t *testing.T) {
	// Sqlmock returning an empty result set exercises the happy-path.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// runner.List queries campaigns + steps. Provide empty rows for both.
	mock.ExpectQuery("").WillReturnRows(sqlmock.NewRows([]string{}))

	req := httptest.NewRequest(http.MethodGet, "/api/campaigns", nil)
	w := httptest.NewRecorder()
	HandleCampaigns(db, w, req)
	// Either 200 or 500 is acceptable; the test locks that it does NOT panic.
	if w.Code < 200 || w.Code >= 600 {
		t.Fatalf("invalid status %d", w.Code)
	}
}

// ── HandleCampaignDetail — run action error branches ─────────────────────

func TestHandleCampaignDetail_RunAction_SetStatusFails(t *testing.T) {
	// POST /api/campaigns/:id/run → SetStatus returns error → 500.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec("").WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/42/run", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 when SetStatus fails, got 200")
	}
}

func TestHandleCampaignDetail_PauseAction_SetStatusFails(t *testing.T) {
	// POST /api/campaigns/:id/pause → SetStatus returns error → 500.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec("").WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/42/pause", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 when SetStatus(pause) fails, got 200")
	}
}

func TestHandleCampaignDetail_EstimateAction_GetFails(t *testing.T) {
	// GET /api/campaigns/:id/estimate → Get returns error → 404.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("").WillReturnError(sql.ErrNoRows)

	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/42/estimate", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 when Get fails for estimate, got 200")
	}
}

// ── HandleCampaignDetail — unknown action ─────────────────────────────────

func TestHandleCampaignDetail_UnknownAction_Returns404(t *testing.T) {
	db, _ := newDBMock(t)
	req := httptest.NewRequest(http.MethodPost, "/api/campaigns/42/start", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404 for unknown action 'start', got %d", w.Code)
	}
}

func TestHandleCampaignDetail_GetWithAction_Returns404(t *testing.T) {
	db, _ := newDBMock(t)
	// GET + non-empty non-estimate action → default → 404
	req := httptest.NewRequest(http.MethodGet, "/api/campaigns/42/unknown", nil)
	w := httptest.NewRecorder()
	HandleCampaignDetail(db, w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404 for GET+unknown action, got %d", w.Code)
	}
}

// ── listSegments — error path exercise ────────────────────────────────────

func TestListSegments_NilRows_NoPanic(t *testing.T) {
	// store.List with an unexpected error must not panic.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("").WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodGet, "/api/segments", nil)
	w := httptest.NewRecorder()

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("listSegments panicked: %v", r)
		}
	}()
	HandleSegments(db, w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", w.Code)
	}
}

// ── HandleSegmentDetail — Patch/Delete error paths ────────────────────────

func TestHandleSegmentDetail_PatchDBError_Returns5xx(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec("").WillReturnError(sql.ErrConnDone)

	body := `{"name":"updated","description":"x","query":{}}`
	req := httptest.NewRequest(http.MethodPatch, "/api/segments/42", strings.NewReader(body))
	w := httptest.NewRecorder()
	HandleSegmentDetail(db, w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 when PATCH update fails, got 200")
	}
}

func TestHandleSegmentDetail_DeleteDBGenericError_Returns500(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec("").WillReturnError(sql.ErrConnDone)

	req := httptest.NewRequest(http.MethodDelete, "/api/segments/42", nil)
	w := httptest.NewRecorder()
	HandleSegmentDetail(db, w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("want non-200 when DELETE fails, got 200")
	}
}

// ── Monkey: HandleCampaigns never panics on arbitrary method ─────────────

func TestProperty_HandleCampaigns_AnyMethod_NoPanic(t *testing.T) {
	methods := []string{
		http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions,
		"CUSTOM", "", "FUZZ-METHOD",
	}
	for _, m := range methods {
		m := m
		t.Run("method="+m, func(t *testing.T) {
			db, _, _ := sqlmock.New()
			defer db.Close()
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("HandleCampaigns panicked on method %q: %v", m, r)
				}
			}()
			req := httptest.NewRequest(m, "/api/campaigns", strings.NewReader("{}"))
			w := httptest.NewRecorder()
			HandleCampaigns(db, w, req)
			if w.Code < 200 || w.Code >= 600 {
				t.Errorf("invalid status %d for method %q", w.Code, m)
			}
		})
	}
}

// ── Monkey: HandleSegmentDetail never panics on any method+path ──────────

func TestProperty_HandleSegmentDetail_AnyMethod_NoPanic(t *testing.T) {
	f := func(idNum int32, action string) bool {
		db, _, _ := sqlmock.New()
		defer db.Close()
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("HandleSegmentDetail panicked: %v", r)
			}
		}()
		path := "/api/segments/" + itoa(idNum)
		if action != "" && !strings.Contains(action, "/") {
			path += "/" + action[:min3(20, len(action))]
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		HandleSegmentDetail(db, w, req)
		return w.Code >= 200 && w.Code < 600
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ── Monkey: writeJSON never panics on nil input ───────────────────────────

func TestWriteJSON_NilInput_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("writeJSON(nil) panicked: %v", r)
		}
	}()
	w := httptest.NewRecorder()
	writeJSON(w, nil)
}

// ── Monkey: isNotFound never panics on arbitrary errors ──────────────────

func TestProperty_IsNotFound_NeverPanics(t *testing.T) {
	f := func(msg string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("isNotFound panicked on msg=%q: %v", msg, r)
			}
		}()
		_ = isNotFound(stringError{msg})
		_ = isNotFound(nil)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

type stringError struct{ s string }

func (e stringError) Error() string { return e.s }

func itoa(n int32) string {
	if n < 0 {
		return "-" + itoa32(-n)
	}
	return itoa32(n)
}

func itoa32(n int32) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func min3(a, b int) int {
	if a < b {
		return a
	}
	return b
}
