package sqlsuppression

import (
	"strings"
	"testing"
)

// TestUnionSelect_ReferencesBothTables locks the canonical UNION SELECT
// to surface BOTH suppression tables. Removing either side would silently
// leak suppressed addresses through every read site that depends on this
// fragment (campaign runner, preflight gate, BFF preflight). This is the
// last-line discipline test against accidental refactor.
func TestUnionSelect_ReferencesBothTables(t *testing.T) {
	if !strings.Contains(UnionSelect, "outreach_suppressions") {
		t.Errorf("UnionSelect missing outreach_suppressions — Go-side suppressions would leak\n%s", UnionSelect)
	}
	if !strings.Contains(UnionSelect, "suppression_list") {
		t.Errorf("UnionSelect missing suppression_list — UI-added suppressions would leak\n%s", UnionSelect)
	}
	if !strings.Contains(UnionSelect, "UNION") {
		t.Errorf("UnionSelect missing UNION between tables\n%s", UnionSelect)
	}
}

// TestUnionSelect_NormalizesBothSides confirms each table is wrapped in
// lower(trim(...)) so case/whitespace drift between writers cannot leak
// suppressed entries through the filter.
func TestUnionSelect_NormalizesBothSides(t *testing.T) {
	if strings.Count(UnionSelect, "lower(trim(email))") < 2 {
		t.Errorf("UnionSelect must call lower(trim(email)) on BOTH UNION sides\n%s", UnionSelect)
	}
}

// TestUnionSelect_FiltersNullEmails confirms the SELECT skips NULL email
// rows on both sides — UNION on a NULL would propagate as a NULL in the
// outer NOT-IN, making the filter useless ("x NOT IN (NULL, ...)" is NULL,
// not true).
func TestUnionSelect_FiltersNullEmails(t *testing.T) {
	if strings.Count(UnionSelect, "email IS NOT NULL") < 2 {
		t.Errorf("UnionSelect must filter NULL emails on both sides — NOT IN with NULL silently fails\n%s", UnionSelect)
	}
}

// TestNotInUnionWhere_SubstitutesPlaceholder verifies the column
// placeholder is rewritten so callers cannot accidentally emit literal
// {col} into the SQL.
func TestNotInUnionWhere_SubstitutesPlaceholder(t *testing.T) {
	for _, col := range []string{"c.email", "lower(c.email)", "x.email", "email"} {
		got := NotInUnionWhere(col)
		if strings.Contains(got, "{col}") {
			t.Errorf("placeholder leaked for col=%q: %s", col, got)
		}
		if !strings.Contains(got, col) {
			t.Errorf("column %q not present in result: %s", col, got)
		}
	}
}

// TestNotInUnionWhere_NormalizesLHS asserts the candidate column is also
// wrapped in lower(trim(...)) — without that, a stored "Foo@Bar.cz" entry
// would not match an outer "foo@bar.cz" candidate.
func TestNotInUnionWhere_NormalizesLHS(t *testing.T) {
	got := NotInUnionWhere("c.email")
	if !strings.Contains(got, "lower(trim(c.email))") {
		t.Errorf("LHS not normalized: %s", got)
	}
}

// TestNotInUnionWhere_HasNotInClause is paranoid — the helper must emit
// NOT IN, not IN. A typo here would invert the filter and send to every
// suppressed contact.
func TestNotInUnionWhere_HasNotInClause(t *testing.T) {
	got := NotInUnionWhere("c.email")
	if !strings.Contains(got, "NOT IN") {
		t.Fatalf("filter inverted (missing NOT IN): %s", got)
	}
}

// TestCountUnionSQL_HasCountAggregator confirms the COUNT query stays an
// aggregate — a refactor that drops COUNT(*) would silently change the
// caller's interpretation (rows-instead-of-count).
func TestCountUnionSQL_HasCountAggregator(t *testing.T) {
	if !strings.Contains(CountUnionSQL, "COUNT(*)") {
		t.Errorf("CountUnionSQL missing COUNT(*): %s", CountUnionSQL)
	}
	if !strings.Contains(CountUnionSQL, "outreach_suppressions") {
		t.Errorf("CountUnionSQL must inline UnionSelect — missing outreach_suppressions: %s", CountUnionSQL)
	}
	if !strings.Contains(CountUnionSQL, "suppression_list") {
		t.Errorf("CountUnionSQL must inline UnionSelect — missing suppression_list: %s", CountUnionSQL)
	}
}

// TestEnsureContainsBothTables checks the discipline-test helper's
// own truth-table.
func TestEnsureContainsBothTables(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want bool
	}{
		{"canonical", UnionSelect, true},
		{"missing outreach_suppressions", "SELECT email FROM suppression_list UNION SELECT email FROM other", false},
		{"missing suppression_list", "SELECT email FROM outreach_suppressions", false},
		{"missing UNION", "SELECT email FROM outreach_suppressions, suppression_list", false},
		{"empty", "", false},
		{"all three present", "outreach_suppressions UNION suppression_list", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EnsureContainsBothTables(tc.sql)
			if got != tc.want {
				t.Errorf("EnsureContainsBothTables(%q) = %v, want %v", tc.sql, got, tc.want)
			}
		})
	}
}

// TestNotInUnionWhere_DifferentColumnsDoNotShareReference is a paranoid
// table test — ensures every call returns a string not aliased to a
// shared mutable state.
func TestNotInUnionWhere_DifferentColumnsDoNotShareReference(t *testing.T) {
	a := NotInUnionWhere("c.email")
	b := NotInUnionWhere("x.email")
	if a == b {
		t.Errorf("two distinct columns produced identical SQL: %s", a)
	}
	if !strings.Contains(a, "c.email") || strings.Contains(a, "x.email") {
		t.Errorf("a leaked b's column: %s", a)
	}
	if !strings.Contains(b, "x.email") || strings.Contains(b, "c.email") {
		t.Errorf("b leaked a's column: %s", b)
	}
}

// TestCanonicalContract_NoDriftBetweenSites is a meta-test: the runner's
// suppressionFilterFor("c.email") in services/campaigns/campaign/runner.go
// must remain byte-equivalent to NotInUnionWhere("c.email") so a future
// refactor cannot quietly drop the consolidation.
//
// The campaigns package owns the discipline test (
// runner_suppression_test.go::TestSuppressionFilterSQL_UnionsBothTables)
// — this one mirrors it from the canonical side.
func TestCanonicalContract_StablePrefix(t *testing.T) {
	got := NotInUnionWhere("c.email")
	wantPrefix := "lower(trim(c.email)) NOT IN ("
	if !strings.HasPrefix(got, wantPrefix) {
		t.Errorf("canonical NOT IN prefix drifted:\nwant prefix %q\ngot         %q", wantPrefix, got)
	}
}
