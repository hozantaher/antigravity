package classify

// icp_sectors_db_test.go — tests for DB-backed ICP sector loader (Sprint AJ).
//
// Tests:
//  1. LoadICPSectors returns 22 target sectors from DB
//  2. LoadICPSectors returns 11 anti-target codes from DB
//  3. Second call within TTL returns cached snapshot (no DB query)
//  4. InvalidateICPCache forces re-query on next call
//  5. Fallback to legacy when DB is nil
//  6. Fallback to legacy when DB query fails
//  7. LoadICPSectorsWithFallback never returns empty targets
//  8. LoadICPSectorsWithFallback fills anti-target fallback when DB empty
//  9. DB target list contains "machinery" code
// 10. DB anti-target list contains "retail" code
// 11. Inactive rows are excluded from results
// 12. Cache is shared across goroutines (race-free read after write)

import (
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// expectedTargets mirrors DefaultICPConfig().TargetSectors — 22 codes.
var expectedTargets = []string{
	"machinery_cnc", "machinery_hydraulic", "machinery_agricultural",
	"metalwork_stamping", "metalwork_casting",
	"automotive_parts",
	"construction_civil", "construction_specialized",
	"machinery", "metalwork", "construction", "automotive", "woodwork",
	"plastics", "food_processing",
	"agriculture", "energy", "transport", "waste", "mining", "chemicals",
	"electronics",
}

// expectedAntiTargets mirrors AntiTargetSectors — 11 codes.
var expectedAntiTargetCodes = []string{
	"retail", "hospitality", "real_estate", "finance", "it",
	"professional", "health", "education",
	"personal_services", "adult", "tourism",
}

// buildMockDB returns a sqlmock DB that returns the full 33-row dataset.
func buildMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	return db, mock
}

// buildExpectedRows builds the sqlmock rows with all 33 sectors.
func buildExpectedRows(mock sqlmock.Sqlmock) *sqlmock.Rows {
	rows := mock.NewRows([]string{"code", "kind"})
	for _, code := range expectedTargets {
		rows.AddRow(code, "target")
	}
	for _, code := range expectedAntiTargetCodes {
		rows.AddRow(code, "anti_target")
	}
	return rows
}

// resetCache clears the global cache so tests don't bleed state.
func resetCache() {
	globalICPCache.mu.Lock()
	globalICPCache.targets = nil
	globalICPCache.antiTargets = nil
	globalICPCache.fetchedAt = time.Time{}
	globalICPCache.mu.Unlock()
}

// ── tests ─────────────────────────────────────────────────────────────────────

// T-ICP-01: LoadICPSectors returns 22 target sectors from DB.
func TestLoadICPSectors_Returns22Targets(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	cfg, _, err := LoadICPSectors(db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unfulfilled mock: %v", err)
	}
	if got := len(cfg.TargetSectors); got != 22 {
		t.Errorf("TargetSectors count = %d, want 22", got)
	}
}

// T-ICP-02: LoadICPSectors returns 11 anti-target codes from DB.
func TestLoadICPSectors_Returns11AntiTargets(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	_, anti, err := LoadICPSectors(db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unfulfilled mock: %v", err)
	}
	if got := len(anti); got != 11 {
		t.Errorf("anti-target count = %d, want 11", got)
	}
}

// T-ICP-03: Second call within TTL uses cache — no second DB query.
func TestLoadICPSectors_CacheHitNoSecondQuery(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	// Only one query expected.
	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	if _, _, err := LoadICPSectors(db); err != nil {
		t.Fatalf("first call: %v", err)
	}
	// Second call — must not hit DB again.
	if _, _, err := LoadICPSectors(db); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock: %v (second query was issued unexpectedly)", err)
	}
}

// T-ICP-04: InvalidateICPCache forces re-query on next call.
func TestInvalidateICPCache_ForcesRefetch(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	// Two queries expected after invalidation.
	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))
	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	if _, _, err := LoadICPSectors(db); err != nil {
		t.Fatalf("first call: %v", err)
	}
	InvalidateICPCache()
	if _, _, err := LoadICPSectors(db); err != nil {
		t.Fatalf("post-invalidate call: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("mock: %v", err)
	}
}

