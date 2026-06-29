package segment

import (
	"fmt"
	"strings"
	"testing"
)

// ── BuildSQL / AllowedFields ─────────────────────────────────────────────────

func TestBuildSQL_EmptyAND(t *testing.T) {
	q := Query{Op: "AND", Conditions: nil}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if clause != "TRUE" {
		t.Errorf("clause = %q, want %q", clause, "TRUE")
	}
	if len(args) != 0 {
		t.Errorf("args = %v, want empty", args)
	}
}

func TestBuildSQL_SingleEQ(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, "icp_tier = $1") {
		t.Errorf("clause = %q, want to contain icp_tier = $1", clause)
	}
	if len(args) != 1 || args[0] != "ideal" {
		t.Errorf("args = %v, want [ideal]", args)
	}
}

func TestBuildSQL_GTE_LTE(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "GTE", Field: "icp_score", Value: 0.7},
			{Op: "LTE", Field: "icp_score", Value: 1.0},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, "icp_score >= $1") {
		t.Errorf("clause missing GTE: %q", clause)
	}
	if !strings.Contains(clause, "icp_score <= $2") {
		t.Errorf("clause missing LTE: %q", clause)
	}
	if len(args) != 2 {
		t.Errorf("args = %v, want 2", args)
	}
}

func TestBuildSQL_IN_Scalar(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "IN", Field: "icp_tier", Value: []any{"ideal", "good"}},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Scalar IN uses ANY($N::text[])
	if !strings.Contains(clause, "= ANY($1::text[])") {
		t.Errorf("clause = %q, want ANY($1::text[])", clause)
	}
	if len(args) != 1 {
		t.Errorf("args len = %d, want 1", len(args))
	}
}

func TestBuildSQL_IN_SectorTags_ArrayOverlap(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "IN", Field: "sector_tags", Value: []any{"machinery", "metalwork"}},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// sector_tags uses && ARRAY[$1,$2]
	if !strings.Contains(clause, "sector_tags && ARRAY[") {
		t.Errorf("clause = %q, want sector_tags && ARRAY[...]", clause)
	}
	if len(args) != 2 {
		t.Errorf("args = %v, want 2 individual args", args)
	}
}

func TestBuildSQL_IN_EmptyValues(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "IN", Field: "icp_tier", Value: []any{}},
		},
	}
	clause, _, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, "FALSE") {
		t.Errorf("empty IN should produce FALSE, got %q", clause)
	}
}

func TestBuildSQL_OR(t *testing.T) {
	q := Query{
		Op: "OR",
		Conditions: []Node{
			{Op: "EQ", Field: "region_normalized", Value: "Praha"},
			{Op: "EQ", Field: "region_normalized", Value: "Brno"},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, " OR ") {
		t.Errorf("clause = %q, want OR", clause)
	}
	if len(args) != 2 {
		t.Errorf("args = %v, want 2", args)
	}
}

func TestBuildSQL_NOT(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "NOT", Conditions: []Node{
				{Op: "EQ", Field: "email_status", Value: "invalid"},
			}},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, "NOT (") {
		t.Errorf("clause = %q, want NOT (", clause)
	}
	if len(args) != 1 {
		t.Errorf("args = %v, want 1", args)
	}
}

func TestBuildSQL_NOT_TooManyConditions(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "NOT", Conditions: []Node{
				{Op: "EQ", Field: "email_status", Value: "invalid"},
				{Op: "EQ", Field: "email_status", Value: "bounced"},
			}},
		},
	}
	_, _, err := BuildSQL(q, 1)
	if err == nil {
		t.Error("expected error for NOT with 2 conditions")
	}
}

func TestBuildSQL_Nested_AND_OR(t *testing.T) {
	// (sector=machinery AND icp_score>=0.5) OR region=Praha
	q := Query{
		Op: "OR",
		Conditions: []Node{
			{Op: "AND", Conditions: []Node{
				{Op: "EQ", Field: "sector_primary", Value: "machinery"},
				{Op: "GTE", Field: "icp_score", Value: 0.5},
			}},
			{Op: "EQ", Field: "region_normalized", Value: "Praha"},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, " OR ") {
		t.Errorf("outer should be OR: %q", clause)
	}
	if !strings.Contains(clause, " AND ") {
		t.Errorf("inner should have AND: %q", clause)
	}
	if len(args) != 3 {
		t.Errorf("args = %v, want 3", args)
	}
}

// ── Security: AllowedFields prevents injection ──────────────────────────────

func TestBuildSQL_DisallowedField_ReturnsError(t *testing.T) {
	injections := []string{
		"id; DROP TABLE companies; --",
		"1=1",
		"sector_primary OR 1=1 --",
		"password",
		"unknown_column",
	}
	for _, field := range injections {
		q := Query{
			Op: "AND",
			Conditions: []Node{
				{Op: "EQ", Field: field, Value: "x"},
			},
		}
		_, _, err := BuildSQL(q, 1)
		if err == nil {
			t.Errorf("expected error for disallowed field %q", field)
		}
		if err != nil && !strings.Contains(err.Error(), "disallowed field") {
			t.Errorf("error should mention disallowed field, got: %v", err)
		}
	}
}

func TestBuildSQL_AllowedFieldValues_NotInterpreted(t *testing.T) {
	// Value contains SQL injection — must be parameterized, not injected
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "'; DROP TABLE companies; --"},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Clause should reference $1 (parameterized) — SQL not in clause
	if strings.Contains(clause, "DROP") {
		t.Errorf("SQL injection in clause: %q", clause)
	}
	if len(args) != 1 {
		t.Fatalf("args len = %d, want 1", len(args))
	}
	if args[0] != "'; DROP TABLE companies; --" {
		t.Errorf("value not preserved as literal arg: %v", args[0])
	}
}

