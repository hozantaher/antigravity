package company

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestLoadMetadataSnapshot_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT\(\*\)::bigint AS companies`).
		WillReturnRows(sqlmock.NewRows([]string{
			"companies", "classified", "sector_primary", "pass_count", "hard_block", "soft_block",
		}).AddRow(100, 90, 80, 70, 5, 15))

	mock.ExpectQuery(`WITH\s+RECURSIVE expanded AS`).
		WillReturnRows(sqlmock.NewRows([]string{"categories_rows", "categories_company_sum"}).AddRow(120, 450))

	snap, err := LoadMetadataSnapshot(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Companies != 100 || snap.Classified != 90 || snap.SectorPrimary != 80 {
		t.Fatalf("unexpected company snapshot: %+v", snap)
	}
	if snap.Pass != 70 || snap.HardBlock != 5 || snap.SoftBlock != 15 {
		t.Fatalf("unexpected status snapshot: %+v", snap)
	}
	if snap.CategoriesRows != 120 || snap.CategoriesCompanySum != 450 {
		t.Fatalf("unexpected category snapshot: %+v", snap)
	}
}

func TestLoadMetadataSnapshot_CompanyQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT\(\*\)::bigint AS companies`).
		WillReturnError(errCompany("companies query failed"))

	_, err = LoadMetadataSnapshot(context.Background(), db)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadMetadataSnapshot_CategoriesQueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT\s+COUNT\(\*\)::bigint AS companies`).
		WillReturnRows(sqlmock.NewRows([]string{
			"companies", "classified", "sector_primary", "pass_count", "hard_block", "soft_block",
		}).AddRow(100, 90, 80, 70, 5, 15))

	mock.ExpectQuery(`WITH\s+RECURSIVE expanded AS`).
		WillReturnError(errCompany("categories query failed"))

	_, err = LoadMetadataSnapshot(context.Background(), db)
	if err == nil {
		t.Fatal("expected error")
	}
}

// TestCompareMetadataSnapshots_OneNilReturnsZeroDrift catches `|| → &&` on
// `if source == nil || target == nil`. With mutation `&&`: only returns early
// when BOTH are nil; if source=nil and target!=nil, dereferences nil → panic.
func TestCompareMetadataSnapshots_OneNilReturnsZeroDrift(t *testing.T) {
	target := &MetadataSnapshot{Companies: 10}
	// source=nil, target non-nil: must return unaligned zero drift, not panic
	drift := CompareMetadataSnapshots(nil, target)
	if drift.Aligned {
		t.Error("drift with nil source should not be Aligned")
	}
	if drift.Companies != 0 {
		t.Errorf("drift.Companies = %d, want 0 (early return)", drift.Companies)
	}
	// target=nil, source non-nil: same expectation
	drift2 := CompareMetadataSnapshots(&MetadataSnapshot{Companies: 5}, nil)
	if drift2.Companies != 0 {
		t.Errorf("drift2.Companies = %d, want 0 (early return)", drift2.Companies)
	}
}

func TestCompareMetadataSnapshots_Aligned(t *testing.T) {
	source := &MetadataSnapshot{
		Companies:            100,
		Classified:           95,
		SectorPrimary:        90,
		Pass:                 80,
		HardBlock:            5,
		SoftBlock:            15,
		CategoriesRows:       120,
		CategoriesCompanySum: 420,
	}
	target := &MetadataSnapshot{
		Companies:            100,
		Classified:           95,
		SectorPrimary:        90,
		Pass:                 80,
		HardBlock:            5,
		SoftBlock:            15,
		CategoriesRows:       120,
		CategoriesCompanySum: 420,
	}

	drift := CompareMetadataSnapshots(source, target)
	if !drift.Aligned {
		t.Fatalf("expected aligned, got drift: %+v", drift)
	}
}

// TestCompareMetadataSnapshots_AlignedFalseWhenOnlyCompaniesDrifts catches the
// `&& → ||` mutation on the first `&&` in the drift.Aligned expression.
// With mutation: `Companies==0 || Classified==0` — if Classified=0 (true), Aligned
// could be set to true even when Companies≠0. Test: Companies has drift, all others zero.
func TestCompareMetadataSnapshots_AlignedFalseWhenOnlyCompaniesDrifts(t *testing.T) {
	source := &MetadataSnapshot{Companies: 100}
	target := &MetadataSnapshot{Companies: 101} // +1 drift
	drift := CompareMetadataSnapshots(source, target)
	if drift.Aligned {
		t.Error("Aligned must be false when Companies drifts, even if Classified is 0 (catches `&& → ||`)")
	}
	if drift.Companies != 1 {
		t.Errorf("drift.Companies = %d, want 1", drift.Companies)
	}
}

func TestCompareMetadataSnapshots_Drift(t *testing.T) {
	source := &MetadataSnapshot{
		Companies:            100,
		Classified:           95,
		SectorPrimary:        90,
		Pass:                 80,
		HardBlock:            5,
		SoftBlock:            15,
		CategoriesRows:       120,
		CategoriesCompanySum: 420,
	}
	target := &MetadataSnapshot{
		Companies:            99,
		Classified:           90,
		SectorPrimary:        89,
		Pass:                 81,
		HardBlock:            4,
		SoftBlock:            14,
		CategoriesRows:       121,
		CategoriesCompanySum: 421,
	}

	drift := CompareMetadataSnapshots(source, target)
	if drift.Aligned {
		t.Fatalf("expected drift, got aligned: %+v", drift)
	}
	if drift.Companies != -1 || drift.Classified != -5 || drift.SectorPrimary != -1 {
		t.Fatalf("unexpected core drift: %+v", drift)
	}
	if drift.Pass != 1 || drift.HardBlock != -1 || drift.SoftBlock != -1 {
		t.Fatalf("unexpected status drift: %+v", drift)
	}
	if drift.CategoriesRows != 1 || drift.CategoriesCompanySum != 1 {
		t.Fatalf("unexpected category drift: %+v", drift)
	}
}
