package classify

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── RunJob: HardBlocked/SoftBlocked/NeedsReview counters ──

// Company with VLikvidaci=true → ExclusionStatus="hard_block" → result.HardBlocked++
func TestRunJob_HardBlock_VLikvidaci(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			1, "Bad Corp s.r.o.", "99999999", "bad@corp.cz",
			"s.r.o.", "", "",
			"", "10 - 19 zaměstnanců",
			"", "", "", "",
			0, 0, "{}", false, true, // v_likvidaci=true
			nil,
		))
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(1, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunJob(context.Background(), db, JobConfig{BatchSize: 10, DryRun: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.HardBlocked != 1 {
		t.Errorf("HardBlocked = %d, want 1 (v_likvidaci triggers hard_block)", result.HardBlocked)
	}
}

// Company with VInsolvenci=true → ExclusionStatus="soft_block" → result.SoftBlocked++
func TestRunJob_SoftBlock_VInsolvenci(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			2, "Insolvent s.r.o.", "88888888", "ins@corp.cz",
			"s.r.o.", "", "",
			"", "10 - 19 zaměstnanců",
			"", "", "", "",
			0, 0, "{}", true, false, // v_insolvenci=true
			nil,
		))
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(2, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunJob(context.Background(), db, JobConfig{BatchSize: 10, DryRun: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SoftBlocked != 1 {
		t.Errorf("SoftBlocked = %d, want 1 (v_insolvenci triggers soft_block)", result.SoftBlocked)
	}
}

// Company with hard-block name pattern and no PravniForma → NeedsReview=true
func TestRunJob_NeedsReview_HardBlockNameNoForm(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// "Ministerstvo financí" matches hardBlockNameRegexps[0] and pf="" → NeedsReview=true
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			3, "Ministerstvo financí", "11111111", "mf@gov.cz",
			"", // PravniForma = "" → triggers NeedsReview
			"", "",
			"", "",
			"", "", "", "",
			0, 0, "{}", false, false,
			nil,
		))
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(3, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunJob(context.Background(), db, JobConfig{BatchSize: 10, DryRun: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.NeedsReview != 1 {
		t.Errorf("NeedsReview = %d, want 1", result.NeedsReview)
	}
}

// ── RunJob: scan error path (lines 85-88) ──

func TestRunJob_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Wrong number of columns → scan fails → rows.Close(); return error
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "Bad"))

	_, err = RunJob(context.Background(), db, JobConfig{BatchSize: 10})
	if err == nil {
		t.Error("expected scan error from RunJob")
	}
}

// ── RunReclassifyNACE: scan error path (lines 312-315) ──

func TestRunReclassifyNACE_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Wrong columns → scan fails in RunReclassifyNACE
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(1, "Bad"))

	_, err = RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 10)
	if err == nil {
		t.Error("expected scan error from RunReclassifyNACE")
	}
}

// ── RunReclassifyNACE: unchanged path (SectorSource != "nace") (lines 336-338) ──

func TestRunReclassifyNACE_Unchanged(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Company with empty NACE codes → ClassifySector won't produce nace source → unchanged
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			1, "Test s.r.o.", "12345678", "test@test.cz",
			"s.r.o.", "Strojirenstvi", "",
			"", "10 - 19 zaměstnanců",
			"", "", "", "",
			0, 0, "{}", // empty NACE → no nace source
			false, false,
			nil,
		))
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(1, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Unchanged < 1 {
		t.Errorf("Unchanged = %d, want >= 1 (no nace source)", result.Unchanged)
	}
}

// ── persistBatch: UPDATE companies error (lines 365-367) ──

func TestPersistBatch_CompanyUpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies`).
		WillReturnError(errClassify("batch update failed"))

	err = persistBatch(context.Background(), db, []int{1}, []ClassifyUpdate{{
		ExclusionStatus: "pass",
		SectorPrimary:   "machinery",
		SectorTags:      []string{"machinery"},
		ICPScore:        0.7,
	}})
	if err == nil {
		t.Error("expected error from persistBatch companies UPDATE")
	}
}

// ── RunReclassifyNACE: persistUpdate error (line 336-338) ──
// Company with NACE code "28xx" → SectorSource="nace" → persistUpdate called → fails.

func TestRunReclassifyNACE_PersistUpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Company with NACE code "2830" → maps to "machinery_agricultural" (source="nace")
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			1, "Zemedel s.r.o.", "12345678", "info@zemedel.cz",
			"Společnost s ručením omezeným", // CommercialForms → Pass immediately
			"", "", // no category path
			"", "10 - 19 zaměstnanců",
			"", "", "", "",
			0, 0, "{2830}", // NACE 2830 → machinery_agricultural → source="nace"
			false, false,
			nil,
		))
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(1, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	// persistUpdate → UPDATE companies fails
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errClassify("persist failed"))

	result, err := RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// persistUpdate error is non-fatal (continue) → Upgraded=0, Candidates=1
	if result.Candidates != 1 {
		t.Errorf("Candidates = %d, want 1", result.Candidates)
	}
}

// ── RunReclassifyNACE: Upgraded++ (line 340) — persistUpdate succeeds ──

func TestRunReclassifyNACE_Upgraded(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Company with NACE "2830" → nace source → persistUpdate called and succeeds
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			1, "Zemedel s.r.o.", "12345678", "info@zemedel.cz",
			"Společnost s ručením omezeným",
			"", "", "", "10 - 19 zaměstnanců",
			"", "", "", "",
			0, 0, "{2830}", false, false, nil,
		))
	// persistUpdate: called before the second SELECT
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Second SELECT (empty → break)
	mock.ExpectQuery(`SELECT id, COALESCE`).WithArgs(1, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Upgraded < 1 {
		t.Errorf("Upgraded = %d, want >= 1", result.Upgraded)
	}
}

// ── persistBatch: empty ids (line 353-355) ──

func TestPersistBatch_EmptyIds(t *testing.T) {
	err := persistBatch(context.Background(), nil, nil, nil)
	if err != nil {
		t.Errorf("expected nil for empty ids, got %v", err)
	}
}

// ── persistBatch: no sector tags → skip outreach_contacts (line 420-421) ──

func TestPersistBatch_NoSectorTags_SkipsContact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Companies UPDATE succeeds
	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// outreach_contacts UPDATE is NOT expected because SectorTags is empty

	err = persistBatch(context.Background(), db, []int{1}, []ClassifyUpdate{{
		ExclusionStatus: "pass",
		SectorTags:      nil, // empty → skip outreach_contacts update (line 420-421)
	}})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ── persistBatch: ExclusionReasons set (line 365-367) ──

func TestPersistBatch_WithExclusionReasons(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// No outreach_contacts update (SectorTags empty)

	err = persistBatch(context.Background(), db, []int{1}, []ClassifyUpdate{{
		ExclusionStatus:  "soft_block",
		ExclusionReasons: []string{"pravni_forma:spolek"}, // covers line 365-367
		SectorTags:       nil,
	}})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ── persistBatch: outreach_contacts UPDATE error (lines 373-375) ──

func TestPersistBatch_ContactUpdateError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Companies UPDATE succeeds
	mock.ExpectExec(`UPDATE companies`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Contacts UPDATE fails
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnError(errClassify("contact update failed"))

	err = persistBatch(context.Background(), db, []int{1}, []ClassifyUpdate{{
		ExclusionStatus: "pass",
		SectorPrimary:   "machinery",
		SectorTags:      []string{"machinery"},
		ICPScore:        0.7,
	}})
	if err == nil {
		t.Error("expected error from persistBatch outreach_contacts UPDATE")
	}
}
