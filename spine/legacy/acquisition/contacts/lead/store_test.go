package lead_test

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"contacts/lead"
)

var leadCols = []string{
	"id", "contact_id", "campaign_id", "status", "source", "notes",
	"created_at", "updated_at",
}

func now() time.Time { return time.Now() }

// ── Create ────────────────────────────────────────────────────────────────────

func TestStore_Create_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO leads`).
		WithArgs(int64(10), int64(3), "ares", "first contact").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))

	s := lead.NewStore(db)
	id, err := s.Create(context.Background(), 10, 3, "ares", "first contact")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if id != 1 {
		t.Errorf("id = %d, want 1", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestStore_Create_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO leads`).
		WillReturnError(errLead("db down"))

	s := lead.NewStore(db)
	_, err = s.Create(context.Background(), 1, 1, "", "")
	if err == nil {
		t.Fatal("expected error")
	}
}

// Idempotency: upsert on (contact_id, campaign_id) returns existing id.
func TestStore_Create_Idempotent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	// First call returns id=7
	mock.ExpectQuery(`INSERT INTO leads`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))
	// Second call (conflict) also returns id=7
	mock.ExpectQuery(`INSERT INTO leads`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)))

	s := lead.NewStore(db)
	id1, _ := s.Create(context.Background(), 5, 2, "web", "")
	id2, _ := s.Create(context.Background(), 5, 2, "web", "")
	if id1 != id2 {
		t.Errorf("idempotency: id1=%d id2=%d, want same", id1, id2)
	}
}

// ── Get ───────────────────────────────────────────────────────────────────────

func TestStore_Get_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	n := now()
	mock.ExpectQuery(`SELECT id`).
		WithArgs(int64(1)).
		WillReturnRows(sqlmock.NewRows(leadCols).AddRow(
			1, 10, 3, "new", "ares", "first contact", n, n,
		))

	s := lead.NewStore(db)
	l, err := s.Get(context.Background(), 1)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if l.ID != 1 || l.ContactID != 10 || l.CampaignID != 3 {
		t.Errorf("unexpected lead: %+v", l)
	}
	if l.Status != "new" {
		t.Errorf("status = %q, want new", l.Status)
	}
}

func TestStore_Get_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows(leadCols))

	s := lead.NewStore(db)
	_, err = s.Get(context.Background(), 999)
	if err == nil {
		t.Fatal("expected not-found error")
	}
}

// ── List ──────────────────────────────────────────────────────────────────────

func TestStore_List_Empty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows(leadCols))

	s := lead.NewStore(db)
	leads, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(leads) != 0 {
		t.Errorf("want empty, got %d", len(leads))
	}
}

func TestStore_List_Multiple(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	n := now()
	mock.ExpectQuery(`SELECT id`).
		WillReturnRows(sqlmock.NewRows(leadCols).
			AddRow(1, 10, 3, "new", "ares", "", n, n).
			AddRow(2, 11, 3, "contacted", "web", "note", n, n))

	s := lead.NewStore(db)
	leads, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(leads) != 2 {
		t.Errorf("want 2, got %d", len(leads))
	}
}

// ── Update ────────────────────────────────────────────────────────────────────

func TestStore_Update_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE leads`).
		WithArgs("contacted", "follow up", int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := lead.NewStore(db)
	if err := s.Update(context.Background(), 1, "contacted", "follow up"); err != nil {
		t.Fatalf("Update: %v", err)
	}
}

func TestStore_Update_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE leads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := lead.NewStore(db)
	if err := s.Update(context.Background(), 999, "contacted", ""); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestStore_Update_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE leads`).
		WillReturnError(errLead("db error"))

	s := lead.NewStore(db)
	if err := s.Update(context.Background(), 1, "x", ""); err == nil {
		t.Fatal("expected error")
	}
}

// ── Delete ────────────────────────────────────────────────────────────────────

func TestStore_Delete_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM leads`).
		WithArgs(int64(5)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := lead.NewStore(db)
	if err := s.Delete(context.Background(), 5); err != nil {
		t.Fatalf("Delete: %v", err)
	}
}

func TestStore_Delete_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM leads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := lead.NewStore(db)
	if err := s.Delete(context.Background(), 404); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestStore_Delete_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`DELETE FROM leads`).
		WillReturnError(errLead("db error"))

	s := lead.NewStore(db)
	if err := s.Delete(context.Background(), 1); err == nil {
		t.Fatal("expected error")
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

type testErr string

func (e testErr) Error() string { return string(e) }

func errLead(s string) error { return testErr(s) }
