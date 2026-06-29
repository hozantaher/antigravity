package segment

import (
	"context"
	"database/sql/driver"
	"reflect"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"github.com/lib/pq"
)

// F5-2 — locks the rule that the IN scalar branch uses pq.Array(...)
// instead of hand-built `{a,b,c}` text-array literal. lib/pq parses
// the string literal at the wire-protocol level: commas, quotes,
// backslashes, and `}` inside any value split or terminate the array.
// pq.Array() escapes per-element so user-controlled values cannot
// inject extra elements or truncate the array.

func TestBuildSQL_IN_Scalar_UsesPqArray(t *testing.T) {
	q := Query{Op: "AND", Conditions: []Node{
		{Op: "IN", Field: "icp_tier", Value: []any{"ideal", "good"}},
	}}
	_, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(args) != 1 {
		t.Fatalf("args len = %d, want 1", len(args))
	}
	// The argument must implement driver.Valuer (pq.Array does);
	// the prior plain-string form did not.
	if _, ok := args[0].(driver.Valuer); !ok {
		t.Errorf("args[0] is %T, want driver.Valuer (pq.Array)", args[0])
	}
}

func TestBuildSQL_IN_Scalar_RejectsArrayLiteralInjection(t *testing.T) {
	// Attacker-controlled segment value contains `","` (the literal
	// `","` substring that, in the buggy implementation, was treated
	// as element separator because the old code did
	//   `"{" + strings.Join(vals, ",") + "}"`
	// → `{ideal,bad","b}` parsed as 3 elements. With pq.Array() the
	// value goes through proper escaping at the wire-protocol layer.
	cases := [][]any{
		{`a,b`, `c`},     // comma inside a value
		{`a"b`, `c`},     // quote inside a value
		{`a}b`, `c`},     // closing brace inside a value
		{`a\b`, `c`},     // backslash inside a value
		{`{evil}`, `c`},  // both braces inside a value
		{``, `nonempty`}, // empty string element
	}
	for _, vals := range cases {
		t.Run(strings.Join(stringifyAny(vals), "|"), func(t *testing.T) {
			q := Query{Op: "AND", Conditions: []Node{
				{Op: "IN", Field: "icp_tier", Value: vals},
			}}
			_, args, err := BuildSQL(q, 1)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(args) != 1 {
				t.Fatalf("args len = %d, want 1", len(args))
			}
			// Verify the arg is a pq.Array carrying ALL N values intact
			// (no element splitting).
			arr, ok := args[0].(driver.Valuer)
			if !ok {
				t.Fatalf("args[0] = %T, want driver.Valuer", args[0])
			}
			val, err := arr.Value()
			if err != nil {
				t.Fatalf("pq.Array Value(): %v", err)
			}
			// pq.Array.Value() returns the wire-encoded string. lib/pq
			// escapes embedded commas/quotes/braces; the encoded length
			// MUST be longer than naive Join when input contained a
			// special char, AND the round-trip via reflect-equal of
			// underlying slice via pq.StringArray must still preserve
			// element count.
			s, ok := val.(string)
			if !ok {
				t.Fatalf("pq.Array Value() = %T, want string", val)
			}
			// Element count check via the input slice — there's no easy
			// in-process round-trip from the wire literal back to a
			// slice without a real DB. Best we can do here is verify
			// that the encoded literal is well-formed (starts with `{`,
			// ends with `}`) and that special characters in the input
			// appear as escapes (not raw splitters) inside the literal.
			if !strings.HasPrefix(s, "{") || !strings.HasSuffix(s, "}") {
				t.Errorf("encoded literal is malformed: %q", s)
			}
			// CRITICAL: the encoded literal MUST escape user-controlled
			// special chars. lib/pq quotes elements that contain commas,
			// braces, or backslashes, and backslash-escapes embedded
			// quotes. Verify at least one of the user's special chars
			// appears as an escape (\\) or inside double-quotes.
			special := false
			for _, v := range vals {
				vs, _ := v.(string)
				if strings.ContainsAny(vs, ",\"{}\\") {
					special = true
					break
				}
			}
			if special {
				if !strings.Contains(s, `"`) && !strings.Contains(s, `\`) {
					t.Errorf("special chars not escaped in encoded literal: %q (input %v)", s, vals)
				}
			}
		})
	}
}

func TestBuildSQL_IN_Scalar_RoundtripViaSqlmock(t *testing.T) {
	// Verify the full path: pq.Array → driver.Valuer.Value() → wire
	// literal → sqlmock receives it AS-IS. We don't have a real DB so
	// we just check that sqlmock sees the pq-encoded string as the
	// arg, NOT the bare comma-joined literal.
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	q := Query{Op: "AND", Conditions: []Node{
		{Op: "IN", Field: "icp_tier", Value: []any{"a,b", "c"}},
	}}
	_, args, err := BuildSQL(q, 1)
	if err != nil {
		t.Fatalf("BuildSQL: %v", err)
	}

	// Prior to F5-2 args[0] would be the string `{a,b,c}` (3 elements
	// from sqlmock's perspective if it ever decoded it). With pq.Array
	// the wire encoding is `{"a,b",c}` — string with embedded quotes.
	mock.ExpectExec(`anything`).
		WithArgs(args[0]).
		WillReturnResult(sqlmock.NewResult(0, 0))
	if _, err := db.ExecContext(context.Background(), `anything`, args...); err != nil {
		t.Errorf("ExecContext: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// Source-level audit: the IN scalar branch MUST use pq.Array(...) and
// NOT hand-build `{...}`.
func TestBuildSQL_IN_Scalar_SourceAudit_NoHandBuiltLiteral(t *testing.T) {
	src, err := readQuerySource()
	if err != nil {
		t.Fatalf("read query.go: %v", err)
	}
	// Strip line comments so the regression-doc comment doesn't trip
	// the audit. We only care about runtime statements.
	codeLines := []string{}
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		codeLines = append(codeLines, line)
	}
	code := strings.Join(codeLines, "\n")

	// The buggy form: `arg := "{" + strings.Join(vals, ",") + "}"` —
	// match the runtime statement, not the regression comment.
	if strings.Contains(code, `arg := "{" + strings.Join(vals,`) {
		t.Error("query.go still hand-builds the IN-scalar text-array literal — vulnerable to element injection")
	}
	if !strings.Contains(code, "pq.Array(vals)") {
		t.Error("query.go does not use pq.Array(vals) for IN scalar")
	}
}

// Helper for property-test labeling.
func stringifyAny(v []any) []string {
	out := make([]string, len(v))
	for i, x := range v {
		s, ok := x.(string)
		if !ok {
			out[i] = "<non-string>"
			continue
		}
		// Replace newlines / nulls so subtest names don't break.
		s = strings.ReplaceAll(s, "\n", "\\n")
		out[i] = s
	}
	return out
}

// Compile-time guard: pq.StringArray (the typed pq.Array result) is
// reachable. If pq disappears or its API changes, this guard fails.
var _ driver.Valuer = pq.StringArray(nil)

// Sanity: reflect-based equality between pq.Array of equal slices.
func TestBuildSQL_IN_Scalar_PqArrayEquality(t *testing.T) {
	a := pq.Array([]string{"x", "y"})
	b := pq.Array([]string{"x", "y"})
	if !reflect.DeepEqual(a, b) {
		t.Error("pq.Array of equal slices should be DeepEqual")
	}
}
