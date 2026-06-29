package contact

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

// ── Mock DB ──

type mockResult struct{ affected int64 }

func (m mockResult) LastInsertId() (int64, error) { return 0, nil }
func (m mockResult) RowsAffected() (int64, error) { return m.affected, nil }

type mockDB struct {
	execErr    error
	execResult sql.Result
	queryErr   error
	beginErr   error
}

func (m *mockDB) ExecContext(_ context.Context, _ string, _ ...any) (sql.Result, error) {
	if m.execErr != nil { return nil, m.execErr }
	if m.execResult != nil { return m.execResult, nil }
	return mockResult{affected: 1}, nil
}
func (m *mockDB) QueryContext(_ context.Context, _ string, _ ...any) (*sql.Rows, error) {
	return nil, m.queryErr
}
func (m *mockDB) QueryRowContext(_ context.Context, _ string, _ ...any) *sql.Row {
	return nil // Will panic on Scan — tests must handle
}
func (m *mockDB) BeginTx(_ context.Context, _ *sql.TxOptions) (*sql.Tx, error) {
	return nil, m.beginErr
}

// ── Hash Tests ──

func TestHashEmail_Deterministic(t *testing.T) {
	h1 := hashEmail("test@firma.cz")
	h2 := hashEmail("test@firma.cz")
	if h1 != h2 { t.Error("same input → different hash") }
}

func TestHashEmail_CaseInsensitive(t *testing.T) {
	if hashEmail("Test@Firma.CZ") != hashEmail("test@firma.cz") { t.Error("not case-insensitive") }
}

func TestHashEmail_TrimsWhitespace(t *testing.T) {
	if hashEmail("  test@firma.cz  ") != hashEmail("test@firma.cz") { t.Error("not trimming") }
}

func TestHashEmail_Length(t *testing.T) {
	if len(hashEmail("test@firma.cz")) != 64 { t.Error("SHA256 = 64 hex chars") }
}

func TestHashEmail_Different(t *testing.T) {
	if hashEmail("a@f.cz") == hashEmail("b@f.cz") { t.Error("different emails → same hash") }
}

func TestHashEmail_Empty(t *testing.T) {
	h := hashEmail("")
	if h == "" { t.Error("empty email should still produce hash") }
	if len(h) != 64 { t.Error("wrong length") }
}

// ── Status Tests ──

func TestStatus_Constants(t *testing.T) {
	statuses := []Status{
		StatusNew, StatusValidating, StatusValid, StatusInvalid,
		StatusSent, StatusOpened, StatusReplied,
		StatusBounced, StatusUnsubscribed, StatusBlacklisted,
	}
	seen := make(map[Status]bool)
	for _, s := range statuses {
		if seen[s] { t.Errorf("duplicate: %s", s) }
		seen[s] = true
		if s == "" { t.Error("empty status") }
	}
	if len(statuses) != 10 { t.Errorf("expected 10 statuses, got %d", len(statuses)) }
}

func TestStatus_Values(t *testing.T) {
	if StatusNew != "new" { t.Error("StatusNew") }
	if StatusValid != "valid" { t.Error("StatusValid") }
	if StatusBounced != "bounced" { t.Error("StatusBounced") }
	if StatusBlacklisted != "blacklisted" { t.Error("StatusBlacklisted") }
}

// ── Validation Result Tests ──

func TestValidationResult_JSON(t *testing.T) {
	vr := ValidationResult{
		SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(true),
		IsCatchAll: false, IsDisposable: false, RiskLevel: "low",
	}
	data, err := json.Marshal(vr)
	if err != nil { t.Fatal(err) }
	var parsed ValidationResult
	if err := json.Unmarshal(data, &parsed); err != nil { t.Fatal(err) }
	if !parsed.SyntaxValid { t.Error("SyntaxValid") }
	if parsed.SMTPValid == nil || !*parsed.SMTPValid { t.Error("SMTPValid") }
	if parsed.RiskLevel != "low" { t.Error("RiskLevel") }
}

func TestValidationResult_OmitSMTP(t *testing.T) {
	vr := ValidationResult{SyntaxValid: true}
	data, _ := json.Marshal(vr)
	if strContains(string(data), "smtp_valid") { t.Error("smtp_valid should be omitted") }
}

