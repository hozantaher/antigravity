package campaign

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── A2: Pure predicate unit tests ─────────────────────────────────────────

func TestEmailStatusAllowed_Valid(t *testing.T) {
	if !EmailStatusAllowed("valid") {
		t.Error("status 'valid' must be allowed")
	}
}

func TestEmailStatusAllowed_Risky(t *testing.T) {
	if EmailStatusAllowed("risky") {
		t.Error("status 'risky' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_CatchAll(t *testing.T) {
	if EmailStatusAllowed("catch_all") {
		t.Error("status 'catch_all' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_RoleOnly(t *testing.T) {
	if EmailStatusAllowed("role_only") {
		t.Error("status 'role_only' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_Unverified(t *testing.T) {
	if EmailStatusAllowed("unverified") {
		t.Error("status 'unverified' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_Invalid(t *testing.T) {
	if EmailStatusAllowed("invalid") {
		t.Error("status 'invalid' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_Spamtrap(t *testing.T) {
	if EmailStatusAllowed("spamtrap") {
		t.Error("status 'spamtrap' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_NoEmail(t *testing.T) {
	if EmailStatusAllowed("no_email") {
		t.Error("status 'no_email' must NOT be allowed")
	}
}

func TestEmailStatusAllowed_Empty(t *testing.T) {
	if EmailStatusAllowed("") {
		t.Error("empty status must NOT be allowed")
	}
}

func TestEmailStatusAllowed_CaseSensitive_Upper(t *testing.T) {
	if EmailStatusAllowed("VALID") {
		t.Error("'VALID' (uppercase) must NOT be allowed — gate is case-sensitive")
	}
}

func TestEmailStatusAllowed_CaseSensitive_Mixed(t *testing.T) {
	if EmailStatusAllowed("Valid") {
		t.Error("'Valid' (mixed) must NOT be allowed — gate is case-sensitive")
	}
}

// ── A2: Table-driven — all validation.EmailStatus constants ───────────────

func TestEmailStatusAllowed_Table(t *testing.T) {
	cases := []struct {
		status string
		want   bool
	}{
		{"valid", true},
		// every non-valid status from validation.EmailStatus
		{"risky", false},
		{"catch_all", false},
		{"role_only", false},
		{"unverified", false},
		{"invalid", false},
		{"spamtrap", false},
		{"no_email", false},
		// edge / unexpected values
		{"", false},
		{"VALID", false},
		{"Valid", false},
		{"disposable", false},  // not in current enum, but must block
		{"unknown_future", false},
	}
	for _, tc := range cases {
		got := EmailStatusAllowed(tc.status)
		if got != tc.want {
			t.Errorf("EmailStatusAllowed(%q) = %v, want %v", tc.status, got, tc.want)
		}
	}
}

// ── A2: Property tests ────────────────────────────────────────────────────

// Only the exact string "valid" may return true.
func TestEmailStatusAllowed_Property_OnlyValidAllowed(t *testing.T) {
	f := func(s string) bool {
		if s == "valid" {
			return EmailStatusAllowed(s) // must be true
		}
		return !EmailStatusAllowed(s) // all other strings must be false
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 2000}); err != nil {
		t.Errorf("property: EmailStatusAllowed accepts non-valid string: %v", err)
	}
}

// EmailStatusAllowed must be deterministic (same input → same output).
func TestEmailStatusAllowed_Property_Deterministic(t *testing.T) {
	f := func(s string) bool {
		return EmailStatusAllowed(s) == EmailStatusAllowed(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("property: EmailStatusAllowed is non-deterministic: %v", err)
	}
}

// ── A2: Runner integration via sqlmock ────────────────────────────────────
//
// Strategy: Runner is created with engine=nil. If the gate fires before
// r.engine.Enqueue(), RunCampaign completes without panic. If the gate
// is missing, the nil engine dereference panics → test FAILS (RED).
//
// This gives a clean, zero-mock-framework RED/GREEN signal.

// nonValidStatuses is every email_status value that must be blocked.
var nonValidStatuses = []string{
	"risky", "catch_all", "role_only", "unverified",
	"invalid", "spamtrap", "no_email",
}

// setupGateCampaign wires the common sqlmock expectations for a 1-step
// "running" campaign: load + status UPDATE.
func setupGateCampaign(t *testing.T, mock sqlmock.Sqlmock) {
	t.Helper()
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "initial"}})
	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("GateCampaign", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
}

// contactRow returns a sqlmock Rows with email_status and parent_ico as last columns.
// The runner query must SELECT these columns via companies LEFT JOIN.
func contactRow(emailStatus string) *sqlmock.Rows {
	return sqlmock.NewRows([]string{
		"id", "contact_id", "current_step",
		"email", "first_name", "company_name", "region",
		"email_status", "parent_ico",
	}).AddRow(1, 10, 0, "test@firma.cz", "Jan", "Firma s.r.o.", "Praha", emailStatus, "")
}

func TestGate_NonValidStatus_NoPanicNilEngine(t *testing.T) {
	// All non-valid statuses must be blocked BEFORE engine.Enqueue is called.
	// Runner with nil engine panics on Enqueue → gate must fire first.
	for _, status := range nonValidStatuses {
		status := status
		t.Run(status, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("email_status=%q: nil-engine panic means gate did NOT fire (Enqueue was called): %v", status, r)
				}
			}()

			defer os.Unsetenv("SKIP_CALENDAR_CHECK")
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatalf("sqlmock.New: %v", err)
			}
			defer db.Close()

			setupGateCampaign(t, mock)

			mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
				WillReturnRows(contactRow(status))

			r := NewRunner(db, nil, nil) // nil engine — Enqueue would panic
			err = r.RunCampaign(context.Background(), 1)
			if err != nil {
				t.Errorf("email_status=%q: unexpected error: %v", status, err)
			}
		})
	}
}

func TestGate_AllNonValidStatuses_NoStepAdvance(t *testing.T) {
	// When gate blocks a contact, campaign_contacts MUST NOT be advanced.
	// We verify by setting sqlmock to strict mode — any unexpected ExecContext
	// (step-advance UPDATE) causes mock.ExpectationsWereMet() to fail.
	for _, status := range nonValidStatuses {
		status := status
		t.Run(status, func(t *testing.T) {
			defer os.Unsetenv("SKIP_CALENDAR_CHECK")
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatalf("sqlmock.New: %v", err)
			}
			defer db.Close()

			setupGateCampaign(t, mock)

			mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
				WillReturnRows(contactRow(status))

			// No ExpectExec for UPDATE campaign_contacts — if runner tries to
			// advance the step, sqlmock will return an error (unexpected call).

			r := NewRunner(db, nil, nil)
			_ = r.RunCampaign(context.Background(), 1)

			// Strict check: only the two expected interactions (load + status
			// UPDATE) should have happened. No step-advance.
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Errorf("email_status=%q: unexpected DB interaction (step advanced?): %v", status, err)
			}
		})
	}
}

func TestGate_MultipleNonValidContacts_AllSkipped(t *testing.T) {
	// Five contacts, each with a different non-valid status.
	// None should cause Enqueue (nil engine would panic on first hit).
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	setupGateCampaign(t, mock)

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "current_step",
		"email", "first_name", "company_name", "region",
		"email_status", "parent_ico",
	})
	for i, status := range nonValidStatuses {
		rows.AddRow(int64(i+1), int64(i+100), 0,
			"c@firma.cz", "Jan", "Firma", "Praha", status, "")
	}
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(rows)

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("nil-engine panic on multi-contact non-valid batch: %v", r)
		}
	}()

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestGate_EmptyEmailStatus_Blocked(t *testing.T) {
	// Empty email_status (no company row) must be treated as unverified → blocked.
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	setupGateCampaign(t, mock)

	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(contactRow("")) // empty = LEFT JOIN miss, COALESCE → ""

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("nil-engine panic on empty email_status: %v", r)
		}
	}()

	r := NewRunner(db, nil, nil)
	_ = r.RunCampaign(context.Background(), 1)
}

