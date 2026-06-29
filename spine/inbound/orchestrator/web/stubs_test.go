package web

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// F5-1 (2026-04-29): the four "501 stub" tests were deleted along with
// the stub handlers and route registrations they covered. The routes
// no longer exist; mux returns a clean 404 instead of a misleading 501.
// New audit tests below assert the routes stay unregistered.

func TestRemovedStubs_RoutesReturn404(t *testing.T) {
	cases := []struct {
		method, path string
	}{
		{http.MethodGet, "/unsubscribe"},
		{http.MethodPost, "/api/suppressions/bulk"},
		{http.MethodPost, "/api/contacts/import"},
		{http.MethodGet, "/api/v1/health/deliverability"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			s := newTestServer(t)
			req := httptest.NewRequest(c.method, c.path, nil)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, req)
			if w.Code != http.StatusNotFound {
				t.Errorf("expected 404 (route removed), got %d (body=%s)", w.Code, w.Body.String())
			}
		})
	}
}

// ---- WithMailboxBP / handleMailboxReleaseHold ----

type fakeHoldReleaser struct {
	retErr error
}

func (f *fakeHoldReleaser) ReleaseHold(_ context.Context, _ string) error {
	return f.retErr
}

func TestHandleMailboxReleaseHold_MethodNotAllowed(t *testing.T) {
	s := newTestServer(t).WithMailboxBP(&fakeHoldReleaser{})
	req := httptest.NewRequest(http.MethodGet, "/api/mailboxes/release-hold?address=x@y.com", nil)
	w := httptest.NewRecorder()
	s.handleMailboxReleaseHold(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestHandleMailboxReleaseHold_MissingAddress(t *testing.T) {
	s := newTestServer(t).WithMailboxBP(&fakeHoldReleaser{})
	req := httptest.NewRequest(http.MethodPost, "/api/mailboxes/release-hold", nil)
	w := httptest.NewRecorder()
	s.handleMailboxReleaseHold(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleMailboxReleaseHold_ReleaseError(t *testing.T) {
	s := newTestServer(t).WithMailboxBP(&fakeHoldReleaser{retErr: errors.New("db error")})
	req := httptest.NewRequest(http.MethodPost, "/api/mailboxes/release-hold?address=x@y.com", nil)
	w := httptest.NewRecorder()
	s.handleMailboxReleaseHold(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

func TestHandleMailboxReleaseHold_Success(t *testing.T) {
	s := newTestServer(t).WithMailboxBP(&fakeHoldReleaser{})
	req := httptest.NewRequest(http.MethodPost, "/api/mailboxes/release-hold?address=test%40example.com", nil)
	w := httptest.NewRecorder()
	s.handleMailboxReleaseHold(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestWithMailboxBP_ReturnsServer(t *testing.T) {
	s := newTestServer(t)
	s2 := s.WithMailboxBP(&fakeHoldReleaser{})
	if s2 != s {
		t.Fatal("WithMailboxBP must return same server")
	}
}
