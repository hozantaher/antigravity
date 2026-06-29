package company

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"

	_ "github.com/lib/pq"
)

// ── Mock DB ──

type mockResult struct{ affected int64 }

func (m mockResult) LastInsertId() (int64, error) { return 0, nil }
func (m mockResult) RowsAffected() (int64, error) { return m.affected, nil }

type mockDB struct {
	execErr    error
	execResult sql.Result
	queryErr   error
}

func (m *mockDB) ExecContext(_ context.Context, _ string, _ ...any) (sql.Result, error) {
	if m.execErr != nil {
		return nil, m.execErr
	}
	if m.execResult != nil {
		return m.execResult, nil
	}
	return mockResult{affected: 1}, nil
}
func (m *mockDB) QueryContext(_ context.Context, _ string, _ ...any) (*sql.Rows, error) {
	return nil, m.queryErr
}
func (m *mockDB) QueryRowContext(_ context.Context, _ string, _ ...any) *sql.Row {
	return nil // Will panic on Scan — tests must handle
}

// ── Quality Tier Constants ──

func TestTierConstants(t *testing.T) {
	tiers := []string{TierRaw, TierEnriched, TierScored, TierContacted, TierEngaged}
	seen := make(map[string]bool)
	for _, tier := range tiers {
		if seen[tier] {
			t.Errorf("duplicate tier: %s", tier)
		}
		seen[tier] = true
	}
	if len(tiers) != 5 {
		t.Errorf("expected 5 tiers, got %d", len(tiers))
	}
}

func TestTierValues(t *testing.T) {
	if TierRaw != "raw" {
		t.Error("TierRaw should be 'raw'")
	}
	if TierEngaged != "engaged" {
		t.Error("TierEngaged should be 'engaged'")
	}
}

// ── Store Constructor ──

func TestNewStore(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	if s == nil {
		t.Fatal("NewStore returned nil")
	}
	if s.db != db {
		t.Error("store.db not set correctly")
	}
}

// ── LinkContactByFirmyCzID ──

