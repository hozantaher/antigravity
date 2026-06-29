package sender

import (
	"testing"

	"common/operatorconfig"
	"github.com/DATA-DOG/go-sqlmock"
)

// ── LIAScopeNACE loader tests ─────────────────────────────────────────────────

func TestLIAScopeNACE_FallbackWhenNoLoader(t *testing.T) {
	// Reset to no loader
	SetLIAScopeLoader(nil)

	scope := LIAScopeNACE()
	if len(scope) != 8 {
		t.Errorf("LIAScopeNACE() fallback length = %d, want 8", len(scope))
	}
	expected := map[string]bool{"01": true, "41": true, "42": true, "43": true, "45": true, "46": true, "49": true, "77": true}
	for _, code := range scope {
		if !expected[code] {
			t.Errorf("LIAScopeNACE() fallback contains unexpected %q", code)
		}
	}
}

func TestLIAScopeNACE_DefensiveCopy(t *testing.T) {
	SetLIAScopeLoader(nil)

	scope1 := LIAScopeNACE()
	scope2 := LIAScopeNACE()

	// Both should contain the same values
	if len(scope1) != len(scope2) {
		t.Errorf("defensive copy length mismatch")
	}

	// Modifying one should not affect the other
	scope1[0] = "XX"
	if scope2[0] == "XX" {
		t.Error("defensive copy failed — modifying scope1[0] affected scope2[0]")
	}
}

func TestSetLIAScopeLoader(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	// Mock the operatorconfig query
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(sqlmock.NewRows([]string{"key", "value"}).
			AddRow("lia_nace_scope", `["01","41","42","43","45","46","49","77"]`))

	loader := operatorconfig.NewWithTTL(db, 0) // TTL=0 so every call refreshes

	SetLIAScopeLoader(loader)

	scope := LIAScopeNACE()
	if len(scope) != 8 {
		t.Errorf("LIAScopeNACE() with loader length = %d, want 8", len(scope))
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("ExpectationsWereMet() error: %v", err)
	}
}

func TestLIAScopeNACE_CacheHit(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	// Expect only ONE query (cache hit on second call)
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(sqlmock.NewRows([]string{"key", "value"}).
			AddRow("lia_nace_scope", `["01","41"]`))

	loader := operatorconfig.NewWithTTL(db, 1000*1000*1000) // TTL=1s (won't expire in test)

	SetLIAScopeLoader(loader)

	// First call — cache miss, DB refresh
	scope1 := LIAScopeNACE()
	if len(scope1) != 2 {
		t.Errorf("First call length = %d, want 2", len(scope1))
	}

	// Second call — should hit cache (no new DB query)
	scope2 := LIAScopeNACE()
	if len(scope2) != 2 {
		t.Errorf("Second call length = %d, want 2", len(scope2))
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("ExpectationsWereMet() error: %v", err)
	}
}

func TestLIAScopeNACE_JSONParseError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error: %v", err)
	}
	defer db.Close()

	// Return invalid JSON
	mock.ExpectQuery(`SELECT key, value FROM operator_settings`).
		WillReturnRows(sqlmock.NewRows([]string{"key", "value"}).
			AddRow("lia_nace_scope", `not valid json`))

	loader := operatorconfig.NewWithTTL(db, 0)
	SetLIAScopeLoader(loader)

	// Should fall back to legacy
	scope := LIAScopeNACE()
	if len(scope) != 8 {
		t.Errorf("LIAScopeNACE() fallback on parse error length = %d, want 8", len(scope))
	}
}

// ── IsInLIAScope unit tests ───────────────────────────────────────────────────

func TestIsInLIAScope_HappyPath_AllSections(t *testing.T) {
	SetLIAScopeLoader(nil) // Use fallback

	inScope := []string{
		"01000", // zemědělství
		"41200", // výstavba budov
		"42000", // inženýrské stavitelství
		"43110", // demolice
		"45200", // autoopravárenství
		"46900", // velkoobchod
		"49410", // nákladní doprava
		"77320", // pronájem stavebních strojů
	}
	for _, code := range inScope {
		if !IsInLIAScope(code) {
			t.Errorf("IsInLIAScope(%q) = false, want true", code)
		}
	}
}

func TestIsInLIAScope_OutsideScope(t *testing.T) {
	SetLIAScopeLoader(nil) // Use fallback

	outOfScope := []string{
		"70100", // poradenství (holdingové spol.)
		"62010", // vývoj softwaru
		"85100", // vzdělávání
		"56100", // stravování
		"47190", // maloobchod — NACE 47, ne 46
		"96020", // kadeřnictví
		"84110", // státní správa
		"86100", // nemocnice
	}
	for _, code := range outOfScope {
		if IsInLIAScope(code) {
			t.Errorf("IsInLIAScope(%q) = true, want false", code)
		}
	}
}

