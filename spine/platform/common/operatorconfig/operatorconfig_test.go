package operatorconfig_test

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	"common/operatorconfig"
)

// helpers ─────────────────────────────────────────────────────────────────────

func newMock(t *testing.T) (*operatorconfig.Loader, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	loader := operatorconfig.NewWithTTL(db, 60*time.Second)
	return loader, mock
}

func settingsRows(pairs ...string) *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{"key", "value"})
	for i := 0; i+1 < len(pairs); i += 2 {
		rows.AddRow(pairs[i], pairs[i+1])
	}
	return rows
}

// 1. Get — first call hits DB, returns correct value ──────────────────────────

func TestGet_FirstCallHitsDB(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("controller_name", "BALKAN MOTORS INT DOO"))

	v, err := loader.Get(context.Background(), "controller_name")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v != "BALKAN MOTORS INT DOO" {
		t.Errorf("got %q, want %q", v, "BALKAN MOTORS INT DOO")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

// 2. Get — second call within TTL uses cache (no second DB query) ─────────────

func TestGet_CacheHitOnSecondCall(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("controller_name", "BALKAN MOTORS INT DOO"))

	_, _ = loader.Get(context.Background(), "controller_name")
	// second call — must NOT trigger another DB query
	v, err := loader.Get(context.Background(), "controller_name")
	if err != nil {
		t.Fatalf("unexpected error on second call: %v", err)
	}
	if v != "BALKAN MOTORS INT DOO" {
		t.Errorf("got %q, want %q", v, "BALKAN MOTORS INT DOO")
	}
	// mock will fail if an unexpected query fires
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

// 3. Get — cache refreshes after TTL expiry ───────────────────────────────────

func TestGet_RefreshesAfterTTLExpiry(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	// Very short TTL so it expires immediately.
	loader := operatorconfig.NewWithTTL(db, 1*time.Millisecond)

	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("controller_name", "BALKAN MOTORS INT DOO"))
	_, _ = loader.Get(context.Background(), "controller_name")

	// Wait for TTL to expire.
	time.Sleep(5 * time.Millisecond)

	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("controller_name", "UPDATED NAME"))

	v, err := loader.Get(context.Background(), "controller_name")
	if err != nil {
		t.Fatalf("unexpected error after TTL: %v", err)
	}
	if v != "UPDATED NAME" {
		t.Errorf("after TTL: got %q, want %q", v, "UPDATED NAME")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

// 4. Get — missing key returns empty string (no panic) ────────────────────────

func TestGet_MissingKeyReturnsEmpty(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("other_key", "other_value"))

	v, err := loader.Get(context.Background(), "nonexistent_key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v != "" {
		t.Errorf("missing key: want empty string, got %q", v)
	}
}

// 5. GetAll — returns all pairs in snapshot ───────────────────────────────────

func TestGetAll_ReturnsAllPairs(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows(
			"controller_name", "BALKAN MOTORS INT DOO",
			"brand_label", "Garaaage",
		))

	m, err := loader.GetAll(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m["controller_name"] != "BALKAN MOTORS INT DOO" {
		t.Errorf("controller_name: got %q", m["controller_name"])
	}
	if m["brand_label"] != "Garaaage" {
		t.Errorf("brand_label: got %q", m["brand_label"])
	}
}

// 6. GetAll — second call within TTL uses cache ───────────────────────────────

func TestGetAll_CacheHit(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("data_source_label", "firmy.cz"))

	_, _ = loader.GetAll(context.Background())
	m, err := loader.GetAll(context.Background())
	if err != nil {
		t.Fatalf("unexpected error on second GetAll: %v", err)
	}
	if m["data_source_label"] != "firmy.cz" {
		t.Errorf("data_source_label: got %q", m["data_source_label"])
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

// 7. DB error propagates as error (not panic) ─────────────────────────────────

func TestGet_DBErrorPropagates(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnError(errDBDown)

	_, err := loader.Get(context.Background(), "controller_name")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// errorDB is a sentinel for mock DB errors.
type sentinelErr string

func (s sentinelErr) Error() string { return string(s) }

const errDBDown = sentinelErr("db connection refused")

// 8. InvalidateCache forces re-fetch on next Get ──────────────────────────────

func TestInvalidateCache_ForcesRefetch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	loader := operatorconfig.NewWithTTL(db, 10*time.Minute) // very long TTL

	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("controller_name", "OLD"))
	_, _ = loader.Get(context.Background(), "controller_name")

	loader.InvalidateCache()

	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("controller_name", "NEW"))
	v, err := loader.Get(context.Background(), "controller_name")
	if err != nil {
		t.Fatalf("unexpected error after InvalidateCache: %v", err)
	}
	if v != "NEW" {
		t.Errorf("after InvalidateCache: got %q, want %q", v, "NEW")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

// 9. MustGet — panics on missing key ─────────────────────────────────────────

func TestMustGet_PanicsOnMissingKey(t *testing.T) {
	loader, mock := newMock(t)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("other", "value"))

	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic for missing key, but did not panic")
		}
	}()
	loader.MustGet(context.Background(), "nonexistent")
}

// 10. Concurrent Gets are safe (race detector) ────────────────────────────────

func TestGet_ConcurrentCallsSafe(t *testing.T) {
	loader, mock := newMock(t)
	// Allow multiple queries under concurrency (TTL=1ns means re-fetches fire)
	mock.MatchExpectationsInOrder(false)
	for i := 0; i < 20; i++ {
		mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
			WillReturnRows(settingsRows("controller_name", "BALKAN MOTORS INT DOO"))
	}

	done := make(chan struct{})
	for i := 0; i < 10; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 5; j++ {
				loader.Get(context.Background(), "controller_name") //nolint:errcheck
			}
		}()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
}

// 11. New uses DefaultTTL (60s) ────────────────────────────────────────────────

func TestNew_UsesDefaultTTL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	loader := operatorconfig.New(db)

	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(settingsRows("brand_label", "Garaaage"))

	v, err := loader.Get(context.Background(), "brand_label")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v != "Garaaage" {
		t.Errorf("got %q, want %q", v, "Garaaage")
	}
	// Second call within 60s must hit cache (no second DB expectation set).
	v2, err := loader.Get(context.Background(), "brand_label")
	if err != nil {
		t.Fatalf("unexpected error on second call: %v", err)
	}
	if v2 != "Garaaage" {
		t.Errorf("cached: got %q, want %q", v2, "Garaaage")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}
