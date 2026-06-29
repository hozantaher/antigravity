package prospect

import (
	"database/sql"
	"testing"
)

func sqlNullStr(s string, valid bool) sql.NullString {
	return sql.NullString{String: s, Valid: valid}
}

func TestBuildCountQuery_NoFilters(t *testing.T) {
	filter := FirmyFilter{}
	query, args := buildCountQuery(filter)

	if query != "SELECT COUNT(*) FROM firmy_cz_businesses WHERE 1=1" {
		t.Errorf("unexpected query: %s", query)
	}
	if len(args) != 0 {
		t.Errorf("expected 0 args, got %d", len(args))
	}
}

func TestBuildCountQuery_WithEmailFilter(t *testing.T) {
	filter := FirmyFilter{HasEmail: true}
	query, args := buildCountQuery(filter)

	expected := "SELECT COUNT(*) FROM firmy_cz_businesses WHERE 1=1 AND email IS NOT NULL"
	if query != expected {
		t.Errorf("expected:\n  %s\ngot:\n  %s", expected, query)
	}
	if len(args) != 0 {
		t.Errorf("expected 0 args, got %d", len(args))
	}
}

func TestBuildCountQuery_WithRegion(t *testing.T) {
	filter := FirmyFilter{Region: "Praha", HasEmail: true}
	query, args := buildCountQuery(filter)

	if len(args) != 1 {
		t.Fatalf("expected 1 arg, got %d", len(args))
	}
	if args[0] != "%Praha%" {
		t.Errorf("expected %%Praha%%, got %v", args[0])
	}
	if query != "SELECT COUNT(*) FROM firmy_cz_businesses WHERE 1=1 AND email IS NOT NULL AND address_locality ILIKE $1" {
		t.Errorf("unexpected query: %s", query)
	}
}

func TestBuildQuery_WithLimit(t *testing.T) {
	filter := FirmyFilter{HasEmail: true, HasICO: true, Limit: 500}
	query, args := buildQuery("SELECT *", filter)

	if len(args) != 1 {
		t.Fatalf("expected 1 arg (limit), got %d", len(args))
	}
	if args[0] != 500 {
		t.Errorf("expected limit 500, got %v", args[0])
	}
	if query != "SELECT * FROM firmy_cz_businesses WHERE 1=1 AND email IS NOT NULL AND ico IS NOT NULL ORDER BY id LIMIT $1" {
		t.Errorf("unexpected query: %s", query)
	}
}

func TestBuildQuery_DefaultLimit(t *testing.T) {
	filter := FirmyFilter{}
	_, args := buildQuery("SELECT *", filter)

	if len(args) != 1 {
		t.Fatalf("expected 1 arg (default limit), got %d", len(args))
	}
	if args[0] != 1000 {
		t.Errorf("expected default limit 1000, got %v", args[0])
	}
}

func TestBuildQuery_WithOffset(t *testing.T) {
	filter := FirmyFilter{Limit: 100, Offset: 200}
	query, args := buildQuery("SELECT *", filter)

	if len(args) != 2 {
		t.Fatalf("expected 2 args (limit, offset), got %d", len(args))
	}
	if args[0] != 100 {
		t.Errorf("expected limit 100, got %v", args[0])
	}
	if args[1] != 200 {
		t.Errorf("expected offset 200, got %v", args[1])
	}
	if query != "SELECT * FROM firmy_cz_businesses WHERE 1=1 ORDER BY id LIMIT $1 OFFSET $2" {
		t.Errorf("unexpected query: %s", query)
	}
}

func TestBuildQuery_AllFilters(t *testing.T) {
	filter := FirmyFilter{
		Region:      "Brno",
		HasEmail:    true,
		HasPhone:    true,
		HasICO:      true,
		Description: "stroje",
		Categories:  "výroba",
		MinRating:   3.5,
		Limit:       50,
	}
	query, args := buildQuery("SELECT *", filter)

	// 4 parameterized args: region, description, categories, rating + limit
	if len(args) != 5 {
		t.Fatalf("expected 5 args, got %d: %v", len(args), args)
	}
	if args[0] != "%Brno%" {
		t.Errorf("arg[0] region: expected %%Brno%%, got %v", args[0])
	}
	if args[1] != "%stroje%" {
		t.Errorf("arg[1] description: expected %%stroje%%, got %v", args[1])
	}
	if args[2] != "%výroba%" {
		t.Errorf("arg[2] categories: expected %%výroba%%, got %v", args[2])
	}
	if args[3] != 3.5 {
		t.Errorf("arg[3] rating: expected 3.5, got %v", args[3])
	}
	if args[4] != 50 {
		t.Errorf("arg[4] limit: expected 50, got %v", args[4])
	}

	// Check all conditions present
	for _, cond := range []string{
		"email IS NOT NULL",
		"telephone IS NOT NULL",
		"ico IS NOT NULL",
		"address_locality ILIKE",
		"description ILIKE",
		"category_path ILIKE",
		"rating_value >=",
		"ORDER BY id",
		"LIMIT",
	} {
		if !containsStr(query, cond) {
			t.Errorf("missing condition: %s\nquery: %s", cond, query)
		}
	}
}

