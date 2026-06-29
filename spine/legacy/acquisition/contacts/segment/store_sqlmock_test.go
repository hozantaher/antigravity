package segment

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

var segCols = []string{
	"id", "name", "description", "query",
	"company_count", "last_built_at", "created_at", "updated_at",
}

func sampleQuery() string {
	q := Query{Op: "AND", Conditions: []Node{
		{Op: "EQ", Field: "icp_tier", Value: "ideal"},
	}}
	b, _ := json.Marshal(q)
	return string(b)
}

// ── Store.Get ─────────────────────────────────────────────────────────────────

func TestStore_Get_Found(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	built := time.Now().Add(-time.Hour)

	mock.ExpectQuery(`SELECT id, name`).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(segCols).AddRow(
			1, "Top ICP", "Ideal companies", sampleQuery(),
			42, built, now, now,
		))

	store := NewStore(db)
	seg, err := store.Get(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seg.ID != 1 {
		t.Errorf("ID = %d, want 1", seg.ID)
	}
	if seg.Name != "Top ICP" {
		t.Errorf("Name = %q, want Top ICP", seg.Name)
	}
	if seg.CompanyCount != 42 {
		t.Errorf("CompanyCount = %d, want 42", seg.CompanyCount)
	}
	if seg.LastBuiltAt == nil {
		t.Error("LastBuiltAt should not be nil")
	}
	if seg.Query.Op != "AND" {
		t.Errorf("Query.Op = %q, want AND", seg.Query.Op)
	}
}

func TestStore_Get_NullLastBuilt(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WithArgs(int64(2)).
		WillReturnRows(sqlmock.NewRows(segCols).AddRow(
			2, "New Segment", "", sampleQuery(),
			0, nil, now, now,
		))

	seg, err := NewStore(db).Get(context.Background(), 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seg.LastBuiltAt != nil {
		t.Errorf("LastBuiltAt should be nil for unbuilt segment")
	}
	if seg.CompanyCount != 0 {
		t.Errorf("CompanyCount = %d, want 0", seg.CompanyCount)
	}
}

func TestStore_Get_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WithArgs(int64(99)).
		WillReturnError(errSeg("not found"))

	_, err = NewStore(db).Get(context.Background(), 99)
	if err == nil {
		t.Error("expected error")
	}
}

// ── Store.List ────────────────────────────────────────────────────────────────

func TestStore_List_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols))

	segs, err := NewStore(db).List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(segs) != 0 {
		t.Errorf("len = %d, want 0", len(segs))
	}
}

func TestStore_List_Multiple(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols).
			AddRow(1, "Alpha", "", sampleQuery(), 10, nil, now, now).
			AddRow(2, "Beta", "desc", sampleQuery(), 20, now, now, now),
		)

	segs, err := NewStore(db).List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(segs) != 2 {
		t.Fatalf("len = %d, want 2", len(segs))
	}
	if segs[0].Name != "Alpha" {
		t.Errorf("segs[0].Name = %q, want Alpha", segs[0].Name)
	}
	if segs[1].LastBuiltAt == nil {
		t.Error("segs[1].LastBuiltAt should not be nil")
	}
}

// ── Store.Create ──────────────────────────────────────────────────────────────

func TestStore_Create_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	q := Query{Op: "AND", Conditions: []Node{
		{Op: "EQ", Field: "icp_tier", Value: "ideal"},
	}}

	mock.ExpectQuery(`INSERT INTO segments`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(5)))

	id, err := NewStore(db).Create(context.Background(), "My Segment", "desc", q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 5 {
		t.Errorf("id = %d, want 5", id)
	}
}

func TestStore_Create_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO segments`).
		WillReturnError(errSeg("conflict"))

	q := Query{Op: "AND", Conditions: nil}
	_, err = NewStore(db).Create(context.Background(), "dup", "", q)
	if err == nil {
		t.Error("expected error")
	}
}

// ── Store.GetByName ───────────────────────────────────────────────────────────

func TestStore_GetByName_Found(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WithArgs("Top ICP").
		WillReturnRows(sqlmock.NewRows(segCols).AddRow(
			3, "Top ICP", "", sampleQuery(), 7, nil, now, now,
		))

	seg, err := NewStore(db).GetByName(context.Background(), "Top ICP")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seg.ID != 3 {
		t.Errorf("ID = %d, want 3", seg.ID)
	}
}

// ── Store.BuildMemberships ────────────────────────────────────────────────────

func TestStore_BuildMemberships_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	seg := &Segment{
		ID:   1,
		Name: "Test",
		Query: Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
		}},
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WithArgs(int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 15))
	mock.ExpectExec(`UPDATE segments SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	n, err := NewStore(db).BuildMemberships(context.Background(), seg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 15 {
		t.Errorf("n = %d, want 15", n)
	}
}

func TestStore_BuildMemberships_InvalidQuery(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	seg := &Segment{
		ID:   1,
		Name: "Bad",
		Query: Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "INJECTED; DROP TABLE", Value: "x"},
		}},
	}

	_, err = NewStore(db).BuildMemberships(context.Background(), seg)
	if err == nil {
		t.Error("expected error for disallowed field in segment query")
	}
}

func TestStore_BuildMemberships_DeleteError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	seg := &Segment{
		ID:   2,
		Name: "Err",
		Query: Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
		}},
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WillReturnError(errSeg("delete failed"))
	mock.ExpectRollback()

	_, err = NewStore(db).BuildMemberships(context.Background(), seg)
	if err == nil {
		t.Error("expected error")
	}
}

