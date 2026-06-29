package company

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func newMockDB2(t *testing.T) (*Store, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	return NewStore(db), mock, func() { db.Close() }
}

// ── TierStats via sqlmock ──

func TestTierStats_WithRows(t *testing.T) {
	s, mock, cleanup := newMockDB2(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT quality_tier, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"quality_tier", "count"}).
			AddRow("raw", 100).
			AddRow("enriched", 50).
			AddRow("scored", 25).
			AddRow("contacted", 10).
			AddRow("engaged", 3))

	stats, err := s.TierStats(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats["raw"] != 100 {
		t.Errorf("raw = %d, want 100", stats["raw"])
	}
	if stats["enriched"] != 50 {
		t.Errorf("enriched = %d, want 50", stats["enriched"])
	}
	if stats["engaged"] != 3 {
		t.Errorf("engaged = %d, want 3", stats["engaged"])
	}
}

func TestTierStats_EmptyResult(t *testing.T) {
	s, mock, cleanup := newMockDB2(t)
	defer cleanup()

	mock.ExpectQuery(`SELECT quality_tier, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"quality_tier", "count"}))

	stats, err := s.TierStats(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(stats) != 0 {
		t.Errorf("expected empty stats, got %v", stats)
	}
}

// ── UpdateMetrics via sqlmock ──

func TestUpdateMetrics_SqlmockSuccess(t *testing.T) {
	_, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	db2, mock2, err2 := sqlmock.New()
	if err2 != nil {
		t.Fatalf("sqlmock.New 2: %v", err2)
	}
	defer db2.Close()
	_ = mock

	s2 := NewStore(db2)

	mock2.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 15))
	mock2.ExpectExec(`UPDATE companies SET`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	n, err := s2.UpdateMetrics(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 15 {
		t.Errorf("updated = %d, want 15", n)
	}
}

func TestUpdateMetrics_Step2Error(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)

	mock.ExpectExec(`UPDATE companies co SET`).
		WillReturnResult(sqlmock.NewResult(0, 5))
	mock.ExpectExec(`UPDATE companies SET`).
		WillReturnError(errCompany("reset failed"))

	_, err = s.UpdateMetrics(context.Background())
	if err == nil {
		t.Error("expected error from step2")
	}
}

// ── LinkContactByFirmyCzID via sqlmock ──

func TestLinkContactByFirmyCzID_Sqlmock(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	mock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 7))

	n, err := s.LinkContactByFirmyCzID(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 7 {
		t.Errorf("linked = %d, want 7", n)
	}
}

// ── LinkContactByICO via sqlmock ──

func TestLinkContactByICO_Sqlmock(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	mock.ExpectExec(`UPDATE outreach_contacts oc SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	n, err := s.LinkContactByICO(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 3 {
		t.Errorf("linked = %d, want 3", n)
	}
}

// ── EnsureForContact via sqlmock ──

func TestEnsureForContact_Found(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT id FROM companies WHERE firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))
	mock.ExpectExec(`UPDATE outreach_contacts SET company_id`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	companyID, err := s.EnsureForContact(context.Background(), 1, 1001)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if companyID != 42 {
		t.Errorf("companyID = %d, want 42", companyID)
	}
}

func TestEnsureForContact_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT id FROM companies WHERE firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{"id"})) // no rows → ErrNoRows

	// Sqlmock returns sql.ErrNoRows when rows is empty and we scan
	// Actually sqlmock QueryRow with no rows does return ErrNoRows on Scan
	companyID, err := s.EnsureForContact(context.Background(), 1, 999999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if companyID != 0 {
		t.Errorf("companyID = %d, want 0 (not found)", companyID)
	}
}

func TestEnsureForContact_LinkError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)

	// Company found
	mock.ExpectQuery(`SELECT id FROM companies WHERE firmy_cz_id`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))

	// UPDATE outreach_contacts fails
	mock.ExpectExec(`UPDATE outreach_contacts SET company_id`).
		WillReturnError(errCompany("link failed"))

	_, err = s.EnsureForContact(context.Background(), 1, 1001)
	if err == nil {
		t.Error("expected error when link UPDATE fails")
	}
}

func TestEnsureForContact_LookupError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)

	mock.ExpectQuery(`SELECT id FROM companies WHERE firmy_cz_id`).
		WillReturnError(errCompany("lookup failed"))

	_, err = s.EnsureForContact(context.Background(), 1, 1001)
	if err == nil {
		t.Error("expected error when lookup fails")
	}
}

// ── Upsert via sqlmock ──

