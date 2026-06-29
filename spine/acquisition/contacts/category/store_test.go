package category

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ─── Pure helper unit tests ───────────────────────────────────────────────────

func TestPathToSlug(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"Remesla-a-sluzby > Stavebni-sluzby", "remesla-a-sluzby~stavebni-sluzby"},
		{"Root", "root"},
		{"A > B > C", "a~b~c"},
		{"Auto-moto > Auto-moto-prodejci > Autobazary > Havarovana-vozidla", "auto-moto~auto-moto-prodejci~autobazary~havarovana-vozidla"},
	}
	for _, tc := range cases {
		got := pathToSlug(tc.path)
		if got != tc.want {
			t.Errorf("pathToSlug(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestPathName(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"Root", "Root"},
		{"A > B > C", "C"},
		{"Zemedelstvi > Rostlinne", "Rostlinne"},
	}
	for _, tc := range cases {
		got := pathName(tc.path)
		if got != tc.want {
			t.Errorf("pathName(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestParentPath(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"Root", ""},
		{"A > B", "A"},
		{"A > B > C", "A > B"},
	}
	for _, tc := range cases {
		got := parentPath(tc.path)
		if got != tc.want {
			t.Errorf("parentPath(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestAncestorPaths(t *testing.T) {
	got := ancestorPaths("A > B > C")
	want := []string{"A", "A > B", "A > B > C"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d; got %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ancestorPaths[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestAncestorPaths_Root(t *testing.T) {
	got := ancestorPaths("Root")
	if len(got) != 1 || got[0] != "Root" {
		t.Errorf("ancestorPaths(root) = %v, want [Root]", got)
	}
}

// ─── Sqlmock helpers ──────────────────────────────────────────────────────────

func newMockStore(t *testing.T) (*Store, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	return NewStore(db), mock, func() { db.Close() }
}

func categoryColumns() []string {
	return []string{"id", "path", "slug", "name", "parent_path", "depth", "company_count", "updated_at"}
}

// ─── ListRoots ────────────────────────────────────────────────────────────────

func TestListRoots_ReturnsRows(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(sqlmock.NewRows(categoryColumns()).
			AddRow(1, "Zemedelstvi", "zemedelstvi", "Zemedelstvi", "", 0, 300, time.Now()).
			AddRow(2, "Remesla", "remesla", "Remesla", "", 0, 200, time.Now()))

	cats, err := s.ListRoots(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cats) != 2 {
		t.Errorf("len = %d, want 2", len(cats))
	}
	if cats[0].CompanyCount != 300 {
		t.Errorf("first company_count = %d, want 300", cats[0].CompanyCount)
	}
}

func TestListRoots_Empty(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WillReturnRows(sqlmock.NewRows(categoryColumns()))

	cats, err := s.ListRoots(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cats) != 0 {
		t.Errorf("expected empty, got %d rows", len(cats))
	}
}

// ─── ListChildren ─────────────────────────────────────────────────────────────

func TestListChildren_ReturnsChildren(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("Zemedelstvi").
		WillReturnRows(sqlmock.NewRows(categoryColumns()).
			AddRow(10, "Zemedelstvi > Rostlinne", "zemedelstvi~rostlinne", "Rostlinne", "Zemedelstvi", 1, 50, time.Now()))

	cats, err := s.ListChildren(context.Background(), "Zemedelstvi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cats) != 1 || cats[0].ParentPath != "Zemedelstvi" {
		t.Errorf("unexpected result: %+v", cats)
	}
}

func TestListChildren_Empty(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("Leaf").
		WillReturnRows(sqlmock.NewRows(categoryColumns()))

	cats, err := s.ListChildren(context.Background(), "Leaf")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cats) != 0 {
		t.Errorf("expected empty children, got %d", len(cats))
	}
}

// ─── FindBySlug ───────────────────────────────────────────────────────────────

func TestFindBySlug_Found(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("zemedelstvi").
		WillReturnRows(sqlmock.NewRows(categoryColumns()).
			AddRow(1, "Zemedelstvi", "zemedelstvi", "Zemedelstvi", "", 0, 300, time.Now()))

	cat, err := s.FindBySlug(context.Background(), "zemedelstvi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cat == nil || cat.Slug != "zemedelstvi" {
		t.Errorf("expected slug=zemedelstvi, got %+v", cat)
	}
}

func TestFindBySlug_NotFound(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("nonexistent").
		WillReturnRows(sqlmock.NewRows(categoryColumns()))

	cat, err := s.FindBySlug(context.Background(), "nonexistent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cat != nil {
		t.Errorf("expected nil, got %+v", cat)
	}
}

// ─── FindByPath ───────────────────────────────────────────────────────────────

func TestFindByPath_Found(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT id, path, slug, name`).
		WithArgs("A > B").
		WillReturnRows(sqlmock.NewRows(categoryColumns()).
			AddRow(5, "A > B", "a~b", "B", "A", 1, 10, time.Now()))

	cat, err := s.FindByPath(context.Background(), "A > B")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cat == nil || cat.Path != "A > B" {
		t.Errorf("expected path=A > B, got %+v", cat)
	}
}

// ─── EnsureCategory ───────────────────────────────────────────────────────────

func TestEnsureCategory_Root(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO categories`).
		WithArgs("Root", "root", "Root", nil, 0).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := s.EnsureCategory(context.Background(), "Root")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestEnsureCategory_Child(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO categories`).
		WithArgs("A > B", "a~b", "B", "A", 1).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := s.EnsureCategory(context.Background(), "A > B")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ─── RefreshCounts ────────────────────────────────────────────────────────────

func TestRefreshCounts_ReturnsAffected(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO categories`).
		WillReturnResult(sqlmock.NewResult(0, 12))
	mock.ExpectExec(`WITH RECURSIVE ancestors AS`).
		WillReturnResult(sqlmock.NewResult(0, 4))
	mock.ExpectExec(`WITH RECURSIVE expanded AS`).
		WillReturnResult(sqlmock.NewResult(0, 42))

	n, err := s.RefreshCounts(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 42 {
		t.Errorf("n = %d, want 42", n)
	}
}

// ─── SuppressForCategory ─────────────────────────────────────────────────────

func TestSuppressForCategory_Inserts(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(`INSERT INTO category_suppressions`).
		WithArgs("bad@example.cz", "A > B", "opt-out").
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := s.SuppressForCategory(context.Background(), "bad@example.cz", "A > B", "opt-out")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ─── IsSuppressedForCategory ─────────────────────────────────────────────────

func TestIsSuppressedForCategory_True(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	// "A > B > C" → ancestors: A, A > B, A > B > C
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM category_suppressions`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	suppressed, err := s.IsSuppressedForCategory(context.Background(), "user@ex.cz", "A > B > C")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !suppressed {
		t.Error("expected suppressed=true")
	}
}

func TestIsSuppressedForCategory_False(t *testing.T) {
	s, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM category_suppressions`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	suppressed, err := s.IsSuppressedForCategory(context.Background(), "clean@ex.cz", "Root")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suppressed {
		t.Error("expected suppressed=false")
	}
}
