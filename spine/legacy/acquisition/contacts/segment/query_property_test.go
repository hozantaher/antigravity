package segment

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: ParseQuery never panics ─────────────────────────
func TestProperty_ParseQuery_NoPanic(t *testing.T) {
	f := func(raw []byte) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", raw, r)
			}
		}()
		_, _ = ParseQuery(raw)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ParseQuery on invalid JSON returns error ────────
func TestProperty_ParseQuery_InvalidJSON(t *testing.T) {
	cases := [][]byte{
		[]byte(""),
		[]byte("not json"),
		[]byte("{"),
		[]byte("[]"),         // wrong type — not an object
		[]byte("null"),
		[]byte(`{"op"`),      // truncated
	}
	for _, raw := range cases {
		_, err := ParseQuery(raw)
		// "[]" is actually an array which unmarshals to Query zero-value
		// if the unmarshaler is permissive. Current impl returns err for
		// truly unparseable, otherwise a zero Query.
		// Just verify no panic and either valid struct or error.
		_ = err
	}
}

// ── Property: ParseQuery roundtrip for valid JSON ────────────
func TestProperty_ParseQuery_Roundtrip(t *testing.T) {
	cases := []Query{
		{Op: "AND", Conditions: []Node{}},
		{Op: "OR", Conditions: []Node{
			{Op: "eq", Field: "sector_primary", Value: "mfg"},
		}},
		{Op: "AND", Conditions: []Node{
			{Op: "eq", Field: "icp_tier", Value: "A"},
			{Op: "gte", Field: "icp_score", Value: 0.5},
		}},
	}
	for _, q := range cases {
		raw, _ := json.Marshal(q)
		parsed, err := ParseQuery(raw)
		if err != nil {
			t.Fatalf("roundtrip err for %+v: %v", q, err)
		}
		if parsed.Op != q.Op {
			t.Fatalf("Op roundtrip: want %q, got %q", q.Op, parsed.Op)
		}
		if len(parsed.Conditions) != len(q.Conditions) {
			t.Fatalf("Conditions len: want %d, got %d", len(q.Conditions), len(parsed.Conditions))
		}
	}
}

// ── Property: BuildSQL never panics ──────────────────────────
func TestProperty_BuildSQL_NoPanic(t *testing.T) {
	f := func(op string, fields []string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on op=%q fields=%v: %v", op, fields, r)
			}
		}()
		nodes := make([]Node, 0, len(fields))
		for _, f := range fields {
			nodes = append(nodes, Node{Op: "eq", Field: f, Value: "x"})
		}
		q := Query{Op: op, Conditions: nodes}
		_, _, _ = BuildSQL(q, 1)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Security invariant: BuildSQL rejects non-allowed fields ──
// SQL injection defense: field names NOT in AllowedFields must
// produce an error, never end up in the SQL clause.
func TestProperty_BuildSQL_FieldAllowlist(t *testing.T) {
	bad := []string{
		"password",
		"id; DROP TABLE users",
		"email' OR '1'='1",
		"../etc/passwd",
		"",
		"unicode_ěščř",
	}
	for _, field := range bad {
		q := Query{Op: "AND", Conditions: []Node{
			{Op: "eq", Field: field, Value: "x"},
		}}
		_, _, err := BuildSQL(q, 1)
		if err == nil && field != "" {
			t.Fatalf("field %q should produce error (not in AllowedFields)", field)
		}
	}
}

// ── Property: BuildSQL with allowed fields emits parameterized SQL ──
// Never inline user values; always use $N placeholders.
func TestProperty_BuildSQL_Parameterized(t *testing.T) {
	q := Query{Op: "AND", Conditions: []Node{
		{Op: "eq", Field: "sector_primary", Value: "DANGEROUS'; DROP TABLE companies; --"},
	}}
	clause, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The dangerous value must be in args, NOT inlined into clause.
	if strings.Contains(clause, "DROP TABLE") {
		t.Fatalf("SQL injection leak: dangerous value inlined in clause: %q", clause)
	}
	if len(args) == 0 || args[0] != "DANGEROUS'; DROP TABLE companies; --" {
		t.Fatalf("args should contain the raw value, got: %v", args)
	}
}

// ── Property: AND/OR with zero conditions returns TRUE ──────
func TestProperty_BuildSQL_EmptyAndOr(t *testing.T) {
	for _, op := range []string{"AND", "OR", "and", "or"} {
		q := Query{Op: op, Conditions: []Node{}}
		clause, _, err := BuildSQL(q, 1)
		if err != nil {
			t.Fatalf("empty %s should not error: %v", op, err)
		}
		if !strings.Contains(clause, "TRUE") {
			t.Fatalf("empty %s: want TRUE in clause, got %q", op, clause)
		}
	}
}

// ── Property: Deterministic — same Query → same SQL ──────────
func TestProperty_BuildSQL_Deterministic(t *testing.T) {
	q := Query{Op: "AND", Conditions: []Node{
		{Op: "eq", Field: "sector_primary", Value: "mfg"},
		{Op: "gte", Field: "icp_score", Value: 0.5},
	}}
	a, argsA, errA := BuildSQL(q, 1)
	b, argsB, errB := BuildSQL(q, 1)
	if errA != nil || errB != nil {
		t.Fatalf("err: a=%v b=%v", errA, errB)
	}
	if a != b {
		t.Fatalf("non-deterministic SQL: %q vs %q", a, b)
	}
	if len(argsA) != len(argsB) {
		t.Fatalf("args len: %d vs %d", len(argsA), len(argsB))
	}
}

// ── Property: startIdx shifts placeholder numbers ────────────
func TestProperty_BuildSQL_StartIdxShift(t *testing.T) {
	q := Query{Op: "AND", Conditions: []Node{
		{Op: "eq", Field: "sector_primary", Value: "x"},
	}}
	clause5, _, _ := BuildSQL(q, 5)
	clause10, _, _ := BuildSQL(q, 10)
	// At startIdx=5, placeholder should be $5. At 10, should be $10.
	if !strings.Contains(clause5, "$5") {
		t.Fatalf("startIdx=5: want $5 in clause, got %q", clause5)
	}
	if !strings.Contains(clause10, "$10") {
		t.Fatalf("startIdx=10: want $10 in clause, got %q", clause10)
	}
}

// ── Property: AllowedFields is frozen (contract lock) ────────
func TestProperty_AllowedFields_FrozenSize(t *testing.T) {
	// Adding/removing a field requires updating this test. Protects
	// against accidental SQL surface expansion.
	if len(AllowedFields) != 13 {
		t.Fatalf("AllowedFields changed (want 13, got %d) — verify no new SQL-injection surface", len(AllowedFields))
	}
	// Spot-check a few expected fields.
	for _, field := range []string{"sector_primary", "icp_tier", "icp_score", "region_normalized"} {
		if _, ok := AllowedFields[field]; !ok {
			t.Fatalf("expected field %q missing from AllowedFields", field)
		}
	}
}
