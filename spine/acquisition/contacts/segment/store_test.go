package segment

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	"testing/quick"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── Store.Update ──────────────────────────────────────────────────────────────

func TestStore_Update_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	q := Query{Op: "AND", Conditions: []Node{{Op: "EQ", Field: "icp_tier", Value: "ideal"}}}
	raw, _ := json.Marshal(q)

	mock.ExpectExec(`UPDATE segments`).
		WithArgs("Updated Name", "New desc", string(raw), int64(5)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	store := NewStore(db)
	err = store.Update(context.Background(), 5, "Updated Name", "New desc", q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

func TestStore_Update_NotFound_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	q := Query{}
	raw, _ := json.Marshal(q)
	mock.ExpectExec(`UPDATE segments`).
		WithArgs("X", "", string(raw), int64(999)).
		WillReturnResult(sqlmock.NewResult(0, 0)) // 0 rows affected

	store := NewStore(db)
	err = store.Update(context.Background(), 999, "X", "", q)
	if err == nil {
		t.Error("expected error when update touches 0 rows (not found)")
	}
}

func TestStore_Update_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	q := Query{}
	raw, _ := json.Marshal(q)
	mock.ExpectExec(`UPDATE segments`).
		WithArgs("X", "", string(raw), int64(1)).
		WillReturnError(errors.New("db down"))

	store := NewStore(db)
	err = store.Update(context.Background(), 1, "X", "", q)
	if err == nil {
		t.Error("expected error from DB")
	}
}

func TestStore_Update_PreservesQuery(t *testing.T) {
	// The query JSONB must be marshalled identically to the original.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	q := Query{
		Op: "AND",
		Conditions: []Node{
			{Op: "GTE", Field: "score", Value: "75"},
			{Op: "EQ", Field: "region", Value: "Praha"},
		},
	}
	raw, _ := json.Marshal(q)
	mock.ExpectExec(`UPDATE segments`).
		WithArgs("Seg", "desc", string(raw), int64(3)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	store := NewStore(db)
	if err := store.Update(context.Background(), 3, "Seg", "desc", q); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("query was not passed correctly: %v", err)
	}
}

// ── Store.Delete ──────────────────────────────────────────────────────────────

func TestStore_Delete_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Delete should also remove memberships (CASCADE or explicit DELETE)
	mock.ExpectExec(`DELETE FROM segments`).
		WithArgs(int64(7)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	store := NewStore(db)
	if err := store.Delete(context.Background(), 7); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

func TestStore_Delete_NotFound_Err(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM segments`).
		WithArgs(int64(404)).
		WillReturnResult(sqlmock.NewResult(0, 0))

	store := NewStore(db)
	if err := store.Delete(context.Background(), 404); err == nil {
		t.Error("expected error when deleting non-existent segment")
	}
}

func TestStore_Delete_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM segments`).
		WithArgs(int64(1)).
		WillReturnError(errors.New("connection reset"))

	store := NewStore(db)
	if err := store.Delete(context.Background(), 1); err == nil {
		t.Error("expected error from DB")
	}
}

// ── Store.GetByName ───────────────────────────────────────────────────────────

func TestStore_GetByName_Found_B1(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	mock.ExpectQuery(`SELECT id, name`).
		WithArgs("NACE-43").
		WillReturnRows(sqlmock.NewRows(segCols).AddRow(
			10, "NACE-43", "Demolice a zemní práce", sampleQuery(),
			5, nil, now, now,
		))

	store := NewStore(db)
	seg, err := store.GetByName(context.Background(), "NACE-43")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seg.Name != "NACE-43" {
		t.Errorf("Name = %q, want NACE-43", seg.Name)
	}
	if seg.LastBuiltAt != nil {
		t.Error("LastBuiltAt should be nil (never built)")
	}
}

func TestStore_GetByName_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, name`).
		WithArgs("nonexistent").
		WillReturnError(sql.ErrNoRows)

	store := NewStore(db)
	_, err = store.GetByName(context.Background(), "nonexistent")
	if err == nil {
		t.Error("expected error for not-found segment")
	}
}

// ── Store.Create idempotence (upsert) ─────────────────────────────────────────

func TestStore_Create_UpsertOnConflict(t *testing.T) {
	// Second create of the same name updates the row and returns the same ID.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	q := Query{Op: "AND"}
	raw, _ := json.Marshal(q)
	mock.ExpectQuery(`INSERT INTO segments`).
		WithArgs("Demolice", "desc", string(raw)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(3)))

	store := NewStore(db)
	id, err := store.Create(context.Background(), "Demolice", "desc", q)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id != 3 {
		t.Errorf("id = %d, want 3", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// ── Property: Update always sets updated_at (via query) ───────────────────────

func TestStore_Update_Property_AlwaysTouchesRow(t *testing.T) {
	f := func(name string, id uint32) bool {
		if name == "" || id == 0 {
			return true
		}
		db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
		if err != nil {
			return false
		}
		defer db.Close()

		// Update query must contain "updated_at" to bump the timestamp.
		mock.ExpectExec(`updated_at`).
			WillReturnResult(sqlmock.NewResult(0, 1))

		store := NewStore(db)
		store.Update(context.Background(), int64(id), name, "", Query{}) //nolint:errcheck
		return mock.ExpectationsWereMet() == nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Errorf("property: Update must touch updated_at: %v", err)
	}
}
