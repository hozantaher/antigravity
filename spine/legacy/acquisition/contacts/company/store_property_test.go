package company

import (
	"context"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── scanCompany error path ────────────────────────────────────────────────

// TestFindByICO_ScanError covers the scanCompany error branch via a column mismatch.
func TestFindByICO_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	// Return a row with too few columns to trigger a scan error.
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	_, err = s.FindByICO(context.Background(), "12345678")
	if err == nil {
		t.Error("expected scan error from column mismatch")
	}
}

// TestFindByFirmyCzID_ScanError covers scanCompany error via FindByFirmyCzID.
func TestFindByFirmyCzID_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	// Two columns instead of 43 → scan error.
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "Test"))

	_, err = s.FindByFirmyCzID(context.Background(), 12345)
	if err == nil {
		t.Error("expected scan error from column mismatch")
	}
}

// ── TierStats rows.Err() path ─────────────────────────────────────────────

// TestTierStats_RowsErr covers the rows.Err() propagation path.
func TestTierStats_RowsErr(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	// RowError injects an error after the first row is consumed.
	rows := sqlmock.NewRows([]string{"quality_tier", "count"}).
		AddRow("raw", 10).
		RowError(0, errCompany("rows iteration error"))

	mock.ExpectQuery(`SELECT quality_tier, COUNT`).WillReturnRows(rows)

	_, err = s.TierStats(context.Background())
	if err == nil {
		t.Error("expected rows.Err() to propagate from TierStats")
	}
}

// TestTierStats_DBError covers the initial query error path.
func TestTierStats_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	mock.ExpectQuery(`SELECT quality_tier, COUNT`).
		WillReturnError(errCompany("tier stats query failed"))

	_, err = s.TierStats(context.Background())
	if err == nil {
		t.Error("expected error from TierStats query")
	}
}

// ── property tests ────────────────────────────────────────────────────────

// TestParsePgArray_Property_NeverPanics verifies parsePgArray handles any string
// without panicking.
func TestParsePgArray_Property_NeverPanics(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }()
		parsePgArray(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// TestParsePgArray_Property_EmptyInputReturnsNil verifies empty/empty-array inputs
// return nil consistently.
func TestParsePgArray_Property_EmptyInputReturnsNil(t *testing.T) {
	for _, input := range []string{"", "{}"} {
		result := parsePgArray(input)
		if result != nil {
			t.Errorf("parsePgArray(%q) = %v, want nil", input, result)
		}
	}
}

// TestParsePgArray_WellFormedArrays tests several well-known array shapes.
func TestParsePgArray_WellFormedArrays(t *testing.T) {
	cases := []struct {
		input string
		want  []string
	}{
		{"{a}", []string{"a"}},
		{"{a,b,c}", []string{"a", "b", "c"}},
		{"{28410,28990}", []string{"28410", "28990"}},
		{"{ a , b }", []string{"a", "b"}},
	}
	for _, tc := range cases {
		got := parsePgArray(tc.input)
		if len(got) != len(tc.want) {
			t.Errorf("parsePgArray(%q) len=%d, want %d", tc.input, len(got), len(tc.want))
			continue
		}
		for i, v := range got {
			if v != tc.want[i] {
				t.Errorf("parsePgArray(%q)[%d] = %q, want %q", tc.input, i, v, tc.want[i])
			}
		}
	}
}