// ── Unknown op ───────────────────────────────────────────────────────────────

func TestBuildSQL_UnknownOp_ReturnsError(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "LIKE", Field: "icp_tier", Value: "%ideal%"},
		},
	}
	_, _, err := BuildSQL(q, 1)
	if err == nil {
		t.Error("expected error for unknown op LIKE")
	}
}

func TestBuildSQL_UnknownTopLevelOp_ReturnsError(t *testing.T) {
	q := Query{Op: "BETWEEN", Conditions: []Node{}}
	_, _, err := BuildSQL(q, 1)
	if err == nil {
		t.Error("expected error for unknown top-level op BETWEEN")
	}
}

// ── ParseQuery ───────────────────────────────────────────────────────────────

func TestParseQuery_Valid(t *testing.T) {
	raw := []byte(`{"op":"AND","conditions":[{"op":"EQ","field":"icp_tier","value":"ideal"}]}`)
	q, err := ParseQuery(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if q.Op != "AND" {
		t.Errorf("Op = %q, want AND", q.Op)
	}
	if len(q.Conditions) != 1 {
		t.Fatalf("conditions = %d, want 1", len(q.Conditions))
	}
	if q.Conditions[0].Field != "icp_tier" {
		t.Errorf("field = %q, want icp_tier", q.Conditions[0].Field)
	}
}

func TestParseQuery_Invalid_JSON(t *testing.T) {
	_, err := ParseQuery([]byte(`{not json`))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

// ── AllowedFields completeness ───────────────────────────────────────────────

func TestAllowedFields_ContainsCriticalColumns(t *testing.T) {
	required := []string{
		"sector_primary", "sector_tags", "icp_tier", "icp_score",
		"region_normalized", "email_status", "exclusion_status",
		"engagement_cluster", "velikost_firmy",
	}
	for _, col := range required {
		if _, ok := AllowedFields[col]; !ok {
			t.Errorf("AllowedFields missing required column %q", col)
		}
	}
}

// ── GT and LT ops ──────────────────────────────────────────────────────────

func TestBuildSQL_GT_LT(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "GT", Field: "icp_score", Value: 0.5},
			{Op: "LT", Field: "rating_count", Value: 100},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, "icp_score > $1") {
		t.Errorf("clause missing GT: %q", clause)
	}
	if !strings.Contains(clause, "rating_count < $2") {
		t.Errorf("clause missing LT: %q", clause)
	}
	if len(args) != 2 {
		t.Errorf("args = %v, want 2", args)
	}
}

// ── toStringSlice: direct []string path ─────────────────────────────────────

func TestBuildSQL_IN_DirectStringSlice(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "IN", Field: "icp_tier", Value: []string{"ideal", "good"}},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, "= ANY($1::text[])") {
		t.Errorf("clause = %q, want ANY($1::text[])", clause)
	}
	if len(args) != 1 {
		t.Errorf("args len = %d, want 1", len(args))
	}
}

// ── toStringSlice: non-string element in []any ──────────────────────────────

func TestBuildSQL_IN_NonStringElement_Error(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "IN", Field: "icp_tier", Value: []any{"ideal", 42}},
		},
	}
	_, _, err := BuildSQL(q, 1)
	if err == nil {
		t.Error("expected error for non-string element in []any")
	}
}

// ── toStringSlice: unsupported type ────────────────────────────────────────

func TestBuildSQL_IN_UnsupportedValueType_Error(t *testing.T) {
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "IN", Field: "icp_tier", Value: 42},
		},
	}
	_, _, err := BuildSQL(q, 1)
	if err == nil {
		t.Error("expected error for unsupported value type in IN")
	}
}

// ── Parameter index continuity ───────────────────────────────────────────────

func TestBuildSQL_ParameterIndicesContinuous(t *testing.T) {
	// Complex query with 5 leaf nodes — params must be $1..$5 without gaps.
	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
			{Op: "GTE", Field: "icp_score", Value: 0.7},
			{Op: "EQ", Field: "region_normalized", Value: "Praha"},
			{Op: "EQ", Field: "email_status", Value: "valid"},
			{Op: "EQ", Field: "engagement_cluster", Value: "champion"},
		},
	}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(args) != 5 {
		t.Errorf("args = %d, want 5", len(args))
	}
	for i := 1; i <= 5; i++ {
		needle := fmt.Sprintf("$%d", i)
		if !strings.Contains(clause, needle) {
			t.Errorf("clause missing %s: %q", needle, clause)
		}
	}
}

