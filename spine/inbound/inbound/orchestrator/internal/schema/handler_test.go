package schema

import (
	"database/sql/driver"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ---------------------------------------------------------------------------
// Handler returns 200 + JSON body with the expected envelope keys.
// ---------------------------------------------------------------------------

func TestHandler_Returns200AndJSON(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
	), indexRows())

	h := Handler(db)
	req := httptest.NewRequest(http.MethodGet, "/schema", nil)
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type: got %q", ct)
	}

	var m Manifest
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.Version != ManifestVersion {
		t.Fatalf("version: got %q want %q", m.Version, ManifestVersion)
	}
	if !strings.HasPrefix(m.ManifestHash, "sha256:") {
		t.Fatalf("manifest_hash: missing sha256: prefix (%q)", m.ManifestHash)
	}
	if got := rec.Header().Get("X-Manifest-Hash"); got != m.ManifestHash {
		t.Fatalf("X-Manifest-Hash header drift: header=%q body=%q", got, m.ManifestHash)
	}
}

// ---------------------------------------------------------------------------
// Handler caches: a second call within 60s does NOT re-query the DB.
// ---------------------------------------------------------------------------

func TestHandler_CachesWithinTTL(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	// Only one set of expectations — second call must hit the cache.
	expectAll(mock, columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
	), indexRows())

	h := Handler(db)
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/schema", nil)
		rec := httptest.NewRecorder()
		h(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d: status %d", i, rec.Code)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Handler regenerates after the cache TTL elapses.
// ---------------------------------------------------------------------------

func TestHandler_RegeneratesAfterTTL(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	// Two builds expected — one before TTL, one after.
	expectAll(mock, columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
	), indexRows())
	expectAll(mock, columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
		[]driver.Value{"t", "name", "text", "YES", nil},
	), indexRows())

	// Use a controllable clock so we don't need a real sleep.
	c := newCache()
	var virtualNow atomic.Int64
	base := time.Date(2026, 4, 26, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time {
		return base.Add(time.Duration(virtualNow.Load()) * time.Second)
	}

	// First call: t=0s → fresh build, expires at 60s.
	if _, err := c.get(req(t).Context(), db); err != nil {
		t.Fatalf("first build: %v", err)
	}
	// Advance virtual clock past TTL.
	virtualNow.Store(90)
	// Second call: t=90s → cache expired → rebuild.
	if _, err := c.get(req(t).Context(), db); err != nil {
		t.Fatalf("second build: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// req is a tiny helper so the cache test stays one-line per call.
func req(_ *testing.T) *http.Request {
	return httptest.NewRequest(http.MethodGet, "/schema", nil)
}

// ---------------------------------------------------------------------------
// Handler rejects POST/PUT/DELETE with 405.
// ---------------------------------------------------------------------------

func TestHandler_RejectsNonGET(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()
	h := Handler(db)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/schema", nil)
			rec := httptest.NewRecorder()
			h(rec, req)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("method %s: got %d, want 405", method, rec.Code)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Handler supports HEAD (200, no body, hash header present).
// ---------------------------------------------------------------------------

func TestHandler_HEADReturnsHeadersOnly(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
	), indexRows())

	h := Handler(db)
	req := httptest.NewRequest(http.MethodHead, "/schema", nil)
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD body should be empty, got %d bytes", rec.Body.Len())
	}
	if rec.Header().Get("X-Manifest-Hash") == "" {
		t.Fatal("HEAD must still expose X-Manifest-Hash")
	}
}

// ---------------------------------------------------------------------------
// Handler returns 500 on DB error.
// ---------------------------------------------------------------------------

func TestHandler_500OnDBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`information_schema.columns`).WillReturnError(sqlmock.ErrCancelled)

	h := Handler(db)
	req := httptest.NewRequest(http.MethodGet, "/schema", nil)
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: got %d want 500", rec.Code)
	}
}