func TestLinkContactByFirmyCzID_Success(t *testing.T) {
	db := &mockDB{execResult: mockResult{affected: 5}}
	s := NewStore(db)
	n, err := s.LinkContactByFirmyCzID(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 5 {
		t.Errorf("expected 5, got %d", n)
	}
}

func TestLinkContactByFirmyCzID_Error(t *testing.T) {
	db := &mockDB{execErr: errors.New("db error")}
	s := NewStore(db)
	_, err := s.LinkContactByFirmyCzID(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

// ── LinkContactByICO ──

func TestLinkContactByICO_Success(t *testing.T) {
	db := &mockDB{execResult: mockResult{affected: 3}}
	s := NewStore(db)
	n, err := s.LinkContactByICO(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 3 {
		t.Errorf("expected 3, got %d", n)
	}
}

func TestLinkContactByICO_Error(t *testing.T) {
	db := &mockDB{execErr: errors.New("db error")}
	s := NewStore(db)
	_, err := s.LinkContactByICO(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

// ── UpdateMetrics ──

func TestUpdateMetrics_Error(t *testing.T) {
	db := &mockDB{execErr: errors.New("db error")}
	s := NewStore(db)
	_, err := s.UpdateMetrics(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

// ── TierStats ──

func TestTierStats_Error(t *testing.T) {
	db := &mockDB{queryErr: errors.New("db error")}
	s := NewStore(db)
	_, err := s.TierStats(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

// ── Company struct ──

func TestCompanyDefaults(t *testing.T) {
	c := Company{}
	if c.QualityTier != "" {
		t.Error("Go zero value should be empty string")
	}
	if c.BestTargetingScore != 0 {
		t.Error("default targeting score should be 0")
	}
	if c.LastContacted != nil {
		t.Error("LastContacted should be nil by default")
	}
}

// ── UpdateMetrics (success) ──

func TestUpdateMetrics_Success(t *testing.T) {
	db := &mockDB{execResult: mockResult{affected: 15}}
	s := NewStore(db)
	n, err := s.UpdateMetrics(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 15 {
		t.Errorf("expected 15 updated, got %d", n)
	}
}

// ── EnsureForContact ──

// TestEnsureForContact_NewCompany verifies that EnsureForContact returns 0 when
// no company row exists for the given firmy_cz_id (integration — skipped without DB).
func TestEnsureForContact_NewCompany(t *testing.T) {
	dsn := os.Getenv("TEST_OUTREACH_DSN")
	if dsn == "" {
		t.Skip("TEST_OUTREACH_DSN not set — skipping integration test")
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		t.Skipf("cannot reach test DB: %v", err)
	}

	s := NewStore(db)
	// firmy_cz_id 999999999 is almost certainly absent in any test DB
	companyID, err := s.EnsureForContact(context.Background(), 1, 999999999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if companyID != 0 {
		t.Errorf("expected 0 when company not found, got %d", companyID)
	}
}

// TestEnsureForContact_Signature validates that the method signature compiles correctly.
func TestEnsureForContact_Signature(t *testing.T) {
	var s *Store = nil
	// Just ensure the method is callable; don't invoke (nil receiver would panic)
	_ = s
	// Method must accept (ctx, contactID, firmyCzID int) and return (int, error)
	var fn func(context.Context, int, int) (int, error) = (*Store)(nil).EnsureForContact
	_ = fn
}

// ── parsePgArray ──

func TestParsePgArray_Empty(t *testing.T) {
	if parsePgArray("") != nil {
		t.Error("empty string should return nil")
	}
}

func TestParsePgArray_EmptyBraces(t *testing.T) {
	if parsePgArray("{}") != nil {
		t.Error("{} should return nil")
	}
}

func TestParsePgArray_Single(t *testing.T) {
	got := parsePgArray("{machinery}")
	if len(got) != 1 || got[0] != "machinery" {
		t.Errorf("single element: got %v", got)
	}
}

func TestParsePgArray_Multiple(t *testing.T) {
	got := parsePgArray("{machinery,metalwork,construction}")
	if len(got) != 3 {
		t.Fatalf("expected 3, got %d: %v", len(got), got)
	}
	if got[0] != "machinery" || got[1] != "metalwork" || got[2] != "construction" {
		t.Errorf("values: %v", got)
	}
}

func TestParsePgArray_WithSpaces(t *testing.T) {
	got := parsePgArray("{ a , b , c }")
	if len(got) != 3 {
		t.Fatalf("expected 3, got %d: %v", len(got), got)
	}
	if got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("trimmed values: %v", got)
	}
}

// ── parsePgArray extra edge cases ──

func TestParsePgArray_SingleWithSpaces(t *testing.T) {
	got := parsePgArray("{  machinery  }")
	if len(got) != 1 || got[0] != "machinery" {
		t.Errorf("single with spaces: got %v", got)
	}
}

func TestParsePgArray_EmptyElements(t *testing.T) {
	// {a,,b} — empty element between commas → skipped; exactly 2 non-empty elements remain
	got := parsePgArray("{a,,b}")
	if len(got) != 2 {
		t.Fatalf("expected exactly 2 elements (empty skipped), got %d: %v", len(got), got)
	}
	if got[0] != "a" || got[1] != "b" {
		t.Errorf("values: got %v, want [a b]", got)
	}
}

func TestParsePgArray_AllEmptyParts(t *testing.T) {
	// Just commas: {,,} → all empty after trim → nil
	got := parsePgArray("{,,}")
	if len(got) != 0 {
		t.Errorf("all-empty parts should return 0, got %v", got)
	}
}

// ── Company struct fields ──

func TestCompany_AllFields(t *testing.T) {
	c := Company{
		ID:               42,
		FirmyCzID:        1001,
		ICO:              "12345678",
		Name:             "Test s.r.o.",
		Email:            "info@test.cz",
		Telephone:        "+420123456789",
		Website:          "https://test.cz",
		StreetAddress:    "Ulice 1",
		AddressLocality:  "Praha",
		PostalCode:       "10000",
		Description:      "Testovací firma",
		VelikostFirmy:    "medium",
		PravniForma:      "s.r.o.",
		CategoryPath:     "Stroje > Obráběcí stroje",
		RatingValue:      4.5,
		RatingCount:      100,
		QualityTier:      TierEnriched,
		ContactCount:     5,
		ThreadCount:      3,
		TotalSent:        20,
		TotalReplied:     2,
		BestTargetingScore: 0.75,
		ExclusionStatus:  "pass",
		NeedsReview:      false,
		NACECodes:        []string{"28.41"},
		NACEPrimary:      "28.41",
		VInsolvenci:      false,
		VLikvidaci:       false,
		SectorTags:       []string{"machinery"},
		SectorPrimary:    "machinery",
		SectorConfidence: 0.9,
		SectorSource:     "nace",
		ICPScore:         0.8,
		ICPTier:          "ideal",
		RegionNormalized: "Praha",
	}
	if c.ID != 42 { t.Error("ID") }
	if c.ICO != "12345678" { t.Error("ICO") }
	if c.QualityTier != TierEnriched { t.Error("QualityTier") }
	if c.ICPTier != "ideal" { t.Error("ICPTier") }
	if len(c.NACECodes) != 1 || c.NACECodes[0] != "28.41" { t.Error("NACECodes") }
	if len(c.SectorTags) != 1 || c.SectorTags[0] != "machinery" { t.Error("SectorTags") }
}

// ── TierStats (success path with nil rows) ──

func TestTierStats_NilRows_Error(t *testing.T) {
	db := &mockDB{queryErr: errors.New("expected")}
	s := NewStore(db)
	_, err := s.TierStats(context.Background())
	if err == nil { t.Error("expected error") }
}

// ── NewStore with nil DB ──

func TestNewStore_NilDB(t *testing.T) {
	s := NewStore(nil)
	if s == nil { t.Fatal("nil store") }
}

// ── SyncResult aggregation ──

func TestSyncResult_Aggregation(t *testing.T) {
	r := SyncResult{
		CompaniesUpserted: 100,
		LinkedByFirmyID:   50,
		LinkedByICO:       10,
		MetricsUpdated:    80,
	}
	if r.CompaniesUpserted != 100 {
		t.Errorf("expected CompaniesUpserted=100, got %d", r.CompaniesUpserted)
	}
	if r.LinkedByFirmyID != 50 {
		t.Errorf("expected LinkedByFirmyID=50, got %d", r.LinkedByFirmyID)
	}
	if r.LinkedByICO != 10 {
		t.Errorf("expected LinkedByICO=10, got %d", r.LinkedByICO)
	}
	if r.MetricsUpdated != 80 {
		t.Errorf("expected MetricsUpdated=80, got %d", r.MetricsUpdated)
	}
}