func TestGate_QueryContainsCompaniesJoin(t *testing.T) {
	// Verify the contact SELECT query includes the companies LEFT JOIN.
	// sqlmock captures the actual query string — this test fails (RED) as
	// long as runner.go does not join companies.
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
			AddRow("Campaign", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Contact query MUST reference companies table, email_status and parent_ico.
	mock.ExpectQuery(`companies`).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "contact_id", "current_step",
			"email", "first_name", "company_name", "region",
			"email_status", "parent_ico",
		}))

	r := NewRunner(db, nil, nil)
	err = r.RunCampaign(context.Background(), 1)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("contact query missing companies JOIN: %v", err)
	}
}

// ── A2: Property — N instances of non-valid statuses all blocked ──────────

func TestGate_Property_NonValidNeverEnqueues(t *testing.T) {
	// For every non-valid status, a runner with nil engine must not panic.
	// Any panic means the gate failed to block before Enqueue.
	for _, status := range nonValidStatuses {
		status := status
		t.Run("prop/"+status, func(t *testing.T) {
			f := func() bool {
				defer func() { recover() }() // if panic, f returns false
				panicked := true
				defer func() {
					if recover() != nil {
						panicked = true
					}
				}()
				panicked = false

				os.Setenv("SKIP_CALENDAR_CHECK", "1")
				defer os.Unsetenv("SKIP_CALENDAR_CHECK")

				db, mock, _ := sqlmock.New()
				defer db.Close()

				setupGateCampaign(t, mock)
				mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
					WillReturnRows(contactRow(status))

				r := NewRunner(db, nil, nil)
				r.RunCampaign(context.Background(), 1) //nolint:errcheck

				return !panicked
			}
			// Run 5 times to catch any flakiness.
			for i := range 5 {
				if !f() {
					t.Errorf("iteration %d: nil-engine panic for status=%q", i, status)
				}
			}
		})
	}
}
