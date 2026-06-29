package category

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ─── Search ──────────────────────────────────────────────────────────────────

func TestSearch_ReturnsResults(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("%staveb%", 10).
		WillReturnRows(sqlmock.NewRows(categoryColumns()).
			AddRow(3, "Remesla > Stavebni", "remesla~stavebni", "Stavebni", "Remesla", 1, 100, time.Now()))

	cats, err := s.Search(context.Background(), "staveb", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cats) != 1 {
		t.Errorf("len = %d, want 1", len(cats))
	}
	if cats[0].Name != "Stavebni" {
		t.Errorf("Name = %q, want Stavebni", cats[0].Name)
	}
}

func TestSearch_EmptyQuery(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("%%", 50).
		WillReturnRows(sqlmock.NewRows(categoryColumns()))

	cats, err := s.Search(context.Background(), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cats) != 0 {
		t.Errorf("expected empty, got %d", len(cats))
	}
}

func TestSearch_DefaultLimit(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	// limit <= 0 → defaults to 50
	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("%foo%", 50).
		WillReturnRows(sqlmock.NewRows(categoryColumns()))

	_, err := s.Search(context.Background(), "foo", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSearch_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnError(errCategory("db error"))

	_, err := s.Search(context.Background(), "foo", 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── Companies ───────────────────────────────────────────────────────────────

func companyColumns() []string {
	return []string{"id", "name", "email", "website", "address_locality",
		"icp_tier", "icp_score", "thread_count", "contact_count"}
}

func TestCompanies_ExactMatch(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	// Count query
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	// Data query
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns()).
			AddRow(1, "ACME s.r.o.", "acme@ex.cz", "https://acme.cz", "Praha", "a", 0.9, 2, 5))

	rows, total, err := s.Companies(context.Background(), "Root", false, 10, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 1 {
		t.Errorf("total = %d, want 1", total)
	}
	if len(rows) != 1 {
		t.Errorf("rows = %d, want 1", len(rows))
	}
	if rows[0].Name != "ACME s.r.o." {
		t.Errorf("Name = %q", rows[0].Name)
	}
}

func TestCompanies_PrefixMatch(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns()).
			AddRow(1, "Firma A", "a@ex.cz", "", "Brno", "b", 0.5, 0, 1).
			AddRow(2, "Firma B", "b@ex.cz", "", "Plzen", "c", 0.3, 1, 0))

	rows, total, err := s.Companies(context.Background(), "Root", true, 10, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 2 {
		t.Errorf("total = %d, want 2", total)
	}
	if len(rows) != 2 {
		t.Errorf("len(rows) = %d, want 2", len(rows))
	}
}

func TestCompanies_DefaultLimit(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	// limit <= 0 → defaults to 50
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns()))

	_, total, err := s.Companies(context.Background(), "Root", false, 0, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d, want 0", total)
	}
}

func TestCompanies_CountError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM companies`).
		WillReturnError(errCategory("count error"))

	_, _, err := s.Companies(context.Background(), "Root", false, 10, 0)
	if err == nil {
		t.Fatal("expected error from count query")
	}
}

func TestCompanies_DataQueryError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))

	mock.ExpectQuery(`SELECT id, name`).
		WillReturnError(errCategory("data error"))

	_, _, err := s.Companies(context.Background(), "Root", false, 10, 0)
	if err == nil {
		t.Fatal("expected error from data query")
	}
}

func TestCompanies_ScanError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM companies`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	// Return wrong type to trigger scan error
	mock.ExpectQuery(`SELECT id, name`).
		WillReturnRows(sqlmock.NewRows(companyColumns()).
			AddRow("not_an_int", "Firma", "e@ex.cz", "", "", "a", 0.0, 0, 0))

	_, _, err := s.Companies(context.Background(), "Root", false, 10, 0)
	if err == nil {
		t.Fatal("expected scan error")
	}
}

// ─── FindByPath NotFound ──────────────────────────────────────────────────────

func TestFindByPath_NotFound(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("nonexistent").
		WillReturnRows(sqlmock.NewRows(categoryColumns()))

	cat, err := s.FindByPath(context.Background(), "nonexistent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cat != nil {
		t.Errorf("expected nil, got %+v", cat)
	}
}

// ─── SuppressForCategory error path ──────────────────────────────────────────

func TestSuppressForCategory_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO category_suppressions`).
		WillReturnError(errCategory("insert error"))

	err := s.SuppressForCategory(context.Background(), "e@ex.cz", "Root", "opt-out")
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── RefreshCounts error path ─────────────────────────────────────────────────

func TestRefreshCounts_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`WITH RECURSIVE ancestors AS`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`WITH RECURSIVE expanded AS`).
		WillReturnError(errCategory("update error"))

	_, err := s.RefreshCounts(context.Background())
	if err == nil {
		t.Fatal("expected error from RefreshCounts")
	}
}

// ─── ListRoots DB error ───────────────────────────────────────────────────────

func TestListRoots_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnError(errCategory("query error"))

	_, err := s.ListRoots(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── ListChildren DB error ────────────────────────────────────────────────────

func TestListChildren_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnError(errCategory("query error"))

	_, err := s.ListChildren(context.Background(), "Root")
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── nullStr helper ───────────────────────────────────────────────────────────

func TestNullStr_Empty(t *testing.T) {
	v := nullStr("")
	if v != nil {
		t.Errorf("nullStr('') should return nil, got %v", v)
	}
}

func TestNullStr_NonEmpty(t *testing.T) {
	v := nullStr("hello")
	s, ok := v.(string)
	if !ok || s != "hello" {
		t.Errorf("nullStr('hello') = %v, want 'hello'", v)
	}
}

// ─── EnsureCategory DB error ──────────────────────────────────────────────────

func TestEnsureCategory_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnError(errCategory("insert error"))

	err := s.EnsureCategory(context.Background(), "Root")
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── IsSuppressedForCategory DB error ────────────────────────────────────────

func TestIsSuppressedForCategory_DBError(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM category_suppressions`).
		WillReturnError(errCategory("query error"))

	_, err := s.IsSuppressedForCategory(context.Background(), "e@ex.cz", "Root")
	if err == nil {
		t.Fatal("expected error")
	}
}

type errCategory string

func (e errCategory) Error() string { return string(e) }
