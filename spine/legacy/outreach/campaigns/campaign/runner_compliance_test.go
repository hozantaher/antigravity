package campaign

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// Compliance regression tests for the per-tick send-loop exclusion
// filter at runner.go (the SELECT that feeds RunCampaign's enqueue
// loop).
//
// Background: prior to this test the filter excluded only three
// statuses — bounced, blacklisted, invalid — while migration 033's
// canonical status vocabulary declares eight opt-out statuses that
// MUST NOT receive outbound mail. A contact enrolled while `valid`
// whose status later flipped to `unsubscribed` or `opted_out` (via
// unsubscribe link, reply classification, bounce cascade, or human
// handoff) would still be fed to the sender on the next tick.
//
// See docs/audits/exclusion-vocabulary-drift-2026-04-17.md for the
// pre-fix 3-status filter and why it was compliance-broken.
//
// These tests lock in the 9-status vocabulary so a refactor that
// silently drops a status from the NOT IN clause fails here rather
// than shipping as a spam / GDPR regression.

// requiredExcludedStatuses is the canonical set the send-loop filter
// MUST block. Derived from migration 033's compliance comment
// (bounced, unsubscribed, blacklisted, opted_out, human_handoff,
// paused_human, completed_no_reply, retention_expired) plus `invalid`
// (a format-level reject that predates the compliance set).
//
// If this set expands, both runner.go:116 and this test must expand
// together.
var requiredExcludedStatuses = []string{
	"bounced",
	"blacklisted",
	"invalid",
	"unsubscribed",
	"opted_out",
	"human_handoff",
	"paused_human",
	"completed_no_reply",
	"retention_expired",
}

func TestRunCampaign_ExclusionFilter_ContainsAllRequiredStatuses(t *testing.T) {
	// Captures the exact SQL text the runner emits for the send-loop
	// SELECT and asserts every required exclusion status appears inside
	// a NOT IN (...) clause on c.status. This protects against:
	//
	//   - Dropping a status from the clause (compliance regression)
	//   - Moving a status OUT of the NOT IN (into the positive predicate
	//     on cc.status, for example) while still mentioning it in SQL
	//   - Splitting the clause across two expressions with an OR, which
	//     would allow the unwanted row through
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.NewWithDSN("compliance-capture",
		sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		// Fallback: NewWithDSN may not be supported by this version. Use
		// the regular New() constructor instead.
		db, mock, err = sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
		if err != nil {
			t.Fatalf("sqlmock.New: %v", err)
		}
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Compliance Campaign", "running", steps))

	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// The NOT IN clause must contain every required status, wrapped in
	// single quotes, in any order, with arbitrary whitespace between
	// them. Using (?s) for dotall so newlines inside the clause match.
	var clauseBuf strings.Builder
	clauseBuf.WriteString(`(?s)c\.status\s+NOT\s+IN\s*\(`)
	for _, s := range requiredExcludedStatuses {
		// Each status must appear at least once inside the clause.
		clauseBuf.WriteString(`(?:[^)]*'`)
		clauseBuf.WriteString(regexp.QuoteMeta(s))
		clauseBuf.WriteString(`')`)
	}
	clauseBuf.WriteString(`[^)]*\)`)

	// sqlmock's regex matcher tests against the query string, so a
	// pattern asserting presence is sufficient. A pattern that does NOT
	// match causes ExpectationsWereMet to fail.
	mock.ExpectQuery(clauseBuf.String()).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step", "email",
			"first_name", "company_name", "region",
		}))

	r := NewRunner(db, nil, nil)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Errorf("RunCampaign: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("send-loop SQL missing one or more required exclusion "+
			"statuses — migration 033 compliance broken: %v", err)
	}
}

func TestRunCampaign_ExclusionFilter_EveryRequiredStatusIndividually(t *testing.T) {
	// Per-status explicit check. Rather than one big regex, loops the
	// required set and asserts each appears with a surrounding NOT IN
	// context. If one goes missing, the error message names exactly
	// which status was dropped — much more actionable than "regex
	// didn't match" for the person reading the test failure.
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	// Snapshot the runner's send-loop SQL by intercepting it via
	// sqlmock's QueryMatcherRegexp and a permissive pattern that
	// matches any SELECT on campaign_contacts. We then inspect the
	// captured query text.
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Test", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Capture-by-matching approach: the matcher is called with the
	// actual query text; we set it to a very loose pattern that always
	// matches, and then check the captured string below. sqlmock's
	// matcher doesn't expose the text directly, so instead we register
	// one ExpectQuery per required status, each demanding the status
	// appear after 'NOT IN' with a quoted literal. Any missing status
	// causes ExpectationsWereMet to fail and names the expectation.
	for _, status := range requiredExcludedStatuses {
		// The pattern requires that the SELECT contains "NOT IN" and
		// the quoted status string. Because sqlmock matches in FIFO
		// order against queries, and the runner only emits ONE send-
		// loop query, we cannot register multiple ExpectQuery for the
		// same call. Use the combined regex approach from the prior
		// test instead; this test now inspects the expression at the
		// source level by reading the file.
		_ = status
	}

	// Pragmatic: read the source file and assert every required status
	// appears in the NOT IN clause. Source-level assertion catches
	// refactors that sqlmock cannot (e.g. building the clause from a
	// slice at runtime where sqlmock sees only the final text).
	src, err := os.ReadFile("runner.go")
	if err != nil {
		t.Fatalf("read runner.go: %v", err)
	}

	// Extract everything between "c.status NOT IN (" and the closing
	// paren. Dotall so we span newlines.
	re := regexp.MustCompile(`(?s)c\.status\s+NOT\s+IN\s*\(([^)]*)\)`)
	m := re.FindStringSubmatch(string(src))
	if m == nil {
		t.Fatal("runner.go no longer contains 'c.status NOT IN (...)' — " +
			"filter removed or reshaped; compliance gate broken")
	}
	clause := m[1]

	for _, status := range requiredExcludedStatuses {
		needle := "'" + status + "'"
		if !strings.Contains(clause, needle) {
			t.Errorf("runner.go NOT IN clause missing required status %q — "+
				"contacts with this status would receive outbound mail. "+
				"Migration 033 compliance broken. Clause: %s",
				status, clause)
		}
	}
}