func TestBuildConditions_BooleanOnly(t *testing.T) {
	filter := FirmyFilter{HasEmail: true, HasPhone: true, HasICO: true}
	conditions, args := buildConditions(filter)

	if len(args) != 0 {
		t.Errorf("boolean filters should produce 0 parameterized args, got %d", len(args))
	}
	if len(conditions) != 3 {
		t.Errorf("expected 3 conditions, got %d", len(conditions))
	}
}

func TestBuildConditions_AfterID(t *testing.T) {
	filter := FirmyFilter{AfterID: 1000}
	conditions, args := buildConditions(filter)
	if len(conditions) != 1 {
		t.Errorf("expected 1 condition for AfterID, got %d", len(conditions))
	}
	if len(args) != 1 || args[0] != 1000 {
		t.Errorf("expected AfterID arg 1000, got %v", args)
	}
}

func TestMaxID_Empty(t *testing.T) {
	if MaxID(nil) != 0 { t.Error("MaxID nil should be 0") }
	if MaxID([]FirmyBusiness{}) != 0 { t.Error("MaxID empty should be 0") }
}

func TestMaxID_NonEmpty(t *testing.T) {
	bs := []FirmyBusiness{{ID: 5}, {ID: 12}, {ID: 3}}
	if MaxID(bs) != 12 { t.Errorf("MaxID: got %d, want 12", MaxID(bs)) }
}

func TestExtractFirstName_WithTitle(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"Ing. Jan Novák - poradenství", "Jan"},
		{"Mgr. Marie Dvořáková", "Marie"},
		{"BIONA s.r.o.", ""},
		{"TEMA Klášterec", ""},
		{"Jan Novák", "Jan"},
		{"", ""},
		{"X", ""},
	}

	for _, tt := range tests {
		result := extractFirstName(tt.input)
		if result != tt.expected {
			t.Errorf("extractFirstName(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestNullStr_Valid(t *testing.T) {
	ns := sqlNullStr("hello", true)
	if nullStr(ns) != "hello" { t.Error("valid") }
}

func TestNullStr_Null(t *testing.T) {
	ns := sqlNullStr("", false)
	if nullStr(ns) != "" { t.Error("null") }
}

func TestNullStr_ValidEmpty(t *testing.T) {
	ns := sqlNullStr("", true)
	if nullStr(ns) != "" { t.Error("valid empty") }
}

func TestFirmyFilter_Defaults(t *testing.T) {
	f := FirmyFilter{}
	if f.HasEmail || f.HasPhone || f.HasICO { t.Error("defaults should be false") }
	if f.Region != "" || f.Description != "" { t.Error("strings should be empty") }
	if f.Limit != 0 || f.Offset != 0 { t.Error("ints should be zero") }
}

func TestFirmyBusiness_Struct(t *testing.T) {
	b := FirmyBusiness{
		Name: "Firma s.r.o.", Email: "info@firma.cz", ICO: "12345678",
		Region: "Praha", RatingValue: 4.5, RatingCount: 10,
	}
	if b.Name != "Firma s.r.o." { t.Error("name") }
	if b.RatingValue != 4.5 { t.Error("rating") }
}

func TestExtractFirstName_MoreCases(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		// Czech academic/professional titles before first name
		{"doc. Petr Švarc", "Petr"},
		{"prof. Anna Horáková", "Anna"},
		{"bc. Filip Malý", "Filip"},
		{"JUDr. Petra Soudní", "Petra"},
		{"PhDr. Ivan Test", "Ivan"},
		// Single-word or all-caps company names → no first name
		{"ACME STROJÍRNA S.R.O.", ""},
		{"", ""},
	}
	for _, tt := range tests {
		got := extractFirstName(tt.in)
		if got != tt.want {
			t.Errorf("extractFirstName(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && searchInStr(s, sub)
}

func searchInStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
