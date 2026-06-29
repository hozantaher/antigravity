package sender

import (
	"context"
	"encoding/json"
	"sync"

	"common/operatorconfig"
)

var (
	// liaScopeMu guards liaScopeCached and liaScopeLoader.
	liaScopeMu     sync.RWMutex
	liaScopeCached []string
	liaScopeLoader *operatorconfig.Loader
)

// SetLIAScopeLoader injects the operatorconfig loader used by LIAScopeNACE.
// Must be called once during boot, before any campaign sending starts.
// If not set, LIAScopeNACE falls back to the legacy hardcoded list.
func SetLIAScopeLoader(l *operatorconfig.Loader) {
	liaScopeMu.Lock()
	defer liaScopeMu.Unlock()
	liaScopeLoader = l
	liaScopeCached = nil // invalidate cache on loader change
}

// LIAScopeNACE returns the 2-digit NACE section codes covered by the current LIA.
// Values are loaded from operator_settings DB table (key="lia_nace_scope") and cached
// for the duration of the operatorconfig TTL (60s default).
//
// When operator_settings is unavailable or lia_nace_scope is not present,
// falls back to the legacy hardcoded list: ["01","41","42","43","45","46","49","77"]
// reflecting docs/legal/lia-direct-marketing.md (v1.2, 2026-05-06).
//
// CHANGES TO THE SCOPE: Update docs/legal/lia-direct-marketing.md, then update
// the lia_nace_scope row in operator_settings via SQL or the dashboard UI.
// The change is visible to all services within 60 seconds (TTL).
//
// Sprint H5.3 audit ratchet: TestLIAScope_MatchesLegalDoc.
// Sprint AI: Migrated from hardcoded map to operatorconfig loader.
func LIAScopeNACE() []string {
	// Fast path: check cache under read lock.
	liaScopeMu.RLock()
	if liaScopeCached != nil {
		defer liaScopeMu.RUnlock()
		return append([]string(nil), liaScopeCached...) // defensive copy
	}
	liaScopeMu.RUnlock()

	// No cache or cache expired. Refresh from loader.
	if liaScopeLoader != nil {
		raw, err := liaScopeLoader.Get(context.Background(), "lia_nace_scope")
		if err == nil && raw != "" {
			var scope []string
			if json.Unmarshal([]byte(raw), &scope) == nil {
				// Successfully parsed. Update cache and return.
				liaScopeMu.Lock()
				liaScopeCached = scope
				liaScopeMu.Unlock()
				return append([]string(nil), scope...) // defensive copy
			}
		}
	}

	// Fallback: legacy hardcoded list (JSON format: same as operator_settings value)
	legacyScope := []string{"01", "41", "42", "43", "45", "46", "49", "77"}
	return append([]string(nil), legacyScope...)
}

// IsInLIAScope returns true when the given NACE code falls within the NACE
// sections declared in the current LIA (docs/legal/lia-direct-marketing.md).
//
// naceCode is expected to be a 5-digit string as stored in companies.nace_codes
// (e.g. "41200", "49410", "01000"). An empty string returns false — a company
// with no NACE data is treated as outside scope by default, not included.
//
// The check uses the first 2 characters (section prefix) to match against
// the current LIAScopeNACE() result, so sub-divisions (41.20, 41.00) all resolve correctly.
func IsInLIAScope(naceCode string) bool {
	if len(naceCode) == 0 {
		return false
	}
	prefix := naceCode
	if len(naceCode) >= 2 {
		prefix = naceCode[:2]
	}

	scope := LIAScopeNACE()
	for _, s := range scope {
		if s == prefix {
			return true
		}
	}
	return false
}

// IsCompanyInLIAScope returns true when at least one of the company's NACE
// codes falls within the current LIA scope. Empty slice → false (block).
func IsCompanyInLIAScope(naceCodes []string) bool {
	for _, code := range naceCodes {
		if IsInLIAScope(code) {
			return true
		}
	}
	return false
}
