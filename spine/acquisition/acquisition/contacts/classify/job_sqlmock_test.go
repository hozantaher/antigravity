package classify

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── classifyOne — pure function, no DB ──

func TestClassifyOne_Pass(t *testing.T) {
	r := companyRow{
		ID:              1,
		Name:            "Strojírna s.r.o.",
		ICO:             "12345678",
		Email:           "info@strojirna.cz",
		PravniForma:     "s.r.o.",
		CategoryPath:    "Strojirenstvi > Obrabeni kovu",
		CategoriesJSON:  "",
		Description:     "Výroba CNC strojů a obráběcích center pro průmysl",
		VelikostFirmy:   "25 - 49 zaměstnanců",
		PostalCode:      "11000",
		AddressLocality: "Praha",
		Website:         "https://strojirna.cz",
		Telephone:       "+420123456789",
		RatingValue:     4.5,
		RatingCount:     10,
		NACECodesRaw:    "{2899}",
		VInsolvenci:     false,
		VLikvidaci:      false,
	}
	cfg := DefaultICPConfig()
	u := classifyOne(r, cfg)

	if u.ExclusionStatus != "pass" {
		t.Errorf("ExclusionStatus = %q, want pass", u.ExclusionStatus)
	}
	if u.SectorPrimary == "" {
		t.Error("expected SectorPrimary to be set")
	}
	if u.ICPScore <= 0 {
		t.Errorf("ICPScore = %f, want > 0", u.ICPScore)
	}
	if u.RegionNormalized == "" {
		t.Error("expected RegionNormalized to be set")
	}
}

func TestClassifyOne_HardBlock(t *testing.T) {
	r := companyRow{
		ID:          2,
		Name:        "Testovací Likvidátor s.r.o.",
		PravniForma: "s.r.o.",
		VLikvidaci:  true, // should trigger hard block
	}
	u := classifyOne(r, DefaultICPConfig())
	if u.ExclusionStatus == "pass" {
		t.Error("expected non-pass exclusion status for company in liquidation")
	}
	// Should return early without sector/ICP data
	if u.SectorPrimary != "" {
		t.Error("hard-blocked company should not have SectorPrimary")
	}
}

func TestClassifyOne_NoSectorMatch(t *testing.T) {
	r := companyRow{
		ID:    3,
		Name:  "Žiadny Sektor a.s.",
		ICO:   "99999999",
		Email: "info@zadny.cz",
	}
	u := classifyOne(r, DefaultICPConfig())
	// Pass exclusion, but no sector recognized
	if u.ExclusionStatus != "pass" {
		t.Logf("exclusion: %s", u.ExclusionStatus)
	}
	// ICPScore may be 0 if no sector match — just verify no panic
	_ = u.ICPScore
}

// ── persistUpdate via sqlmock ──

func TestPersistUpdate_WithSectorTags(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	u := ClassifyUpdate{
		ExclusionStatus:  "pass",
		ExclusionReasons: nil,
		NeedsReview:      false,
		SectorTags:       []string{"machinery", "metalwork"},
		SectorPrimary:    "machinery",
		SectorConfidence: 0.95,
		SectorSource:     "nace",
		ICPScore:         0.8,
		ICPTier:          "ideal",
		RegionNormalized: "Jihomoravský kraj",
	}

	// UPDATE companies SET ...
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// UPDATE outreach_contacts (because SectorTags is non-empty)
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	err = persistUpdate(context.Background(), db, 1, u)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestPersistUpdate_NoSectorTags(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	u := ClassifyUpdate{
		ExclusionStatus: "hard_block",
		NeedsReview:     false,
		SectorTags:      nil, // no tags → no second UPDATE
	}

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// No second ExpectExec because SectorTags is empty

	err = persistUpdate(context.Background(), db, 2, u)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

func TestPersistUpdate_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errClassify("update failed"))

	err = persistUpdate(context.Background(), db, 3, ClassifyUpdate{})
	if err == nil { t.Error("expected error") }
}

func TestPersistUpdate_WithExclusionReasons(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	u := ClassifyUpdate{
		ExclusionStatus:  "soft_block",
		ExclusionReasons: []string{"low_rating", "no_website"},
		NeedsReview:      true,
		SectorTags:       nil,
	}

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err = persistUpdate(context.Background(), db, 4, u)
	if err != nil { t.Errorf("unexpected error: %v", err) }
}

// ── RunJob via sqlmock ──

var jobCols = []string{
	"id", "name", "ico", "email",
	"pravni_forma", "category_path", "categories_json",
	"description", "velikost_firmy",
	"postal_code", "address_locality",
	"website", "telephone",
	"rating_value", "rating_count",
	"nace_codes",
	"v_insolvenci", "v_likvidaci",
	"datum_vzniku",
}

func TestRunJob_EmptyBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// First query returns no rows → break immediately
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunJob(context.Background(), db, JobConfig{BatchSize: 10})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Processed != 0 { t.Errorf("Processed = %d, want 0", result.Processed) }
}

func TestRunJob_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnError(errClassify("db error"))

	_, err = RunJob(context.Background(), db, JobConfig{})
	if err == nil { t.Error("expected error") }
}

