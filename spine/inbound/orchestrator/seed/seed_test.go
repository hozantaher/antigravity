package seed

// seed_test.go — unit + property tests for the top-level seed package.
//
// Strategy:
//   - Pure data helpers (testData, uniqueDomains, firmyCompanies, emailHash,
//     FormatResult) are tested without a database.
//   - SeedAll / ClearAll are exercised via go-sqlmock to cover error paths and
//     the idempotency check without requiring a real Postgres instance.

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─── testData ────────────────────────────────────────────────────────────────

// TestTestData_Length verifies the fixture returns the documented 60 contacts.
func TestTestData_Length(t *testing.T) {
	data := testData()
	if len(data) != 60 {
		t.Fatalf("expected 60 test contacts, got %d", len(data))
	}
}

// TestTestData_NoPanic verifies testData never panics (monkey: call it twice
// and assert stable length).
func TestTestData_NoPanic(t *testing.T) {
	a := testData()
	b := testData()
	if len(a) != len(b) {
		t.Fatalf("testData is not deterministic: %d vs %d", len(a), len(b))
	}
}

// TestTestData_AllDomainsAreDotTest confirms the .test TLD invariant —
// every email must end in a .test domain so the engine never accidentally
// sends to real infrastructure.
func TestTestData_AllDomainsAreDotTest(t *testing.T) {
	for _, c := range testData() {
		if !strings.HasSuffix(c.domain, ".test") {
			t.Errorf("domain %q does not use .test TLD (RFC 6761)", c.domain)
		}
	}
}

// TestTestData_AllEmailsContainAt verifies every email field looks like an
// email address (has exactly one '@' that splits a non-empty local + domain).
func TestTestData_AllEmailsContainAt(t *testing.T) {
	for _, c := range testData() {
		parts := strings.SplitN(c.email, "@", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			t.Errorf("malformed email %q", c.email)
		}
	}
}

// TestTestData_AllRequiredFieldsNonEmpty checks that none of the mandatory
// fields are empty strings.
func TestTestData_AllRequiredFieldsNonEmpty(t *testing.T) {
	for i, c := range testData() {
		if c.domain == "" { t.Errorf("row %d: empty domain", i) }
		if c.firstName == "" { t.Errorf("row %d: empty firstName", i) }
		if c.lastName == "" { t.Errorf("row %d: empty lastName", i) }
		if c.email == "" { t.Errorf("row %d: empty email", i) }
		if c.companyName == "" { t.Errorf("row %d: empty companyName", i) }
		if c.ico == "" { t.Errorf("row %d: empty ico", i) }
		if c.region == "" { t.Errorf("row %d: empty region", i) }
		if c.industry == "" { t.Errorf("row %d: empty industry", i) }
		if c.companySize == "" { t.Errorf("row %d: empty companySize", i) }
	}
}

// TestTestData_EmailsAreUnique verifies no duplicate email addresses.
func TestTestData_EmailsAreUnique(t *testing.T) {
	seen := make(map[string]bool)
	for _, c := range testData() {
		if seen[c.email] {
			t.Errorf("duplicate email: %s", c.email)
		}
		seen[c.email] = true
	}
}

// ─── uniqueDomains ───────────────────────────────────────────────────────────

// TestUniqueDomains_Length verifies the documented 20 distinct domains.
func TestUniqueDomains_Length(t *testing.T) {
	domains := uniqueDomains()
	if len(domains) != 20 {
		t.Fatalf("expected 20 unique domains, got %d", len(domains))
	}
}

// TestUniqueDomains_NoDuplicates verifies the output contains no duplicate entries.
func TestUniqueDomains_NoDuplicates(t *testing.T) {
	domains := uniqueDomains()
	seen := make(map[string]bool)
	for _, d := range domains {
		if seen[d] {
			t.Errorf("duplicate domain: %s", d)
		}
		seen[d] = true
	}
}

// TestUniqueDomains_AllDotTest confirms the .test TLD invariant on the
// domain list as well.
func TestUniqueDomains_AllDotTest(t *testing.T) {
	for _, d := range uniqueDomains() {
		if !strings.HasSuffix(d, ".test") {
			t.Errorf("domain %q not a .test TLD", d)
		}
	}
}

