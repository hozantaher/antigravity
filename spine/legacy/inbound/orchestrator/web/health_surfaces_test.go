package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// BF-F4 — /health surfaces wiring tests.

func TestHandleHealth_StaleAdvisoryLocks_DegradesStatus(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectPing()

	s := NewServer(db, "")
	s = s.WithHealthSurfaces(HealthSurfaces{
		StaleAdvisoryLocks: func(ctx context.Context) []int64 {
			return []int64{42, 99}
		},
	})

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	s.handleHealth(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 (stale locks should degrade)", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["status"] != "degraded" {
		t.Errorf("status = %v, want degraded", resp["status"])
	}
	ids, ok := resp["stale_advisory_lock_ids"].([]any)
	if !ok || len(ids) != 2 {
		t.Errorf("stale_advisory_lock_ids = %v, want [42 99]", resp["stale_advisory_lock_ids"])
	}
}

func TestHandleHealth_NoStaleLocks_StatusOK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectPing()

	s := NewServer(db, "")
	s = s.WithHealthSurfaces(HealthSurfaces{
		StaleAdvisoryLocks: func(ctx context.Context) []int64 { return nil },
	})

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	s.handleHealth(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (no stale locks)", w.Code)
	}
}

func TestHandleHealth_PendingEnvelopes_Surfaced(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectPing()

	s := NewServer(db, "")
	s = s.WithHealthSurfaces(HealthSurfaces{
		PendingEnvelopes: func(ctx context.Context) int { return 137 },
	})

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	s.handleHealth(w, req)

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	v, ok := resp["pending_envelopes"].(float64) // JSON numbers
	if !ok || int(v) != 137 {
		t.Errorf("pending_envelopes = %v, want 137", resp["pending_envelopes"])
	}
}

func TestHandleHealth_ProbePanic_NotPropagated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectPing()

	s := NewServer(db, "")
	s = s.WithHealthSurfaces(HealthSurfaces{
		StaleAdvisoryLocks: func(ctx context.Context) []int64 {
			panic("buggy probe")
		},
		PendingEnvelopes: func(ctx context.Context) int {
			panic("also buggy")
		},
	})

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	defer func() {
		if p := recover(); p != nil {
			t.Errorf("/health propagated panic: %v", p)
		}
	}()
	s.handleHealth(w, req)
	// Probes panicked → no fields surfaced; status stays as DB ping result.
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (DB OK + probes silenced)", w.Code)
	}
}

func TestHandleHealth_NoSurfacesWired_OmitFields(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectPing()

	s := NewServer(db, "")
	// No WithHealthSurfaces call — surfaces zero-value.

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	s.handleHealth(w, req)

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if _, has := resp["stale_advisory_lock_ids"]; has {
		t.Error("stale_advisory_lock_ids should be omitted when probe unwired")
	}
	if _, has := resp["pending_envelopes"]; has {
		t.Error("pending_envelopes should be omitted when probe unwired")
	}
	if _, has := resp["greylist_queue_depth"]; has {
		t.Error("greylist_queue_depth should be omitted when probe unwired")
	}
}