func TestValidationResult_AllFields(t *testing.T) {
	vr := ValidationResult{
		SyntaxValid: true, MXExists: true, SMTPValid: boolPtr(false),
		IsCatchAll: true, IsDisposable: true, RiskLevel: "high",
	}
	data, _ := json.Marshal(vr)
	s := string(data)
	for _, field := range []string{"syntax_valid", "mx_exists", "smtp_valid", "is_catch_all", "is_disposable", "risk_level"} {
		if !strContains(s, field) { t.Errorf("missing field: %s in %s", field, s) }
	}
}

// ── Segment Filter Tests ──

func TestSegmentFilter_Empty(t *testing.T) {
	seg := SegmentFilter{}
	if len(seg.Regions) != 0 || seg.MinScore != nil { t.Error("should be zero-value") }
}

func TestSegmentFilter_WithValues(t *testing.T) {
	min := 5
	seg := SegmentFilter{
		Regions: []string{"Praha", "Brno"}, Industries: []string{"IT"},
		MinScore: &min, Statuses: []Status{StatusValid}, CompanySize: []string{"small"},
	}
	if len(seg.Regions) != 2 { t.Error("regions") }
	if *seg.MinScore != 5 { t.Error("min score") }
}

// ── Contact Struct Tests ──

func TestContact_Struct(t *testing.T) {
	c := Contact{
		Email: "test@f.cz", FirstName: "Jan", LastName: "Novák",
		CompanyName: "Firma s.r.o.", ICO: "12345678", Region: "Praha",
		Industry: "IT", CompanySize: "small", Score: 80,
		Status: StatusNew, Source: "firmy-cz",
	}
	if c.Email != "test@f.cz" { t.Error("email") }
	if c.Score != 80 { t.Error("score") }
	if c.Status != StatusNew { t.Error("status") }
	if c.CompanySize != "small" { t.Error("size") }
}

// ── Store Constructor ──

func TestNewStore(t *testing.T) {
	s := NewStore(&mockDB{})
	if s == nil { t.Fatal("nil store") }
}

func TestNewStore_NilDB(t *testing.T) {
	s := NewStore(nil)
	if s == nil { t.Fatal("nil store with nil DB") }
}

// ── Store Create (mock) ──

func TestStore_Create_SetsHash(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)

	c := &Contact{Email: "test@firma.cz", FirstName: "Jan", Status: StatusNew}
	err := s.Create(context.Background(), c)
	if err != nil { t.Fatalf("create: %v", err) }
	if c.EmailHash == "" { t.Error("hash not set") }
	if c.EmailHash != hashEmail("test@firma.cz") { t.Error("wrong hash") }
}

func TestStore_Create_DBError(t *testing.T) {
	db := &mockDB{execErr: errors.New("connection refused")}
	s := NewStore(db)

	c := &Contact{Email: "test@firma.cz"}
	err := s.Create(context.Background(), c)
	if err == nil { t.Error("expected error") }
}

// ── Store UpdateStatus (mock) ──

func TestStore_UpdateStatus(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	err := s.UpdateStatus(context.Background(), 1, StatusValid)
	if err != nil { t.Fatalf("update: %v", err) }
}

func TestStore_UpdateStatus_Error(t *testing.T) {
	db := &mockDB{execErr: errors.New("fail")}
	s := NewStore(db)
	err := s.UpdateStatus(context.Background(), 1, StatusValid)
	if err == nil { t.Error("expected error") }
}

// ── Store UpdateValidation (mock) ──

func TestStore_UpdateValidation_Valid(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	vr := &ValidationResult{SyntaxValid: true, MXExists: true}
	err := s.UpdateValidation(context.Background(), 1, vr)
	if err != nil { t.Fatalf("update: %v", err) }
}

func TestStore_UpdateValidation_Invalid(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	vr := &ValidationResult{SyntaxValid: false, MXExists: false}
	err := s.UpdateValidation(context.Background(), 1, vr)
	if err != nil { t.Fatalf("update: %v", err) }
}

func TestStore_UpdateValidation_Disposable(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	vr := &ValidationResult{SyntaxValid: true, MXExists: true, IsDisposable: true}
	err := s.UpdateValidation(context.Background(), 1, vr)
	if err != nil { t.Fatalf("update: %v", err) }
}

// ── Store BulkImport (error path) ──