// ─── firmyCompanies ──────────────────────────────────────────────────────────

// TestFirmyCompanies_Length verifies the documented 20 entries.
func TestFirmyCompanies_Length(t *testing.T) {
	fc := firmyCompanies()
	if len(fc) != 20 {
		t.Fatalf("expected 20 firmy companies, got %d", len(fc))
	}
}

// TestFirmyCompanies_AllEmailsDotTest confirms every firmy email uses .test.
func TestFirmyCompanies_AllEmailsDotTest(t *testing.T) {
	for _, c := range firmyCompanies() {
		if !strings.HasSuffix(c.email, ".test") {
			t.Errorf("firmyCompany email %q not .test", c.email)
		}
	}
}

// TestFirmyCompanies_AllFieldsNonEmpty checks mandatory fields.
func TestFirmyCompanies_AllFieldsNonEmpty(t *testing.T) {
	for i, c := range firmyCompanies() {
		if c.name == "" { t.Errorf("row %d: empty name", i) }
		if c.email == "" { t.Errorf("row %d: empty email", i) }
		if c.ico == "" { t.Errorf("row %d: empty ico", i) }
		if c.region == "" { t.Errorf("row %d: empty region", i) }
		if c.size == "" { t.Errorf("row %d: empty size", i) }
		if c.category == "" { t.Errorf("row %d: empty category", i) }
	}
}

// ─── emailHash ───────────────────────────────────────────────────────────────

// TestEmailHash_Length confirms the hash is always a 16-char hex string.
func TestEmailHash_Length(t *testing.T) {
	for _, email := range []string{"jan@firma.cz", "TEST@EXAMPLE.COM", "", "x"} {
		h := emailHash(email)
		if len(h) != 16 {
			t.Errorf("emailHash(%q) length = %d, want 16", email, len(h))
		}
	}
}

// TestEmailHash_CaseInsensitive verifies that the hash normalises case so
// "Jan@Firma.CZ" and "jan@firma.cz" produce the same hash.
func TestEmailHash_CaseInsensitive(t *testing.T) {
	if emailHash("Jan@Firma.CZ") != emailHash("jan@firma.cz") {
		t.Error("emailHash should be case-insensitive")
	}
}

// TestEmailHash_Deterministic verifies the same input always produces the same output.
func TestEmailHash_Deterministic(t *testing.T) {
	for i := 0; i < 20; i++ {
		if emailHash("robot@sandbox.test") != emailHash("robot@sandbox.test") {
			t.Fatal("emailHash is not deterministic")
		}
	}
}

// TestEmailHash_Distinct verifies different emails produce different hashes
// (collision resistance check on our fixture set).
func TestEmailHash_Distinct(t *testing.T) {
	seen := make(map[string]string)
	for _, c := range testData() {
		h := emailHash(c.email)
		if prev, ok := seen[h]; ok {
			t.Errorf("hash collision: %q and %q both hash to %q", prev, c.email, h)
		}
		seen[h] = c.email
	}
}

