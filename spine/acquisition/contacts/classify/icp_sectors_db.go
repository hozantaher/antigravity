package classify

// icp_sectors_db.go — DB-backed ICP sector loader (Sprint AJ).
//
// Loads target and anti-target sector lists from the icp_sectors table
// (migration 061) so the operator can experiment without code deploys.
//
// Backward compat guarantee:
//   If DB is nil or the query fails, LoadICPSectors falls back to the
//   hardcoded DefaultICPConfig() / AntiTargetSectors values and logs a
//   warning. Existing callers that call DefaultICPConfig() directly
//   continue to work unchanged.
//
// Usage:
//   cfg, anti, err := LoadICPSectors(db)
//   // cfg is an ICPConfig with TargetSectors populated from DB
//   // anti is a map[string]bool replaceing the package-level AntiTargetSectors

import (
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const icpSectorCacheTTL = 5 * time.Minute

// dbICPSector is the DB row shape returned by the loader query.
type dbICPSector struct {
	Code string
	Kind string // "target" | "anti_target"
}

// icpSectorCache holds a TTL-cached snapshot of the DB rows.
type icpSectorCache struct {
	mu          sync.RWMutex
	targets     []string
	antiTargets map[string]bool
	fetchedAt   time.Time
}

var globalICPCache = &icpSectorCache{}

// LoadICPSectors queries the icp_sectors table and returns:
//   - ICPConfig{TargetSectors: [...]} built from active target rows, ordered
//     by weight DESC then code ASC (mirrors DefaultICPConfig ordering).
//   - map[string]bool of active anti_target codes (mirrors AntiTargetSectors).
//
// Results are cached for icpSectorCacheTTL. Subsequent calls within the TTL
// return the cached snapshot without hitting the DB.
//
// If db is nil or the query fails, returns the legacy hardcoded values and
// logs a warning. This ensures the classify job degrades gracefully during
// DB connectivity issues.
func LoadICPSectors(db *sql.DB) (ICPConfig, map[string]bool, error) {
	globalICPCache.mu.RLock()
	if time.Since(globalICPCache.fetchedAt) < icpSectorCacheTTL {
		cfg := ICPConfig{TargetSectors: globalICPCache.targets}
		anti := globalICPCache.antiTargets
		globalICPCache.mu.RUnlock()
		return cfg, anti, nil
	}
	globalICPCache.mu.RUnlock()

	// Cache miss — fetch from DB.
	targets, antiTargets, err := fetchICPSectorsFromDB(db)
	if err != nil {
		slog.Warn("classify.LoadICPSectors/db_error",
			"op", "classify.LoadICPSectors/db_error",
			"error", err,
			"fallback", "legacy hardcoded",
		)
		return DefaultICPConfig(), legacyAntiTargets(), err
	}

	globalICPCache.mu.Lock()
	globalICPCache.targets = targets
	globalICPCache.antiTargets = antiTargets
	globalICPCache.fetchedAt = time.Now()
	globalICPCache.mu.Unlock()

	return ICPConfig{TargetSectors: targets}, antiTargets, nil
}

// InvalidateICPCache forces the next LoadICPSectors call to re-query the DB.
// Call this after any operator update to icp_sectors.
func InvalidateICPCache() {
	globalICPCache.mu.Lock()
	globalICPCache.fetchedAt = time.Time{}
	globalICPCache.mu.Unlock()
}

// fetchICPSectorsFromDB executes the query and returns parsed results.
func fetchICPSectorsFromDB(db *sql.DB) (targets []string, antiTargets map[string]bool, err error) {
	if db == nil {
		return nil, nil, fmt.Errorf("classify.LoadICPSectors: db is nil")
	}

	rows, err := db.Query(`
		SELECT code, kind
		FROM icp_sectors
		WHERE active = true
		ORDER BY
			kind ASC,
			weight DESC,
			code  ASC
	`)
	if err != nil {
		return nil, nil, fmt.Errorf("classify.LoadICPSectors: query: %w", err)
	}
	defer rows.Close()

	antiTargets = make(map[string]bool)
	for rows.Next() {
		var s dbICPSector
		if err = rows.Scan(&s.Code, &s.Kind); err != nil {
			return nil, nil, fmt.Errorf("classify.LoadICPSectors: scan: %w", err)
		}
		switch s.Kind {
		case "target":
			targets = append(targets, s.Code)
		case "anti_target":
			antiTargets[s.Code] = true
		}
	}
	if err = rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("classify.LoadICPSectors: rows: %w", err)
	}

	return targets, antiTargets, nil
}

// legacyAntiTargets returns the original hardcoded anti-target set.
// Used as fallback when DB is unavailable.
func legacyAntiTargets() map[string]bool {
	result := make(map[string]bool, len(AntiTargetSectors))
	for k, v := range AntiTargetSectors {
		result[k] = v
	}
	return result
}

// LoadICPSectorsWithFallback is the recommended entrypoint for the classify job.
// It never returns an error — DB failures produce a warning log + legacy values.
func LoadICPSectorsWithFallback(db *sql.DB) (ICPConfig, map[string]bool) {
	cfg, anti, _ := LoadICPSectors(db)
	// If DB returned empty target list, substitute the hardcoded default so the
	// job is never silently neutered (empty target list → all scores = 0).
	if len(cfg.TargetSectors) == 0 {
		return DefaultICPConfig(), anti
	}
	if len(anti) == 0 {
		anti = legacyAntiTargets()
	}
	return cfg, anti
}