func TestIsInLIAScope_EmptyString(t *testing.T) {
	SetLIAScopeLoader(nil)

	if IsInLIAScope("") {
		t.Error("IsInLIAScope(\"\") = true, want false — empty = outside scope by default")
	}
}

func TestIsInLIAScope_SingleDigit(t *testing.T) {
	SetLIAScopeLoader(nil)

	// Single char — len < 2, fallback to full string key; "4" is not in scope.
	if IsInLIAScope("4") {
		t.Error("IsInLIAScope(\"4\") should be false")
	}
}

func TestIsInLIAScope_ExactTwoDigitKey(t *testing.T) {
	SetLIAScopeLoader(nil)

	// Some data sources may store bare "41" or "49".
	if !IsInLIAScope("41") {
		t.Error("IsInLIAScope(\"41\") should be true — 2-char prefix match")
	}
	if !IsInLIAScope("49") {
		t.Error("IsInLIAScope(\"49\") should be true — 2-char prefix match")
	}
}

func TestIsInLIAScope_SubDivisionResolvesToSection(t *testing.T) {
	SetLIAScopeLoader(nil)

	// 41.20 → section 41 → in scope
	if !IsInLIAScope("4120") {
		t.Error("IsInLIAScope(\"4120\") should be true")
	}
	// 43.99 → section 43 → in scope
	if !IsInLIAScope("43990") {
		t.Error("IsInLIAScope(\"43990\") should be true")
	}
	// 77.31 → section 77 → in scope
	if !IsInLIAScope("77310") {
		t.Error("IsInLIAScope(\"77310\") should be true")
	}
}

func TestIsInLIAScope_Whitespace(t *testing.T) {
	SetLIAScopeLoader(nil)

	// Leading space: " 41" → prefix is " 4" → not in scope.
	if IsInLIAScope(" 41") {
		t.Error("IsInLIAScope(\" 41\") should be false — leading space shifts prefix")
	}
	// "41 " → prefix is "41" → IS in scope (trailing space does not affect 2-char prefix).
	// This is the correct behavior: the function uses first 2 chars, not the full string.
	if !IsInLIAScope("41 ") {
		t.Error("IsInLIAScope(\"41 \") should be true — first 2 chars are '41' which is in scope")
	}
}

func TestIsInLIAScope_LowercaseNonNumeric(t *testing.T) {
	SetLIAScopeLoader(nil)

	// NACE codes are numeric; non-numeric values should not match.
	if IsInLIAScope("ab000") {
		t.Error("IsInLIAScope(\"ab000\") should be false")
	}
	// "G" appeared in DB as a free-text sector label — must be blocked.
	if IsInLIAScope("G") {
		t.Error("IsInLIAScope(\"G\") should be false")
	}
}

// ── IsCompanyInLIAScope unit tests ────────────────────────────────────────────

func TestIsCompanyInLIAScope_AtLeastOneInScope(t *testing.T) {
	SetLIAScopeLoader(nil)

	codes := []string{"70100", "41200", "85100"} // second is in scope
	if !IsCompanyInLIAScope(codes) {
		t.Error("IsCompanyInLIAScope should return true when at least one code is in scope")
	}
}

func TestIsCompanyInLIAScope_AllOutsideScope(t *testing.T) {
	SetLIAScopeLoader(nil)

	codes := []string{"70100", "62010", "85100"}
	if IsCompanyInLIAScope(codes) {
		t.Error("IsCompanyInLIAScope should return false when all codes are outside scope")
	}
}

func TestIsCompanyInLIAScope_EmptySlice(t *testing.T) {
	SetLIAScopeLoader(nil)

	if IsCompanyInLIAScope([]string{}) {
		t.Error("IsCompanyInLIAScope([]) should return false")
	}
}

func TestIsCompanyInLIAScope_NilSlice(t *testing.T) {
	SetLIAScopeLoader(nil)

	if IsCompanyInLIAScope(nil) {
		t.Error("IsCompanyInLIAScope(nil) should return false")
	}
}

func TestIsCompanyInLIAScope_EmptyCodeInSlice(t *testing.T) {
	SetLIAScopeLoader(nil)

	codes := []string{"", "70100", ""}
	if IsCompanyInLIAScope(codes) {
		t.Error("IsCompanyInLIAScope should return false when only empty/out-of-scope codes present")
	}
}
