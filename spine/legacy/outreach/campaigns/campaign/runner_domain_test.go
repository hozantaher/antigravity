package campaign

// S12 — Domain rotation gate tests.
//
// Tests cover:
//   - extractEmailDomain unit cases (plain, uppercase, malformed)
//   - MaxPerDomainPerTick constant value
//   - Runner integration via sqlmock: domain skip fires before Enqueue

import (
	"context"
	"encoding/json"
	"math/rand"
	"os"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── 1. extractEmailDomain unit tests ─────────────────────────────────────────

func TestDomain_ExtractEmailDomain_Simple(t *testing.T) {
	got := extractEmailDomain("user@example.com")
	if got != "example.com" {
		t.Errorf("extractEmailDomain = %q, want %q", got, "example.com")
	}
}

func TestDomain_ExtractEmailDomain_Uppercase(t *testing.T) {
	// Domain must be lowercased so EXAMPLE.COM and example.com are the same.
	got := extractEmailDomain("user@EXAMPLE.COM")
	if got != "example.com" {
		t.Errorf("extractEmailDomain uppercase = %q, want %q", got, "example.com")
	}
}

func TestDomain_ExtractEmailDomain_MixedCase(t *testing.T) {
	got := extractEmailDomain("jan@Firma.CZ")
	if got != "firma.cz" {
		t.Errorf("extractEmailDomain mixed case = %q, want %q", got, "firma.cz")
	}
}

func TestDomain_ExtractEmailDomain_NoAt(t *testing.T) {
	got := extractEmailDomain("invalid-email")
	if got != "" {
		t.Errorf("extractEmailDomain no-at = %q, want %q", got, "")
	}
}

func TestDomain_ExtractEmailDomain_EmptyString(t *testing.T) {
	got := extractEmailDomain("")
	if got != "" {
		t.Errorf("extractEmailDomain empty = %q, want %q", got, "")
	}
}

// ── 2. MaxPerDomainPerTick constant ───────────────────────────────────────────

func TestDomain_MaxPerDomainPerTick_IsTwo(t *testing.T) {
	if MaxPerDomainPerTick != 2 {
		t.Errorf("MaxPerDomainPerTick = %d, want 2", MaxPerDomainPerTick)
	}
}

// ── 3. Runner integration: domain gate via sqlmock ────────────────────────────
//
// Strategy: runner.engine = nil. If domain gate fires before Enqueue, no panic.
// If gate is missing, nil-engine dereference panics → test FAILS (RED).

// setupDomainCampaign wires a 1-step "running" campaign load + status UPDATE.
// Contacts at currentStep=0 will try to render+enqueue (gate must fire first).
func setupDomainCampaign(t *testing.T, mock sqlmock.Sqlmock) {
	t.Helper()
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Domain Test", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
}

// domainContactRows builds a contact rows result with n contacts all sharing
// the same email domain. All contacts have email_status="valid" so the only
// gate that can fire is the domain rotation gate.
func domainContactRows(domain string, n int) *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "current_step",
		"email", "first_name", "company_name", "region",
		"email_status", "parent_ico",
	})
	for i := 0; i < n; i++ {
		rows.AddRow(
			int64(i+1), int64(i+100), 99, // step 99 → past last step → mark completed
			"user"+string(rune('a'+i))+"@"+domain,
			"Name", "Company", "Praha",
			"valid", "",
		)
	}
	return rows
}

// TestDomain_ThreeSameDomain_MaxTwoEnqueued — 3 contacts on same domain → only
// 2 should be advanced (mark-completed), 3rd is skipped by domain gate.
//
// Contacts use currentStep=99 (past end of 1-step campaign) so the code path
// taken is: email gate passes → holding gate passes → domain gate (first 2
// pass, 3rd blocked) → step past end → UPDATE 'completed'.
// This avoids nil content/engine panics while still exercising the domain gate.
func TestDomain_ThreeSameDomain_MaxTwoEnqueued(t *testing.T) {
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	setupDomainCampaign(t, mock)

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(domainContactRows("firma.cz", 3))

	// Only contacts 1 and 2 pass the domain gate → 2 mark-completed UPDATEs.
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(2)).WillReturnResult(sqlmock.NewResult(0, 1))
	// Contact 3 is blocked — no UPDATE for it.

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("domain gate: %v", err)
	}
}

// TestDomain_TwoDifferentDomains_BothEnqueued — 2 contacts on different domains
// → both should be advanced (mark-completed).
func TestDomain_TwoDifferentDomains_BothEnqueued(t *testing.T) {
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	setupDomainCampaign(t, mock)

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step",
			"email", "first_name", "company_name", "region",
			"email_status", "parent_ico",
		}).
			AddRow(int64(1), int64(100), 99, "jan@alpha.cz", "Jan", "Alpha", "Praha", "valid", "").
			AddRow(int64(2), int64(101), 99, "petr@beta.cz", "Petr", "Beta", "Brno", "valid", ""))

	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(2)).WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("two-domain test: %v", err)
	}
}

