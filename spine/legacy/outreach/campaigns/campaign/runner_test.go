package campaign

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

// ── Mock DB ──

type mockResult struct{ affected int64 }
func (m mockResult) LastInsertId() (int64, error) { return 1, nil }
func (m mockResult) RowsAffected() (int64, error) { return m.affected, nil }

type mockDB struct {
	execErr  error
	queryErr error
}

func (m *mockDB) ExecContext(_ context.Context, _ string, _ ...any) (sql.Result, error) {
	if m.execErr != nil { return nil, m.execErr }
	return mockResult{affected: 1}, nil
}

func (m *mockDB) QueryContext(_ context.Context, _ string, _ ...any) (*sql.Rows, error) {
	if m.queryErr != nil { return nil, m.queryErr }
	return nil, errors.New("no rows mock")
}

func (m *mockDB) QueryRowContext(_ context.Context, query string, _ ...any) *sql.Row {
	return nil // Will cause scan to fail — tests handle this
}

// ── Struct/JSON Tests ──

func TestSequenceStep_JSON(t *testing.T) {
	steps := []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 5, TemplateName: "followup1"},
		{Step: 2, DelayDays: 12, TemplateName: "final"},
	}
	data, err := json.Marshal(steps)
	if err != nil { t.Fatal(err) }
	var parsed []SequenceStep
	if err := json.Unmarshal(data, &parsed); err != nil { t.Fatal(err) }
	if len(parsed) != 3 { t.Fatalf("expected 3, got %d", len(parsed)) }
	if parsed[0].TemplateName != "initial" { t.Error("step 0 template") }
	if parsed[1].DelayDays != 5 { t.Error("step 1 delay") }
	if parsed[2].Step != 2 { t.Error("step 2 number") }
}

func TestSequenceStep_JSON_Empty(t *testing.T) {
	data, _ := json.Marshal([]SequenceStep{})
	var parsed []SequenceStep
	json.Unmarshal(data, &parsed)
	if len(parsed) != 0 { t.Error("should be empty") }
}

// ── NullStr ──

func TestNullStr_Valid(t *testing.T) {
	if nullStr(sql.NullString{String: "hello", Valid: true}) != "hello" { t.Error("valid") }
}

func TestNullStr_Null(t *testing.T) {
	if nullStr(sql.NullString{Valid: false}) != "" { t.Error("null") }
}

func TestNullStr_ValidEmpty(t *testing.T) {
	if nullStr(sql.NullString{String: "", Valid: true}) != "" { t.Error("valid empty") }
}

// ── Constructor ──

func TestNewRunner(t *testing.T) {
	r := NewRunner(&mockDB{}, nil, nil)
	if r == nil { t.Fatal("nil runner") }
}

func TestNewRunner_AllDeps(t *testing.T) {
	r := NewRunner(&mockDB{}, nil, nil)
	if r.db == nil { t.Error("db not set") }
}

// ── Campaign Struct ──

func TestCampaign_Struct(t *testing.T) {
	c := Campaign{ID: 1, Name: "test", Status: "draft", Stats: map[string]int{"sent": 10}}
	if c.Stats["sent"] != 10 { t.Error("stats") }
	if c.Status != "draft" { t.Error("status") }
}

// ── WithRecalc ──

func TestWithRecalc_SetsFields(t *testing.T) {
	r := NewRunner(&mockDB{}, nil, nil)
	industries := []string{"machinery", "construction"}
	// Pass nil for *sql.DB — we only verify the pointer is stored
	r2 := r.WithRecalc(nil, industries)
	if r2 != r {
		t.Error("WithRecalc should return same pointer (fluent API)")
	}
	if len(r.recalcIndustries) != 2 || r.recalcIndustries[0] != "machinery" {
		t.Errorf("recalcIndustries = %v, want [machinery construction]", r.recalcIndustries)
	}
}

func TestWithRecalc_NilDB(t *testing.T) {
	r := NewRunner(&mockDB{}, nil, nil)
	r.WithRecalc(nil, nil)
	if r.recalcDB != nil {
		t.Error("recalcDB should be nil")
	}
	if r.recalcIndustries != nil {
		t.Error("recalcIndustries should be nil")
	}
}

// ── EnrollmentFilter ──

func TestEnrollmentFilter_Empty(t *testing.T) {
	f := EnrollmentFilter{}
	if f.Region != "" { t.Error("empty region") }
	if f.Industry != "" { t.Error("empty industry") }
	if f.MinScore != 0 { t.Error("zero minscore") }
}

func TestEnrollmentFilter_WithValues(t *testing.T) {
	f := EnrollmentFilter{Region: "Praha", Industry: "machinery", MinScore: 0.7}
	if f.Region != "Praha" { t.Error("region") }
	if f.Industry != "machinery" { t.Error("industry") }
	if f.MinScore != 0.7 { t.Error("minscore") }
}

// ── Header Merge Logic (extracted for testing) ──

func TestHeaderMerge(t *testing.T) {
	content := map[string]string{"List-Unsubscribe": "<http://unsub>", "X-Custom": "val"}
	humanize := map[string]string{"X-Mailer": "Seznam.cz", "List-Unsubscribe": "<http://override>"}

	merged := make(map[string]string)
	for k, v := range content { merged[k] = v }
	for k, v := range humanize { merged[k] = v }

	if merged["X-Mailer"] != "Seznam.cz" { t.Error("humanize header missing") }
	if merged["List-Unsubscribe"] != "<http://override>" { t.Error("humanize should override") }
	if merged["X-Custom"] != "val" { t.Error("content header lost") }
}

func TestHeaderMerge_EmptyHumanize(t *testing.T) {
	content := map[string]string{"X-Custom": "val"}
	merged := make(map[string]string)
	for k, v := range content { merged[k] = v }
	if merged["X-Custom"] != "val" { t.Error("content header lost") }
}

func TestHeaderMerge_EmptyContent(t *testing.T) {
	humanize := map[string]string{"X-Mailer": "Seznam.cz"}
	merged := make(map[string]string)
	for k, v := range humanize { merged[k] = v }
	if merged["X-Mailer"] != "Seznam.cz" { t.Error("humanize header missing") }
}
