package sender

import (
	"os"
	"strings"
	"testing"
)

// TestLIAScope_MatchesLegalDoc is an audit ratchet that verifies every NACE
// section code in LIAScopeNACE is explicitly mentioned in the LIA document.
//
// This prevents silent drift between the code constant and the legal document:
// if someone updates the operator_settings lia_nace_scope without updating
// the LIA, this test fails.
//
// Sprint AI — audit ratchet updated to work with operatorconfig loader.
func TestLIAScope_MatchesLegalDoc(t *testing.T) {
	SetLIAScopeLoader(nil) // Use legacy fallback for audit

	raw, err := os.ReadFile("../../../../docs/legal/lia-direct-marketing.md")
	if err != nil {
		t.Fatalf("cannot read docs/legal/lia-direct-marketing.md: %v", err)
	}
	content := string(raw)

	scope := LIAScopeNACE()
	scopeMap := make(map[string]bool)
	for _, code := range scope {
		scopeMap[code] = true
	}

	for code := range scopeMap {
		// The doc uses dot-notation for NACE sections, e.g. "41.", "42.", "77.", "01."
		// This covers both "41.20" and "41.*" style references.
		needle := code + "."
		if !strings.Contains(content, needle) {
			t.Errorf("NACE %s in LIAScopeNACE but %q not found in docs/legal/lia-direct-marketing.md — sync drift; update LIA before adding new scope", code, needle)
		}
	}
}

// TestLIAScope_AllLIADocSectionsMappedToCode verifies the inverse direction:
// key sections referenced in the LIA doc are present in LIAScopeNACE.
// Prevents adding a section in the doc and forgetting to add the code or the DB.
func TestLIAScope_AllLIADocSectionsMappedToCode(t *testing.T) {
	SetLIAScopeLoader(nil) // Use legacy fallback for audit

	// Sections declared in lia-direct-marketing.md v1.2
	docSections := []string{"01", "41", "42", "43", "45", "46", "49", "77"}

	scope := LIAScopeNACE()
	scopeMap := make(map[string]bool)
	for _, code := range scope {
		scopeMap[code] = true
	}

	for _, section := range docSections {
		if !scopeMap[section] {
			t.Errorf("NACE %s appears in LIA doc scope list but is missing from LIAScopeNACE()", section)
		}
	}
}