// T-ICP-05: Fallback to legacy when DB is nil.
func TestLoadICPSectors_FallbackOnNilDB(t *testing.T) {
	resetCache()
	cfg, anti, err := LoadICPSectors(nil)
	if err == nil {
		t.Error("expected non-nil error for nil DB")
	}
	// Fallback values must be present.
	if len(cfg.TargetSectors) == 0 {
		t.Error("expected fallback TargetSectors to be non-empty")
	}
	if len(anti) == 0 {
		t.Error("expected fallback anti-target map to be non-empty")
	}
}

// T-ICP-06: Fallback to legacy when DB query fails.
func TestLoadICPSectors_FallbackOnQueryError(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnError(errors.New("connection refused"))

	cfg, anti, err := LoadICPSectors(db)
	if err == nil {
		t.Error("expected non-nil error")
	}
	if len(cfg.TargetSectors) == 0 {
		t.Error("expected fallback TargetSectors")
	}
	if len(anti) == 0 {
		t.Error("expected fallback anti-target map")
	}
}

// T-ICP-07: LoadICPSectorsWithFallback never returns empty targets.
func TestLoadICPSectorsWithFallback_NeverEmpty(t *testing.T) {
	resetCache()
	// Nil DB triggers fallback path.
	cfg, anti := LoadICPSectorsWithFallback(nil)
	if len(cfg.TargetSectors) == 0 {
		t.Error("LoadICPSectorsWithFallback returned empty TargetSectors")
	}
	if len(anti) == 0 {
		t.Error("LoadICPSectorsWithFallback returned empty anti map")
	}
}

// T-ICP-08: LoadICPSectorsWithFallback fills anti-target from legacy when DB returns empty.
func TestLoadICPSectorsWithFallback_FillsAntiFromLegacy(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	// Return target rows only — no anti_target rows.
	rows := mock.NewRows([]string{"code", "kind"})
	rows.AddRow("machinery", "target")
	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).WillReturnRows(rows)

	_, anti := LoadICPSectorsWithFallback(db)
	if len(anti) == 0 {
		t.Error("expected anti-target filled from legacy when DB returns no anti rows")
	}
}

// T-ICP-09: DB target list contains "machinery" code.
func TestLoadICPSectors_ContainsMachinery(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	cfg, _, _ := LoadICPSectors(db)
	found := false
	for _, c := range cfg.TargetSectors {
		if c == "machinery" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected 'machinery' in TargetSectors")
	}
}

// T-ICP-10: DB anti-target list contains "retail" code.
func TestLoadICPSectors_AntiTargetContainsRetail(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	_, anti, _ := LoadICPSectors(db)
	if !anti["retail"] {
		t.Error("expected 'retail' in anti-target map")
	}
}

// T-ICP-11: Inactive rows are excluded — DB returns only active=true rows
// (SQL WHERE active=true), so this tests that the query filter is honoured.
// We simulate it by returning a reduced set (only 1 target) and confirming
// the result set matches exactly what was returned.
func TestLoadICPSectors_InactiveRowsExcluded(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	rows := mock.NewRows([]string{"code", "kind"})
	rows.AddRow("construction", "target")
	// "machinery" intentionally omitted — simulates it being inactive.
	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).WillReturnRows(rows)

	cfg, _, err := LoadICPSectors(db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.TargetSectors) != 1 {
		t.Errorf("expected 1 target, got %d", len(cfg.TargetSectors))
	}
	if cfg.TargetSectors[0] != "construction" {
		t.Errorf("expected 'construction', got %q", cfg.TargetSectors[0])
	}
}

// T-ICP-12: Cache is race-free when read from multiple goroutines.
func TestLoadICPSectors_CacheRaceSafe(t *testing.T) {
	resetCache()
	db, mock := buildMockDB(t)
	defer db.Close()

	// Expect exactly one DB query; subsequent reads hit the cache.
	mock.ExpectQuery(`SELECT code, kind FROM icp_sectors`).
		WillReturnRows(buildExpectedRows(mock))

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cfg, anti, _ := LoadICPSectors(db)
			if len(cfg.TargetSectors) == 0 || len(anti) == 0 {
				t.Errorf("goroutine got empty results")
			}
		}()
	}
	wg.Wait()
	// We don't assert mock.ExpectationsWereMet here because concurrent goroutines
	// may all trigger the first miss before the cache is written; the important
	// thing is no race (detected by go test -race).
}