func TestRunJob_DryRun_OneBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Capture slog warnings — if persistBatch is unexpectedly called (via `&& → ||` mutation),
	// RunJob logs "classify persist batch error". That warning must NOT appear in DryRun mode.
	var logBuf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer slog.SetDefault(prev)

	// WithArgs pins lastID=0, BatchSize=10. Mutation `<= → >=` resets BatchSize=10 to 5000,
	// producing WithArgs(0,5000) mismatch → test fails immediately on the first SELECT.
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WithArgs(0, 10).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			1, "Strojírna s.r.o.", "12345678", "info@strojirna.cz",
			"s.r.o.", "Strojirenstvi > Obrabeni", "",
			"CNC stroje a obráběcí centra", "25 - 49 zaměstnanců",
			"11000", "Praha",
			"https://strojirna.cz", "+420123456789",
			4.5, 10,
			"{2899}",
			false, false,
			nil,
		))

	// Second query: lastID=1 (row ID processed above), BatchSize=10
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WithArgs(1, 10).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunJob(context.Background(), db, JobConfig{BatchSize: 10, DryRun: true})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Processed != 1 { t.Errorf("Processed = %d, want 1", result.Processed) }
	if result.Scored < 1 {
		t.Errorf("Scored = %d, want >= 1 for machinery company with NACE 2899", result.Scored)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations: %v", err)
	}
	// Catches `&& → ||` on `!cfg.DryRun && len(updates) > 0`:
	// mutation makes persistBatch run, which logs "classify persist batch error"
	if strings.Contains(logBuf.String(), "classify persist batch error") {
		t.Error("DryRun=true must not call persistBatch (catches `&& → ||`)")
	}
}

// ── RunReclassifyCategory via sqlmock ──

func TestRunReclassifyCategory_EmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// ExecContext returns 0 rows affected → < batchSize → break
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	result, err := RunReclassifyCategory(context.Background(), db, 100)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Candidates != 0 { t.Errorf("Candidates = %d, want 0", result.Candidates) }
}

func TestRunReclassifyCategory_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errClassify("exec failed"))

	_, err = RunReclassifyCategory(context.Background(), db, 0)
	if err == nil { t.Error("expected error") }
}

func TestRunReclassifyCategory_OneBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// First exec: 3 rows reset (< batchSize=100 → break)
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	result, err := RunReclassifyCategory(context.Background(), db, 100)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Candidates != 3 { t.Errorf("Candidates = %d, want 3", result.Candidates) }
	if result.Upgraded != 3 { t.Errorf("Upgraded = %d, want 3", result.Upgraded) }
}

// ── RunReclassifyNACE via sqlmock ──

func TestRunReclassifyNACE_EmptyBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 100)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Candidates != 0 { t.Errorf("Candidates = %d, want 0", result.Candidates) }
}

func TestRunReclassifyNACE_QueryError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnError(errClassify("reclassify query failed"))

	_, err = RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 0)
	if err == nil { t.Error("expected error") }
}

func TestRunReclassifyNACE_OneBatch_NoUpgrade(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// One row with keywords-only description (sector_source will NOT be "nace") → unchanged
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			5, "Retail s.r.o.", "", "",
			"", "", "",
			"Prodej oblečení", "",
			"", "",
			"", "",
			0.0, 0,
			"{}",
			false, false,
			nil,
		))
	// No rows → break
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunReclassifyNACE(context.Background(), db, DefaultICPConfig(), 100)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Candidates != 1 { t.Errorf("Candidates = %d, want 1", result.Candidates) }
}

// ── RunJob non-DryRun: exercises persistBatch ──

func TestRunJob_NonDryRun_WithBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// First query: 1 machinery row → classifyOne produces sector tags → persistBatch called
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			10, "Strojírna a.s.", "87654321", "info@as.cz",
			"a.s.", "Strojirenstvi > Obrabeni kovu", "",
			"Výroba CNC strojů", "50 - 99 zaměstnanců",
			"60200", "Brno",
			"https://strojirna.cz", "+420987654321",
			4.2, 8,
			"{2562}",
			false, false,
			nil,
		))

	// persistBatch: UPDATE companies (batch VALUES)
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// persistBatch: UPDATE outreach_contacts (if sector tags non-empty)
	mock.ExpectExec(`UPDATE outreach_contacts SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Second query: lastID=10 after processing row ID=10
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WithArgs(10, 100).
		WillReturnRows(sqlmock.NewRows(jobCols))

	result, err := RunJob(context.Background(), db, JobConfig{
		BatchSize: 100,
		DryRun:    false,
		ICPConfig: DefaultICPConfig(),
	})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Processed != 1 { t.Errorf("Processed = %d, want 1", result.Processed) }
}

func TestRunJob_NonDryRun_PersistBatchError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// One row
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WithArgs(0, 100).
		WillReturnRows(sqlmock.NewRows(jobCols).AddRow(
			11, "Firma s.r.o.", "11111111", "info@firma.cz",
			"s.r.o.", "Strojirenstvi", "",
			"Výroba", "10 - 19 zaměstnanců",
			"10100", "Praha",
			"", "",
			3.0, 2,
			"{2562}",
			false, false,
			nil,
		))

	// persistBatch fails → slog.Warn but loop continues
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errClassify("batch update failed"))

	// Second query: lastID=11
	mock.ExpectQuery(`SELECT id, COALESCE\(name`).
		WithArgs(11, 100).
		WillReturnRows(sqlmock.NewRows(jobCols))

	// RunJob logs the error but still returns success (Warn, not fatal)
	result, err := RunJob(context.Background(), db, JobConfig{
		BatchSize: 100,
		DryRun:    false,
		ICPConfig: DefaultICPConfig(),
	})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if result.Processed != 1 { t.Errorf("Processed = %d, want 1", result.Processed) }
}

type errClassify string
func (e errClassify) Error() string { return string(e) }
