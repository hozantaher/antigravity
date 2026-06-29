package campaign

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// TestRunCampaign_SuppressionFilter_AppliedAtSend verifies the runner's
// last-line compliance gate: even if a contact's Schema A `contacts.status`
// remains 'valid' (because SuppressEmail only updates Schema B
// outreach_contacts.status), the email must be excluded by the
// `outreach_suppressions` NOT IN filter in the SELECT.
//
// Background: SuppressEmail in services/contacts/enrichment/suppress.go
// inserts into outreach_suppressions and updates outreach_contacts (Schema
// B), but does NOT touch the Schema A contacts table. Without this gate
// the next RunCampaign tick would re-send to a suppressed address.
//
// Discipline: this test asserts the SELECT contains the suppression filter
// substring. If you refactor the query, update the assertion — but the
// filter MUST remain.
func TestRunCampaign_SuppressionFilter_AppliedAtSend(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "t0"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Camp", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// The SELECT must include the suppression filter. We use a regex matcher
	// (set above) and assert via WithArgs / shape; sqlmock will only call
	// this expectation if the query matches our regex.
	mock.ExpectQuery(`outreach_suppressions`).
		WillReturnRows(sqlmock.NewRows(contactCols))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign: %v", err)
	}
}

// TestRunCampaign_SuppressionFilter_QueryStringContainsCheck is a redundant
// guard. It compiles the runner.go file and uses a known-shape assertion that
// the suppression filter appears verbatim in the SELECT. If a refactor
// removes the filter, this test catches it without needing DB.
func TestRunCampaign_SuppressionFilter_QueryStringContainsCheck(t *testing.T) {
	// Read the current runner.go and confirm the suppression filter clause
	// is part of the RunCampaign SELECT. This is a discipline test — it
	// keeps the filter in place against accidental removal during refactor.
	data, err := os.ReadFile("runner.go")
	if err != nil {
		t.Skipf("cannot read runner.go: %v", err)
	}
	src := string(data)
	if !strings.Contains(src, "outreach_suppressions") {
		t.Fatalf("runner.go no longer references outreach_suppressions — compliance gate REMOVED")
	}
	// Less strict but still useful: confirm the filter is in the right
	// spot (RunCampaign function, after `c.status NOT IN`).
	idx := strings.Index(src, "func (r *Runner) RunCampaign")
	if idx < 0 {
		t.Fatal("RunCampaign function not found")
	}
	end := strings.Index(src[idx:], "\nfunc ")
	if end < 0 {
		end = len(src) - idx
	}
	body := src[idx : idx+end]
	// RunCampaign body must reference the suppression filter helper. The
	// helper itself lives at the top of runner.go and unions both
	// suppression tables — see TestSuppressionFilterSQL_UnionsBothTables.
	if !strings.Contains(body, "suppressionFilterFor") {
		t.Errorf("RunCampaign body missing suppressionFilterFor() — compliance regression")
	}
}

// TestSuppressionFilterSQL_UnionsBothTables locks the canonical filter to
// reference BOTH suppression tables (outreach_suppressions written by Go,
// suppression_list written by JS/BFF). Removing either side would silently
// leak suppressed addresses through the send tick — see suppressionFilterSQL
// godoc for full background.
func TestSuppressionFilterSQL_UnionsBothTables(t *testing.T) {
	got := suppressionFilterFor("c.email")

	if !strings.Contains(got, "outreach_suppressions") {
		t.Errorf("suppression filter no longer unions outreach_suppressions — Go-side suppressions leaked\nfilter: %s", got)
	}
	if !strings.Contains(got, "suppression_list") {
		t.Errorf("suppression filter no longer unions suppression_list — UI-added suppressions leaked\nfilter: %s", got)
	}
	if !strings.Contains(got, "UNION") {
		t.Errorf("suppression filter missing UNION between tables\nfilter: %s", got)
	}
	// Both sides must normalize (lower+trim) so case/whitespace drift
	// between writers cannot leak through.
	if !strings.Contains(got, "lower(trim(c.email))") {
		t.Errorf("suppression filter LHS not normalized\nfilter: %s", got)
	}
	if strings.Count(got, "lower(trim(email))") < 2 {
		t.Errorf("suppression filter RHS not normalized on both UNION sides\nfilter: %s", got)
	}
}

// TestSuppressionFilterFor_PlaceholderReplaced verifies the helper rewrites
// the {col} placeholder. Catches a typo refactor where the placeholder
// would leak into emitted SQL.
func TestSuppressionFilterFor_PlaceholderReplaced(t *testing.T) {
	for _, col := range []string{"c.email", "lower(c.email)", "x.email"} {
		got := suppressionFilterFor(col)
		if strings.Contains(got, "{col}") {
			t.Errorf("placeholder leaked for col=%q: %s", col, got)
		}
		if !strings.Contains(got, col) {
			t.Errorf("column %q not present in result: %s", col, got)
		}
	}
}