func TestStore_BulkImport_BeginTxError(t *testing.T) {
	db := &mockDB{beginErr: errors.New("no connection")}
	s := NewStore(db)
	_, err := s.BulkImport(context.Background(), []Contact{{Email: "a@b.cz"}})
	if err == nil { t.Error("expected error on begin") }
}

// ── FindBySegment (error path) ──

func TestStore_FindBySegment_QueryError(t *testing.T) {
	db := &mockDB{queryErr: errTest("db error")}
	s := NewStore(db)
	_, err := s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err == nil { t.Error("expected error from QueryContext") }
}

func TestStore_FindBySegment_EmptyFilter(t *testing.T) {
	// queryErr = nil → QueryContext returns (nil, nil) → rows.Next() panics
	// So we set queryErr to get a controlled failure
	db := &mockDB{queryErr: errTest("no db")}
	s := NewStore(db)
	_, err := s.FindBySegment(context.Background(), SegmentFilter{}, 10, 0)
	if err == nil { t.Error("expected error") }
}

func TestStore_FindBySegment_WithStatuses(t *testing.T) {
	db := &mockDB{queryErr: errTest("expected")}
	s := NewStore(db)
	_, err := s.FindBySegment(context.Background(), SegmentFilter{
		Statuses: []Status{StatusValid, StatusSent},
	}, 20, 0)
	if err == nil { t.Error("expected error") }
}

func TestStore_FindBySegment_WithAllFilters(t *testing.T) {
	db := &mockDB{queryErr: errTest("expected")}
	s := NewStore(db)
	minScore := 50
	_, err := s.FindBySegment(context.Background(), SegmentFilter{
		Statuses:    []Status{StatusValid},
		Regions:     []string{"Praha", "Brno"},
		Industries:  []string{"IT", "machinery"},
		MinScore:    &minScore,
		CompanySize: []string{"small"},
	}, 100, 50)
	if err == nil { t.Error("expected error") }
}

// ── CountByStatus (error path) ──

func TestStore_CountByStatus_QueryError(t *testing.T) {
	db := &mockDB{queryErr: errTest("db error")}
	s := NewStore(db)
	_, err := s.CountByStatus(context.Background())
	if err == nil { t.Error("expected error from QueryContext") }
}

// ── UpdateValidation status logic ──

func TestStore_UpdateValidation_StatusLogic_Invalid_NoSyntax(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	// SyntaxValid=false → status=invalid
	vr := &ValidationResult{SyntaxValid: false, MXExists: true, IsDisposable: false}
	err := s.UpdateValidation(context.Background(), 1, vr)
	if err != nil { t.Fatalf("update: %v", err) }
}

func TestStore_UpdateValidation_StatusLogic_Invalid_NoMX(t *testing.T) {
	db := &mockDB{}
	s := NewStore(db)
	// MXExists=false → status=invalid
	vr := &ValidationResult{SyntaxValid: true, MXExists: false, IsDisposable: false}
	err := s.UpdateValidation(context.Background(), 1, vr)
	if err != nil { t.Fatalf("update: %v", err) }
}

func TestStore_UpdateValidation_DBError(t *testing.T) {
	db := &mockDB{execErr: errTest("fail")}
	s := NewStore(db)
	vr := &ValidationResult{SyntaxValid: true, MXExists: true}
	err := s.UpdateValidation(context.Background(), 1, vr)
	if err == nil { t.Error("expected error") }
}

// ── SegmentFilter edge cases ──

func TestSegmentFilter_MaxScore(t *testing.T) {
	min, max := 10, 80
	seg := SegmentFilter{MinScore: &min, MaxScore: &max}
	if *seg.MinScore != 10 { t.Error("min score") }
	if *seg.MaxScore != 80 { t.Error("max score") }
}

func TestSegmentFilter_MultipleStatuses(t *testing.T) {
	seg := SegmentFilter{
		Statuses: []Status{StatusNew, StatusValid, StatusBounced, StatusUnsubscribed},
	}
	if len(seg.Statuses) != 4 { t.Errorf("got %d statuses", len(seg.Statuses)) }
}

// ── Helpers ──

type errTest string
func (e errTest) Error() string { return string(e) }

func boolPtr(b bool) *bool { return &b }

func strContains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub { return true }
	}
	return false
}
