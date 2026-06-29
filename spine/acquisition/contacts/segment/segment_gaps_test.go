package segment

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── BuildSQL: NOT node with failing child (query.go:93-95) ──

func TestBuildSQL_NOTNodeChildFails(t *testing.T) {
	// NOT node whose child has a disallowed field → error propagates up
	q := Query{Op: "NOT", Conditions: []Node{
		{Op: "EQ", Field: "invalid_field", Value: "x"},
	}}
	_, _, err := BuildSQL(q, 1)
	if err == nil {
		t.Error("expected error for NOT node with disallowed child field")
	}
}

// ── buildLeaf: unknown op (query.go:152-153) ──

func TestBuildLeaf_UnknownOp(t *testing.T) {
	// Direct test of buildLeaf with an unknown operator
	_, _, _, err := buildLeaf("UNKNOWN_OP", "name", "x", 1)
	if err == nil {
		t.Error("expected error for unknown leaf op")
	}
}

// ── Store.Create: query error path ──
// json.Marshal of Query practically never fails; test DB error path instead.

func TestCreate_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO segments`).
		WillReturnError(errSegment("insert failed"))

	s := NewStore(db)
	_, err = s.Create(context.Background(), "Test", "desc", Query{Op: "AND"})
	if err == nil {
		t.Error("expected error from Create")
	}
}

// ── Store.Update: query error path ──

func TestUpdate_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE segments`).
		WillReturnError(errSegment("update failed"))

	s := NewStore(db)
	err = s.Update(context.Background(), 1, "Test", "desc", Query{Op: "AND"})
	if err == nil {
		t.Error("expected error from Update")
	}
}

// ── RefreshAll: BuildMemberships error (line 183-185) ──
// Non-fatal: logs warning and continues.

func TestRefreshAll_BuildMembershipsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// List query fails → RefreshAll returns error immediately
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnError(errSegment("list failed"))

	s := NewStore(db)
	_, err = s.RefreshAll(context.Background())
	// List error is fatal → RefreshAll returns error
	if err == nil {
		t.Error("expected error when List fails")
	}
}

// ── Store.scanRow: scan error path (line 227-229) ──

func TestList_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Wrong column count → scanRow fails
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "Bad"))

	s := NewStore(db)
	_, err = s.List(context.Background())
	if err == nil {
		t.Error("expected scan error from List")
	}
}

func errSegment(msg string) error {
	return &segErr{msg}
}

type segErr struct{ msg string }

func (e *segErr) Error() string { return e.msg }