// TestProperty_EmailHash_NoPanic runs quick.Check to confirm no panic on
// arbitrary input (includes empty strings, unicode, etc.).
func TestProperty_EmailHash_NoPanic(t *testing.T) {
	f := func(s string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on emailHash(%q): %v", s, r)
			}
		}()
		_ = emailHash(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ─── FormatResult ────────────────────────────────────────────────────────────

// TestFormatResult_ContainsExpectedSections verifies the human-readable output
// includes all documented sections.
func TestFormatResult_ContainsExpectedSections(t *testing.T) {
	r := &SeedResult{
		ContactsSchemaA: 60,
		ContactsSchemaB: 60,
		Domains:         20,
		FirmyCompanies:  20,
		CampaignID:      42,
		CampaignName:    "E2E Test Campaign",
		Enrolled:        60,
	}
	out := FormatResult(r)
	for _, needle := range []string{
		"E2E Test Data Seeded",
		"60",
		"20",
		"E2E Test Campaign",
		"Next Steps",
		"Environment",
	} {
		if !strings.Contains(out, needle) {
			t.Errorf("FormatResult output missing %q", needle)
		}
	}
}

// TestFormatResult_ZeroFirmySkipped verifies the "skipped" branch is taken
// when FirmyCompanies is 0.
func TestFormatResult_ZeroFirmySkipped(t *testing.T) {
	r := &SeedResult{CampaignName: "Test", CampaignID: 1}
	out := FormatResult(r)
	if !strings.Contains(out, "skipped") {
		t.Errorf("expected 'skipped' in output for zero firmy companies, got:\n%s", out)
	}
}

// TestFormatResult_NonZeroFirmyNotSkipped verifies the skipped branch is NOT
// taken when FirmyCompanies > 0.
func TestFormatResult_NonZeroFirmyNotSkipped(t *testing.T) {
	r := &SeedResult{FirmyCompanies: 5, CampaignName: "T", CampaignID: 1}
	out := FormatResult(r)
	if strings.Contains(out, "skipped") {
		t.Error("expected no 'skipped' line when FirmyCompanies > 0")
	}
}

// TestFormatResult_NoPanic exercises FormatResult with zero-value struct.
func TestFormatResult_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("FormatResult panicked on zero-value SeedResult: %v", r)
		}
	}()
	_ = FormatResult(&SeedResult{})
}

// TestFormatResult_CampaignRunCommandPresent verifies the output contains the
// campaign-run CLI command with the actual campaign ID.
func TestFormatResult_CampaignRunCommandPresent(t *testing.T) {
	r := &SeedResult{CampaignID: 99, CampaignName: "X"}
	out := FormatResult(r)
	if !strings.Contains(out, "99") {
		t.Errorf("FormatResult should include campaign ID 99 in CLI command, got:\n%s", out)
	}
}

// ─── SeedAll: idempotency check (mock DB already-seeded path) ────────────────

// TestSeedAll_AlreadySeeded_ReturnsEmptyResult verifies that SeedAll returns
// an empty (zero-value) SeedResult and nil error when the existing row count
// is > 0 (idempotency guard path).
func TestSeedAll_AlreadySeeded_ReturnsEmptyResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// The idempotency check queries COUNT(*) — return 1 to simulate already-seeded.
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM contacts WHERE source`).
		WithArgs(sourceTag).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	result, err := SeedAll(context.Background(), db, nil)
	if err != nil {
		t.Fatalf("SeedAll idempotency path returned error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil SeedResult")
	}
	// All counters must be zero — nothing was written.
	if result.ContactsSchemaA != 0 || result.ContactsSchemaB != 0 ||
		result.Domains != 0 || result.CampaignID != 0 {
		t.Errorf("idempotency path should return zeroed result, got: %+v", result)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet mock expectations: %v", err)
	}
}

// TestSeedAll_DBError_CheckExisting verifies that a DB error on the initial
// COUNT query is propagated as a non-nil error.
func TestSeedAll_DBError_CheckExisting(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM contacts WHERE source`).
		WithArgs(sourceTag).
		WillReturnError(fmt.Errorf("db connection lost"))

	_, err = SeedAll(context.Background(), db, nil)
	if err == nil {
		t.Fatal("expected error when DB returns error on COUNT query")
	}
	if !strings.Contains(err.Error(), "check existing seed") {
		t.Errorf("unexpected error message: %v", err)
	}
}

// ─── ClearAll: mock DB error propagation ─────────────────────────────────────

// TestClearAll_DBError_FirstQuery verifies that a DB error on the first DELETE
// is propagated as a non-nil error from ClearAll.
func TestClearAll_DBError_FirstQuery(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// ClearAll executes a sequence of DELETE statements; the first one fails.
	mock.ExpectExec("DELETE FROM send_events").
		WillReturnError(fmt.Errorf("permission denied"))

	err = ClearAll(context.Background(), db, nil)
	if err == nil {
		t.Fatal("expected error when first DELETE fails")
	}
	if !strings.Contains(err.Error(), "clear send_events") {
		t.Errorf("unexpected error message: %v", err)
	}
}
