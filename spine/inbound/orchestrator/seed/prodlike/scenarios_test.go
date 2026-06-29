package prodlike

import (
	"strconv"
	"strings"
	"testing"
)

// TestAllScenariosIncludesNewPlanScenarios guards against accidental
// removal of 3F/3G from the dispatch list. These two scenarios are the
// completion of the original COMMIT-PLAN prodlike roadmap — if they
// vanish the dashboard loses honeypot-panel coverage and exclusion-status
// representation at small scales.
func TestAllScenariosIncludesNewPlanScenarios(t *testing.T) {
	got := AllScenarios()
	want := map[string]bool{
		"campaign_running":   true,
		"campaign_completed": true,
		"bounce_spiral":      true,
		"replies_classified": true,
		"unsubscribe_flow":   true,
		"honeypot_coverage":  true,
		"exclusion_cases":    true,
	}
	if len(got) != len(want) {
		t.Fatalf("AllScenarios length mismatch: got %d (%v), want %d", len(got), got, len(want))
	}
	seen := map[string]bool{}
	for _, n := range got {
		if !want[n] {
			t.Errorf("unexpected scenario %q", n)
		}
		if seen[n] {
			t.Errorf("duplicate scenario %q", n)
		}
		seen[n] = true
	}
	for n := range want {
		if !seen[n] {
			t.Errorf("missing scenario %q from AllScenarios()", n)
		}
	}
}

// TestInt64ArrayLiteralFormat verifies the Postgres bigint[] literal
// emitted by int64Array. Wrong curly-brace or comma handling would turn
// the exclusion_cases UPDATE into a parse error at runtime.
func TestInt64ArrayLiteralFormat(t *testing.T) {
	cases := []struct {
		in   []int64
		want string
	}{
		{nil, "{}"},
		{[]int64{}, "{}"},
		{[]int64{1}, "{1}"},
		{[]int64{1, 2, 3}, "{1,2,3}"},
		{[]int64{42, 7, 9999999999}, "{42,7,9999999999}"},
		{[]int64{0}, "{0}"},
		{[]int64{-1}, "{-1}"},
	}
	for _, tc := range cases {
		got := int64Array(tc.in)
		if got != tc.want {
			t.Errorf("int64Array(%v) = %q, want %q", tc.in, got, tc.want)
		}
		// Cross-check each non-empty token parses back to a valid int64.
		if len(tc.in) > 0 {
			inner := strings.Trim(got, "{}")
			for i, tok := range strings.Split(inner, ",") {
				n, err := strconv.ParseInt(tok, 10, 64)
				if err != nil {
					t.Errorf("token %q failed ParseInt: %v", tok, err)
				}
				if n != tc.in[i] {
					t.Errorf("round-trip mismatch at idx %d: %d != %d", i, n, tc.in[i])
				}
			}
		}
	}
}

// TestFmtAppendIntEdges exercises the tiny internal int-to-bytes helper
// since it replaces strconv and any off-by-one in the reversal loop
// would silently corrupt array literals emitted for the 3G UPDATEs.
func TestFmtAppendIntEdges(t *testing.T) {
	cases := []struct {
		n    int64
		want string
	}{
		{0, "0"},
		{1, "1"},
		{9, "9"},
		{10, "10"},
		{12345, "12345"},
		{-0, "0"},
		{-42, "-42"},
	}
	for _, tc := range cases {
		got := string(fmtAppendInt(nil, tc.n))
		if got != tc.want {
			t.Errorf("fmtAppendInt(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}

// TestScenarioResultExposesNewPlanFields ensures downstream CLI+dashboard
// consumers have both aggregate counters. A struct field rename or
// removal during refactoring would break the CLI print-line, so this
// guards against that regression at compile-time.
func TestScenarioResultExposesNewPlanFields(t *testing.T) {
	var r ScenarioResult
	r.HoneypotSignals = 15
	r.CompaniesUpdated = 38
	if r.HoneypotSignals != 15 {
		t.Errorf("HoneypotSignals field did not round-trip")
	}
	if r.CompaniesUpdated != 38 {
		t.Errorf("CompaniesUpdated field did not round-trip")
	}
}
