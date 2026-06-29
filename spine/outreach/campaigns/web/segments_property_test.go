package campaignsweb

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── Property: HandleSegments never panics on any HTTP method ──────
func TestProperty_HandleSegments_MethodFuzz(t *testing.T) {
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
			req := httptest.NewRequest(m, "/api/segments", nil)
			w := httptest.NewRecorder()
			HandleSegments(db, w, req)
			if w.Code < 200 || w.Code >= 600 {
				t.Fatalf("invalid status %d for method %q", w.Code, m)
			}
		})
	}
}

// ── Property: HandleSegmentDetail path shapes don't crash ────────
func TestProperty_HandleSegmentDetail_PathFuzz(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()

	paths := []string{
		"/api/segments/",
		"/api/segments/abc",
		"/api/segments/0",
		"/api/segments/-1",
		"/api/segments/" + strings.Repeat("9", 30), // int64 overflow
		"/api/segments/42",
		"/api/segments/42/verify",
		"/api/segments/42/rebuild",
		"/api/segments/42/banana",
		"/api/segments/42/../../etc/passwd",
		"/api/segments/42/🚀",
		"/api/segments/42/verify/extra",
	}
	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on path %q: %v", p, r)
				}
			}()
			for _, m := range []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete} {
				req := httptest.NewRequest(m, p, nil)
				w := httptest.NewRecorder()
				HandleSegmentDetail(db, w, req)
				if w.Code < 200 || w.Code >= 600 {
					t.Fatalf("invalid status %d for %s %s", w.Code, m, p)
				}
			}
		})
	}
}

// ── Property: createSegment body fuzz ─────────────────────────────
func TestProperty_CreateSegment_BodyFuzz(t *testing.T) {
	db, _, _ := sqlmock.New()
	defer db.Close()

	bodies := []string{
		`{}`,
		`{"name":""}`,
		`{"name":"x"}`,
		`{"name":"x","description":"test"}`,
		`{"name":"x","query":{}}`,
		`{"name":"x","query":{"country":"CZ"}}`,
		`{"name":"ěščřžýáíéůú"}`,
		`{"name":"` + strings.Repeat("x", 5000) + `"}`,
		`not json`,
		`{`,
		`null`,
		`[]`,
		`"string body"`,
	}

	for _, body := range bodies {
		t.Run("body="+strings.ReplaceAll(strings.ReplaceAll(body[:min(40, len(body))], "\n", ""), "\t", ""), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on body %q: %v", body, r)
				}
			}()
			req := httptest.NewRequest(http.MethodPost, "/api/segments", strings.NewReader(body))
			w := httptest.NewRecorder()
			HandleSegments(db, w, req)
			if w.Code < 200 || w.Code >= 600 {
				t.Fatalf("invalid status %d for body %q", w.Code, body)
			}
		})
	}
}

// ── Property: isNotFound is pure + deterministic ──────────────────
func TestProperty_IsNotFound_Deterministic(t *testing.T) {
	f := func(msg string) bool {
		err := stringErr{msg}
		a := isNotFound(err)
		b := isNotFound(err)
		return a == b
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: isNotFound(nil) is false always ─────────────────────
func TestProperty_IsNotFound_NilAlwaysFalse(t *testing.T) {
	// Trivial but locks: any "wrapping" of nil should still be false.
	if isNotFound(nil) {
		t.Fatal("isNotFound(nil) should be false")
	}
	var err error
	if isNotFound(err) {
		t.Fatal("isNotFound(zero error) should be false")
	}
	_ = sql.ErrNoRows
}

