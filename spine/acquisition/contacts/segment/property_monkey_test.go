package segment

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"testing/quick"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── Property: BuildSQL never panics on arbitrary nested trees ─────────────────
//
// Exercises compound recursion: AND/OR nesting, NOT chains, mixed leaf ops.
// Covers the buildNode recursive path that pure op-string fuzzing misses.
func TestProperty_BuildSQL_NestedTree_NoPanic(t *testing.T) {
	makeLeaf := func(field, op string) Node {
		if _, ok := AllowedFields[field]; ok {
			return Node{Op: op, Field: field, Value: "x"}
		}
		return Node{Op: op, Field: "icp_tier", Value: "x"}
	}

	trees := []Query{
		// Double-NOT (NOT(NOT(leaf)))
		{Op: "AND", Conditions: []Node{
			{Op: "NOT", Conditions: []Node{
				{Op: "NOT", Conditions: []Node{makeLeaf("icp_tier", "EQ")}},
			}},
		}},
		// OR of ANDs of GTE/LTE pairs
		{Op: "OR", Conditions: []Node{
			{Op: "AND", Conditions: []Node{
				makeLeaf("icp_score", "GTE"),
				makeLeaf("icp_score", "LTE"),
			}},
			{Op: "AND", Conditions: []Node{
				makeLeaf("region_normalized", "EQ"),
				makeLeaf("rating_count", "GT"),
			}},
		}},
		// Empty OR inside AND
		{Op: "AND", Conditions: []Node{
			{Op: "OR", Conditions: []Node{}},
			makeLeaf("email_status", "EQ"),
		}},
		// IN sector_tags (array overlap path) inside NOT
		{Op: "AND", Conditions: []Node{
			{Op: "NOT", Conditions: []Node{
				{Op: "IN", Field: "sector_tags", Value: []any{"a", "b"}},
			}},
		}},
	}

	for _, q := range trees {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on query %+v: %v", q, r)
				}
			}()
			_, _, _ = BuildSQL(q, 1)
		}()
	}
}

// ── Property: BuildSQL result is always deterministic ─────────────────────────
//
// Same query → identical (clause, args) across repeated calls.
// Covers stateless property of buildNode indexing.
func TestProperty_BuildSQL_Deterministic_Quick(t *testing.T) {
	allowed := allowedFieldList()
	f := func(pick uint8, val string) bool {
		field := allowed[int(pick)%len(allowed)]
		q := Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: field, Value: val},
			{Op: "GTE", Field: "icp_score", Value: 0.5},
		}}
		c1, a1, e1 := BuildSQL(q, 1)
		c2, a2, e2 := BuildSQL(q, 1)
		if e1 != nil || e2 != nil {
			return true // errors are fine
		}
		if c1 != c2 {
			t.Errorf("non-deterministic clause: %q vs %q", c1, c2)
			return false
		}
		if len(a1) != len(a2) {
			t.Errorf("args len mismatch: %d vs %d", len(a1), len(a2))
			return false
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: startIdx offset is reflected correctly ──────────────────────────
//
// For any startIdx, placeholders must begin at that index.
func TestProperty_BuildSQL_StartIdxOffset_Quick(t *testing.T) {
	f := func(startIdx uint8) bool {
		idx := int(startIdx)%20 + 1 // 1..20
		q := Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "x"},
		}}
		clause, _, err := BuildSQL(q, idx)
		if err != nil {
			return true
		}
		expected := "$" + itoa(idx)
		return strings.Contains(clause, expected)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: ParseQuery roundtrip preserves Op and Conditions count ──────────