// ── Store.RefreshAll ──────────────────────────────────────────────────────────

func TestStore_RefreshAll_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols))

	total, err := NewStore(db).RefreshAll(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d, want 0", total)
	}
}

func TestStore_RefreshAll_TwoSegments(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols).
			AddRow(1, "Alpha", "", sampleQuery(), 0, nil, now, now).
			AddRow(2, "Beta", "", sampleQuery(), 0, nil, now, now),
		)

	// BuildMemberships for segment 1
	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).WillReturnResult(sqlmock.NewResult(0, 10))
	mock.ExpectExec(`UPDATE segments SET`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	// BuildMemberships for segment 2
	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).WithArgs(int64(2)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).WillReturnResult(sqlmock.NewResult(0, 5))
	mock.ExpectExec(`UPDATE segments SET`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	total, err := NewStore(db).RefreshAll(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 15 {
		t.Errorf("total = %d, want 15", total)
	}
}

// ── Store.BuildMemberships – additional error paths ───────────────────────────

func TestStore_BuildMemberships_InsertError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	seg := &Segment{
		ID:   3,
		Name: "InsertFail",
		Query: Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
		}},
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WithArgs(int64(3)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).
		WillReturnError(errSeg("insert failed"))
	mock.ExpectRollback()

	_, err = NewStore(db).BuildMemberships(context.Background(), seg)
	if err == nil {
		t.Error("expected error when INSERT fails")
	}
}

func TestStore_BuildMemberships_UpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	seg := &Segment{
		ID:   4,
		Name: "UpdateFail",
		Query: Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
		}},
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WithArgs(int64(4)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 5))
	mock.ExpectExec(`UPDATE segments SET`).
		WillReturnError(errSeg("update failed"))
	mock.ExpectRollback()

	_, err = NewStore(db).BuildMemberships(context.Background(), seg)
	if err == nil {
		t.Error("expected error when UPDATE fails")
	}
}

func TestStore_BuildMemberships_CommitError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	seg := &Segment{
		ID:   5,
		Name: "CommitFail",
		Query: Query{Op: "AND", Conditions: []Node{
			{Op: "EQ", Field: "icp_tier", Value: "ideal"},
		}},
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WithArgs(int64(5)).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).
		WillReturnResult(sqlmock.NewResult(0, 3))
	mock.ExpectExec(`UPDATE segments SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit().WillReturnError(errSeg("commit failed"))

	_, err = NewStore(db).BuildMemberships(context.Background(), seg)
	if err == nil {
		t.Error("expected error when Commit fails")
	}
}

// ── Store.RefreshAll – partial failure path ───────────────────────────────────

// TestStore_RefreshAll_OneSegmentFails verifies that when the first segment's
// BuildMemberships fails (via a DELETE error), RefreshAll logs it and continues,
// still counting the successful second segment. This covers the
// slog.Warn("segment refresh failed") + continue branch in RefreshAll.
func TestStore_RefreshAll_OneSegmentFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols).
			AddRow(10, "WillFail", "", sampleQuery(), 0, nil, now, now).
			AddRow(11, "WillSucceed", "", sampleQuery(), 0, nil, now, now),
		)

	// First segment: begin succeeds, DELETE fails → tx rolls back, BuildMemberships returns error.
	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).
		WithArgs(int64(10)).
		WillReturnError(errSeg("delete failed"))
	mock.ExpectRollback()

	// Second segment: full success with 7 matches.
	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM segment_memberships`).WithArgs(int64(11)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`INSERT INTO segment_memberships`).WillReturnResult(sqlmock.NewResult(0, 7))
	mock.ExpectExec(`UPDATE segments SET`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	total, err := NewStore(db).RefreshAll(context.Background())
	if err != nil {
		t.Fatalf("RefreshAll should not return error when only one segment fails, got: %v", err)
	}
	// Only the successful segment's count is summed.
	if total != 7 {
		t.Errorf("total = %d, want 7 (only second segment)", total)
	}
}

// ── Store.scan – JSON unmarshal error ─────────────────────────────────────────

// TestStore_Get_BadQueryJSON verifies that scan() returns an error when the
// stored query JSON is not a valid Query document.
func TestStore_Get_BadQueryJSON(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows(segCols).AddRow(
			42, "Broken", "", "{not valid json", 0, nil, now, now,
		))

	_, err = NewStore(db).Get(context.Background(), 42)
	if err == nil {
		t.Error("expected error for malformed query JSON")
	}
}

// TestStore_List_BadQueryJSON verifies that scanRow() returns an error when the
// stored query JSON is malformed, propagating out of List.
func TestStore_List_BadQueryJSON(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(segCols).AddRow(
			1, "Broken", "", "{bad json", 0, nil, now, now,
		))

	_, err = NewStore(db).List(context.Background())
	if err == nil {
		t.Error("expected error for malformed query JSON in List")
	}
}

// ── Store.List – DB error path ────────────────────────────────────────────────

// TestStore_List_DBError verifies the List error path when the initial query fails.
func TestStore_List_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnError(errSeg("db unavailable"))

	_, err = NewStore(db).List(context.Background())
	if err == nil {
		t.Error("expected error when DB query fails")
	}
}

type errSeg string

func (e errSeg) Error() string { return string(e) }