func TestUpsert_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	mock.ExpectQuery(`INSERT INTO companies`).
		WithArgs(
			12345, "12345678", "Firma s.r.o.", "info@firma.cz", "", "",
			"", "", "", "",
			"", "", "", `[{"name":"Strojirenstvi"}]`,
			4.5, 10,
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(99))

	c := &Company{
		FirmyCzID: 12345, ICO: "12345678", Name: "Firma s.r.o.",
		Email: "info@firma.cz", CategoriesJSON: `[{"name":"Strojirenstvi"}]`,
		RatingValue: 4.5, RatingCount: 10,
	}
	id, err := s.Upsert(context.Background(), c)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 99 {
		t.Errorf("id = %d, want 99", id)
	}
}

func TestUpsert_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	mock.ExpectQuery(`INSERT INTO companies`).
		WillReturnError(errCompany("upsert failed"))

	_, err = s.Upsert(context.Background(), &Company{FirmyCzID: 1})
	if err == nil {
		t.Error("expected error")
	}
}

// ── FindByID / FindByFirmyCzID / FindByICO via sqlmock ──

// companyCols matches companySelectCols – 43 columns
var companyCols = []string{
	"id", "firmy_cz_id", "ico", "name", "email", "telephone", "website",
	"street_address", "address_locality", "postal_code", "description",
	"velikost_firmy", "pravni_forma", "category_path", "rating_value", "rating_count",
	"quality_tier", "contact_count", "thread_count", "total_sent", "total_replied",
	"last_contacted", "last_replied", "best_targeting_score",
	"exclusion_status", "exclusion_reasons", "needs_review",
	"nace_codes", "nace_primary",
	"v_insolvenci", "v_likvidaci", "ares_synced_at",
	"sector_tags", "sector_primary",
	"sector_confidence", "sector_source",
	"icp_score", "icp_tier",
	"region_normalized", "classified_at",
	"synced_at", "created_at", "updated_at",
}

func TestFindByID_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	rows := sqlmock.NewRows(companyCols).AddRow(
		1, 12345, "12345678", "Firma s.r.o.", "info@firma.cz", "+420 123", "https://firma.cz",
		"Václavské nám. 1", "Praha", "110 00", "Strojírenství",
		"20 - 24 zaměstnanci", "111", "Výroba",
		4.5, 10,
		"scored", 2, 1, 5, 1,
		nil, nil, 0.7,
		"pending", "{}", false,
		"{}", "",
		false, false, nil,
		"{}", "",
		0.85, "ml",
		75, "ideal",
		"Praha", nil,
		time.Now(), time.Now(), time.Now(),
	)
	mock.ExpectQuery(`SELECT`).WillReturnRows(rows)

	c, err := s.FindByID(context.Background(), 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Name != "Firma s.r.o." {
		t.Errorf("name = %s", c.Name)
	}
}

func TestFindByID_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	mock.ExpectQuery(`SELECT`).WillReturnRows(sqlmock.NewRows(companyCols))

	_, err = s.FindByID(context.Background(), 999)
	if err == nil {
		t.Error("expected error for not found")
	}
}

func TestFindByFirmyCzID_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	rows := sqlmock.NewRows(companyCols).AddRow(
		1, 12345, "12345678", "Firma s.r.o.", "info@firma.cz", "+420 123", "https://firma.cz",
		"Václavské nám. 1", "Praha", "110 00", "Strojírenství",
		"20 - 24 zaměstnanci", "111", "Výroba",
		4.5, 10,
		"scored", 2, 1, 5, 1,
		nil, nil, 0.7,
		"pending", "{}", false,
		"{}", "",
		false, false, nil,
		"{}", "",
		0.85, "ml",
		75, "ideal",
		"Praha", nil,
		time.Now(), time.Now(), time.Now(),
	)
	mock.ExpectQuery(`SELECT`).WillReturnRows(rows)

	c, err := s.FindByFirmyCzID(context.Background(), 12345)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.FirmyCzID != 12345 {
		t.Errorf("firmy_cz_id = %d", c.FirmyCzID)
	}
}

func TestFindByICO_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	s := NewStore(db)
	rows := sqlmock.NewRows(companyCols).AddRow(
		1, 12345, "12345678", "Firma s.r.o.", "info@firma.cz", "+420 123", "https://firma.cz",
		"Václavské nám. 1", "Praha", "110 00", "Strojírenství",
		"20 - 24 zaměstnanci", "111", "Výroba",
		4.5, 10,
		"scored", 2, 1, 5, 1,
		nil, nil, 0.7,
		"pending", "{}", false,
		"{}", "",
		false, false, nil,
		"{}", "",
		0.85, "ml",
		75, "ideal",
		"Praha", nil,
		time.Now(), time.Now(), time.Now(),
	)
	mock.ExpectQuery(`SELECT`).WillReturnRows(rows)

	c, err := s.FindByICO(context.Background(), "12345678")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.ICO != "12345678" {
		t.Errorf("ico = %s", c.ICO)
	}
}

type errCompany string

func (e errCompany) Error() string { return string(e) }