//
// For any serializable Query, marshal → ParseQuery must recover identical shape.
func TestProperty_ParseQuery_Roundtrip_Quick(t *testing.T) {
	allowed := allowedFieldList()
	f := func(pick uint8, n uint8) bool {
		count := int(n) % 4 // 0..3 conditions
		conds := make([]Node, count)
		for i := range conds {
			field := allowed[int(pick+uint8(i))%len(allowed)]
			conds[i] = Node{Op: "EQ", Field: field, Value: "v"}
		}
		q := Query{Op: "AND", Conditions: conds}
		raw, err := json.Marshal(q)
		if err != nil {
			return true
		}
		parsed, err := ParseQuery(raw)
		if err != nil {
			return false
		}
		if parsed.Op != q.Op {
			t.Errorf("Op mismatch: want %q got %q", q.Op, parsed.Op)
			return false
		}
		if len(parsed.Conditions) != len(q.Conditions) {
			t.Errorf("Conditions len mismatch: want %d got %d", len(q.Conditions), len(parsed.Conditions))
			return false
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Fatal(err)
	}
}

// ── Monkey: BuildSQL is goroutine-safe (concurrent execution, no data race) ───
//
// 20 goroutines call BuildSQL on the same query simultaneously.
// Should produce no panic or data race (run with -race).
func TestMonkey_BuildSQL_Concurrent_NoPanic(t *testing.T) {
	q := Query{Op: "OR", Conditions: []Node{
		{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
			{Op: "GTE", Field: "icp_score", Value: 0.7},
		}},
		{Op: "IN", Field: "sector_tags", Value: []any{"machinery", "metalwork"}},
		{Op: "NOT", Conditions: []Node{
			{Op: "EQ", Field: "email_status", Value: "invalid"},
		}},
	}}

	const goroutines = 20
	var wg sync.WaitGroup
	panics := make(chan any, goroutines)

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics <- r
				}
			}()
			_, _, _ = BuildSQL(q, 1)
		}()
	}
	wg.Wait()
	close(panics)
	for p := range panics {
		t.Errorf("BuildSQL panicked: %v", p)
	}
}

// ── Monkey: Store.Get with malformed JSON never hangs (deadline-safe) ─────────
func TestMonkey_StoreGet_BadJSON_NoPanic(t *testing.T) {
	badJSONs := []string{
		"{not json",
		"",
		"null",
		`{"op":123}`,
		strings.Repeat("a", 1000),
	}

	for _, bad := range badJSONs {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on bad JSON %q: %v", bad, r)
				}
			}()

			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatalf("sqlmock.New: %v", err)
			}
			defer db.Close()

			now := time.Now()
			mock.ExpectQuery(`SELECT id, name`).
				WithArgs(int64(1)).
				WillReturnRows(sqlmock.NewRows(segCols).AddRow(
					1, "Test", "", bad, 0, nil, now, now,
				))

			_, _ = NewStore(db).Get(context.Background(), 1)
		}()
	}
}

// ── Monkey: RefreshAll continues past individual segment failures ──────────────
//
// Verifies that one segment's BuildMemberships error does not abort RefreshAll.
func TestMonkey_RefreshAll_ContinuesPastErrors(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	// Three segments: first two fail at begin, third succeeds.
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols).
			AddRow(1, "Seg1", "", sampleQuery(), 0, nil, now, now).
			AddRow(2, "Seg2", "", sampleQuery(), 0, nil, now, now).
			AddRow(3, "Seg3", "", sampleQuery(), 0, nil, now, now),
		)

	mock.ExpectBegin().WillReturnError(errSeg("begin fail seg1"))
	mock.ExpectBegin().WillReturnError(errSeg("begin fail seg2"))

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).WithArgs(int64(3)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).WillReturnResult(sqlmock.NewResult(0, 9))
	mock.ExpectExec(`UPDATE segments SET`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	total, err := NewStore(db).RefreshAll(context.Background())
	if err != nil {
		t.Fatalf("RefreshAll should not return error when only some segments fail: %v", err)
	}
	if total != 9 {
		t.Errorf("total = %d, want 9 (only third segment succeeded)", total)
	}
}

// ── Segment struct: zero value is safe ────────────────────────────────────────
func TestSegment_ZeroValue_IsSafe(t *testing.T) {
	var seg Segment
	// JSON-serializing a zero Query must not panic
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("panic on zero Segment: %v", r)
		}
	}()
	_, err := json.Marshal(seg.Query)
	if err != nil {
		t.Errorf("unexpected error marshaling zero Query: %v", err)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func allowedFieldList() []string {
	fields := make([]string, 0, len(AllowedFields))
	for k := range AllowedFields {
		fields = append(fields, k)
	}
	return fields
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
