package prodlike

import (
	"context"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestDashboardCategories_Invariants(t *testing.T) {
	cats := dashboardCategories()
	if len(cats) < 40 {
		t.Fatalf("expected at least 40 dashboard categories, got %d", len(cats))
	}

	seenPaths := make(map[string]struct{}, len(cats))
	seenSlugs := make(map[string]struct{}, len(cats))
	for _, c := range cats {
		if c.Path == "" || c.Slug == "" || c.Name == "" {
			t.Fatalf("category has empty fields: %+v", c)
		}
		if _, dup := seenPaths[c.Path]; dup {
			t.Fatalf("duplicate category path %q", c.Path)
		}
		seenPaths[c.Path] = struct{}{}
		if _, dup := seenSlugs[c.Slug]; dup {
			t.Fatalf("duplicate category slug %q", c.Slug)
		}
		seenSlugs[c.Slug] = struct{}{}
	}

	for _, c := range cats {
		if !strings.Contains(c.Path, " > ") {
			continue
		}
		parentPath := c.Path[:strings.LastIndex(c.Path, " > ")]
		if _, ok := seenPaths[parentPath]; !ok {
			t.Fatalf("missing parent path %q for category %q", parentPath, c.Path)
		}
	}
}

func TestSeedDashboard_SQLMock(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	for range dashboardCategories() {
		mock.ExpectExec("INSERT INTO categories").
			WillReturnResult(sqlmock.NewResult(1, 1))
	}
	for i := 0; i < 4; i++ {
		mock.ExpectExec("INSERT INTO personas").
			WillReturnResult(sqlmock.NewResult(1, 1))
	}
	for i := 0; i < 5; i++ {
		mock.ExpectExec("INSERT INTO segments").
			WillReturnResult(sqlmock.NewResult(1, 1))
	}
	for i := 0; i < 10; i++ {
		mock.ExpectExec("INSERT INTO feature_flags").
			WillReturnResult(sqlmock.NewResult(1, 1))
	}
	for i := 0; i < 4; i++ {
		mock.ExpectExec("INSERT INTO users").
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	res, err := SeedDashboard(context.Background(), db)
	if err != nil {
		t.Fatalf("SeedDashboard returned error: %v", err)
	}

	if res.Categories != len(dashboardCategories()) {
		t.Fatalf("categories=%d, want %d", res.Categories, len(dashboardCategories()))
	}
	if res.Personas != 4 {
		t.Fatalf("personas=%d, want 4", res.Personas)
	}
	if res.Segments != 5 {
		t.Fatalf("segments=%d, want 5", res.Segments)
	}
	if res.FeatureFlags != 10 {
		t.Fatalf("featureFlags=%d, want 10", res.FeatureFlags)
	}
	if res.Users != 4 {
		t.Fatalf("users=%d, want 4", res.Users)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock expectations: %v", err)
	}
}