// TestDomain_EmptyEmail_NoDomainTracked — a contact with an empty email must
// NOT be tracked in seenDomain (empty domain skips the counter) and must not
// crash. The email_status gate will normally block it first, but we verify
// explicitly: empty domain = "" → domain gate is a no-op → gate is safe.
func TestDomain_EmptyEmail_NoDomainTracked(t *testing.T) {
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	setupDomainCampaign(t, mock)

	// Contact with empty email_status → blocked by email-status gate first.
	// Domain gate must not see domain="" and panic.
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step",
			"email", "first_name", "company_name", "region",
			"email_status", "parent_ico",
		}).AddRow(int64(1), int64(100), 99, "", "Name", "Co", "Praha", "", ""))

	// No UPDATE expected — contact blocked before domain gate by email-status gate.
	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("empty email: %v", err)
	}
}

// TestDomain_FiveDifferentDomains_AllEnqueued — 5 contacts each on a unique
// domain (1 per domain). With MaxPerDomainPerTick=2, all 5 pass the gate.
func TestDomain_FiveDifferentDomains_AllEnqueued(t *testing.T) {
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	setupDomainCampaign(t, mock)

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "current_step",
		"email", "first_name", "company_name", "region",
		"email_status", "parent_ico",
	})
	for i := 0; i < 5; i++ {
		rows.AddRow(
			int64(i+1), int64(i+100), 99,
			"u@domain"+string(rune('a'+i))+".cz",
			"Name", "Co", "Praha", "valid", "",
		)
	}
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(rows)

	for i := 0; i < 5; i++ {
		mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
			WithArgs(int64(i + 1)).WillReturnResult(sqlmock.NewResult(0, 1))
	}

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("5 different domains: %v", err)
	}
}

// TestDomain_CapOne_OnlyOnePerDomain — simulate MaxPerDomainPerTick=1 logic
// by verifying that extractEmailDomain + counting respects the cap.
// This tests the pure counting logic (without the runner) using our helper.
func TestDomain_CapOne_OnlyOnePerDomain(t *testing.T) {
	const cap = 1
	contacts := []struct {
		email string
	}{
		{"a@same.cz"},
		{"b@same.cz"},
		{"c@other.cz"},
	}

	seen := map[string]int{}
	var passed []string
	for _, c := range contacts {
		d := extractEmailDomain(c.email)
		if d != "" && seen[d] >= cap {
			continue
		}
		if d != "" {
			seen[d]++
		}
		passed = append(passed, c.email)
	}

	// same.cz: only "a@same.cz" passes; other.cz: "c@other.cz" passes.
	if len(passed) != 2 {
		t.Errorf("cap=1: %d contacts passed, want 2: %v", len(passed), passed)
	}
	if passed[0] != "a@same.cz" {
		t.Errorf("first passed = %q, want a@same.cz", passed[0])
	}
	if passed[1] != "c@other.cz" {
		t.Errorf("second passed = %q, want c@other.cz", passed[1])
	}
}

// TestDomain_Extract_Table — table-driven domain extraction cases.
func TestDomain_Extract_Table(t *testing.T) {
	cases := []struct {
		email string
		want  string
	}{
		{"user@example.com", "example.com"},
		{"user@EXAMPLE.COM", "example.com"},
		{"user@Sub.Domain.CZ", "sub.domain.cz"},
		{"invalid-email", ""},
		{"", ""},
		{"@nodomain", "nodomain"},
		{"multiple@@at.com", "at.com"},
	}
	for _, tc := range cases {
		got := extractEmailDomain(tc.email)
		if got != tc.want {
			t.Errorf("extractEmailDomain(%q) = %q, want %q", tc.email, got, tc.want)
		}
	}
}

// TestDomain_Monkey_NeverPanics — property test: extractEmailDomain never
// panics on arbitrary input strings.
func TestDomain_Monkey_NeverPanics(t *testing.T) {
	f := func(s string) bool {
		defer func() { recover() }()
		extractEmailDomain(s)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 5000}); err != nil {
		t.Errorf("extractEmailDomain panicked: %v", err)
	}
}

// TestDomain_Monkey_RandomEmails_NoPanic — generate random "email-like"
// strings and confirm extractEmailDomain never crashes.
func TestDomain_Monkey_RandomEmails_NoPanic(t *testing.T) {
	chars := []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@.-_+")
	for i := 0; i < 2000; i++ {
		n := rand.Intn(50)
		s := make([]rune, n)
		for j := range s {
			s[j] = chars[rand.Intn(len(chars))]
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on %q: %v", string(s), r)
				}
			}()
			extractEmailDomain(string(s))
		}()
	}
}

// TestDomain_FourSameDomain_OnlyTwoProceed_Integration — integration test
// via sqlmock: 4 contacts all on the same domain → exactly 2 advance
// (mark-completed), 2 are skipped by domain rotation gate.
func TestDomain_FourSameDomain_OnlyTwoProceed_Integration(t *testing.T) {
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	setupDomainCampaign(t, mock)

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(domainContactRows("bigcorp.cz", 4))

	// Contacts 1 and 2 pass the domain gate (seenDomain["bigcorp.cz"] goes 0→1→2).
	// Contacts 3 and 4 are blocked (seenDomain["bigcorp.cz"]=2 >= MaxPerDomainPerTick=2).
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed' WHERE id`).
		WithArgs(int64(2)).WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("4-contact domain gate: %v", err)
	}
}
