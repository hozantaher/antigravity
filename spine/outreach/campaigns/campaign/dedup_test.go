package campaign

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── A5: Identical email hash — enrollment dedup ───────────────────────────
//
// When the same email address (same email_hash) appears more than once in
// the contacts table, the UNIQUE constraint + ON CONFLICT DO NOTHING in
// enrollContacts means the second enrollment is silently dropped.
//
// Tests here verify that CreateCampaign tolerates the conflict correctly
// and reports the enrolled count as the deduplicated total.

func TestEnroll_DuplicateEmailHash_OnConflictIgnored(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// RowsAffected = 2, not 3, because one email_hash was duplicate
	mock.ExpectExec(`INSERT INTO campaign_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 2))

	r := NewRunner(db, nil, nil)
	id, err := r.CreateCampaign(context.Background(), "Test", "", []SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
	}, EnrollmentFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 1 {
		t.Errorf("campaign id = %d, want 1", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// ── A5: DomainCap — max N contacts per email domain per campaign ──────────

func TestDomainCap_DefaultCap_IsThree(t *testing.T) {
	// The default cap must be 3 (configurable later, but the constant must exist).
	if DefaultDomainCap != 3 {
		t.Errorf("DefaultDomainCap = %d, want 3", DefaultDomainCap)
	}
}

func TestDomainCap_ApplyDomainCap_KeepsAtMostN(t *testing.T) {
	// Given 5 contacts all @samecompany.cz with cap=3 → 3 should remain.
	contacts := makeDomainContacts("samecompany.cz", 5)
	got := ApplyDomainCap(contacts, 3)
	if len(got) != 3 {
		t.Errorf("ApplyDomainCap cap=3: len=%d, want 3", len(got))
	}
}

func TestDomainCap_ApplyDomainCap_BelowCap_Unchanged(t *testing.T) {
	contacts := makeDomainContacts("small.com", 2)
	got := ApplyDomainCap(contacts, 5)
	if len(got) != 2 {
		t.Errorf("ApplyDomainCap below cap: len=%d, want 2", len(got))
	}
}

func TestDomainCap_ApplyDomainCap_MultipleDomains_CappedPerDomain(t *testing.T) {
	contacts := append(
		makeDomainContacts("a.cz", 5),
		makeDomainContacts("b.cz", 4)...,
	)
	got := ApplyDomainCap(contacts, 3)
	// 3 from a.cz + 3 from b.cz = 6
	if len(got) != 6 {
		t.Errorf("multi-domain cap: len=%d, want 6", len(got))
	}
}

func TestDomainCap_ApplyDomainCap_ZeroCap_Empty(t *testing.T) {
	contacts := makeDomainContacts("x.cz", 5)
	got := ApplyDomainCap(contacts, 0)
	if len(got) != 0 {
		t.Errorf("cap=0: len=%d, want 0", len(got))
	}
}

func TestDomainCap_ApplyDomainCap_ExactlyCap(t *testing.T) {
	contacts := makeDomainContacts("exact.cz", 3)
	got := ApplyDomainCap(contacts, 3)
	if len(got) != 3 {
		t.Errorf("exactly cap: len=%d, want 3", len(got))
	}
}

func TestDomainCap_ExtractDomain(t *testing.T) {
	cases := []struct {
		email string
		want  string
	}{
		{"jan@firma.cz", "firma.cz"},
		{"info@sub.example.com", "sub.example.com"},
		{"no-at-sign", ""},
		{"", ""},
		{"@nodomain", "nodomain"},
	}
	for _, tc := range cases {
		got := extractEmailDomain(tc.email)
		if got != tc.want {
			t.Errorf("extractEmailDomain(%q) = %q, want %q", tc.email, got, tc.want)
		}
	}
}

// ── A5: Property — domain cap never exceeds N per domain ─────────────────

func TestDomainCap_Property_NeverExceedsCapPerDomain(t *testing.T) {
	f := func(n uint8) bool {
		if n == 0 {
			return true
		}
		cap := int(n%10) + 1 // cap in [1..10]
		contacts := append(
			makeDomainContacts("flood.cz", 50),
			makeDomainContacts("other.com", 20)...,
		)
		got := ApplyDomainCap(contacts, cap)
		// Group by domain and verify count
		byDomain := map[string]int{}
		for _, c := range got {
			d := extractEmailDomain(c.Email)
			byDomain[d]++
		}
		for domain, count := range byDomain {
			if count > cap {
				_ = domain
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("domain cap property: %v", err)
	}
}

// ── A5: Holding cluster — max 1 send per parent_ico per tick ─────────────

func TestHoldingCluster_DefaultExists(t *testing.T) {
	// HoldingClusterCap must be 1 (one contact per holding per tick).
	if HoldingClusterCap != 1 {
		t.Errorf("HoldingClusterCap = %d, want 1", HoldingClusterCap)
	}
}

func TestHoldingCluster_ApplyHoldingCluster_OnlyOne(t *testing.T) {
	// 3 contacts share parent_ico "PARENT123" → only 1 should pass.
	contacts := []dedupContact{
		{ContactID: 1, Email: "a@a.cz", ParentICO: "PARENT123"},
		{ContactID: 2, Email: "b@b.cz", ParentICO: "PARENT123"},
		{ContactID: 3, Email: "c@c.cz", ParentICO: "PARENT123"},
	}
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 1 {
		t.Errorf("holding cluster cap=1: len=%d, want 1", len(got))
	}
}

func TestHoldingCluster_ApplyHoldingCluster_DifferentParents(t *testing.T) {
	// 2 contacts from different parents → both pass.
	contacts := []dedupContact{
		{ContactID: 1, Email: "a@a.cz", ParentICO: "HOLDINGA"},
		{ContactID: 2, Email: "b@b.cz", ParentICO: "HOLDINGB"},
	}
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 2 {
		t.Errorf("different parents: len=%d, want 2", len(got))
	}
}

func TestHoldingCluster_ApplyHoldingCluster_EmptyParentICO_PassesThrough(t *testing.T) {
	// Contacts with empty parent_ico are not in a holding → no cap.
	contacts := []dedupContact{
		{ContactID: 1, Email: "a@a.cz", ParentICO: ""},
		{ContactID: 2, Email: "b@b.cz", ParentICO: ""},
		{ContactID: 3, Email: "c@c.cz", ParentICO: ""},
	}
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 3 {
		t.Errorf("empty parent_ico: len=%d, want 3", len(got))
	}
}

func TestHoldingCluster_ApplyHoldingCluster_MixedParents(t *testing.T) {
	// 3 holding + 3 standalone → 1 holding + 3 standalone = 4.
	contacts := []dedupContact{
		{ContactID: 1, Email: "a@a.cz", ParentICO: "HOLD"},
		{ContactID: 2, Email: "b@b.cz", ParentICO: "HOLD"},
		{ContactID: 3, Email: "c@c.cz", ParentICO: "HOLD"},
		{ContactID: 4, Email: "d@d.cz", ParentICO: ""},
		{ContactID: 5, Email: "e@e.cz", ParentICO: ""},
		{ContactID: 6, Email: "f@f.cz", ParentICO: ""},
	}
	got := ApplyHoldingCluster(contacts, 1)
	if len(got) != 4 {
		t.Errorf("mixed: len=%d, want 4", len(got))
	}
}

// ── A5: Runner respects holding cluster per tick ──────────────────────────

func TestRunCampaign_HoldingCluster_SkipsExtra(t *testing.T) {
	// Two contacts share parent_ico — only the first must be advanced.
	// We use currentStep=1 with a 1-step campaign so the runner takes
	// the "past last step → mark completed" branch instead of Render.
	// This avoids nil engine/content panics while still verifying the
	// holding cluster gate: only 1 UPDATE to 'completed' must happen.
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")
	os.Setenv("SKIP_CALENDAR_CHECK", "1")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1-step campaign; contacts at currentStep=1 → past last step
	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Dedup", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Two contacts, same parent_ico=PARENT1, both valid, both past last step
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step",
			"email", "first_name", "company_name", "region",
			"email_status", "parent_ico",
		}).
			AddRow(1, 10, 1, "a@a.cz", "Jan", "Sub A", "Praha", "valid", "PARENT1").
			AddRow(2, 11, 1, "b@b.cz", "Petr", "Sub B", "Brno", "valid", "PARENT1"))

	// Only 1 step-advance/completed UPDATE expected (contact 10 passes, 11 blocked)
	mock.ExpectExec(`UPDATE campaign_contacts SET status = 'completed'`).
		WithArgs(int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("holding cluster blocked wrong number of contacts: %v", err)
	}
}

// ── A5: Migration 045 — contacts.parent_ico column ───────────────────────

func TestMigration045_ParentICO_ColumnInQuery(t *testing.T) {
	// The runner's contact SELECT must include parent_ico from the
	// companies join (or contacts table directly).
	// Test: sqlmock verifies the query contains "parent_ico".
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")
	os.Setenv("SKIP_CALENDAR_CHECK", "1")

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("DC", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Query must reference parent_ico
	mock.ExpectQuery(`parent_ico`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step",
			"email", "first_name", "company_name", "region",
			"email_status", "parent_ico",
		}))

	r := NewRunner(db, nil, nil)
	_ = r.RunCampaign(context.Background(), 1)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("runner query missing parent_ico column: %v", err)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

func makeDomainContacts(domain string, n int) []dedupContact {
	out := make([]dedupContact, n)
	for i := range out {
		out[i] = dedupContact{
			ContactID: int64(i + 1),
			Email:     strings.Repeat("u", i+1) + "@" + domain,
		}
	}
	return out
}
