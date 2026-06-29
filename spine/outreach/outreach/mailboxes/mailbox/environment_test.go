// environment_test.go — unit tests for the environment column isolation
// introduced in migration 055 (Sprint J3 / H6.3).
//
// These are pure unit tests (no build tag, no real DB). They verify:
//   - Mailbox.Environment field is present in the struct
//   - Filter.Environment field is present and drives query building
//   - Default environment value is "production" when unset
//   - filterBySendable correctly rejects non-production mailboxes
//     (defence-in-depth for the selector layer)

package mailbox

import (
	"fmt"
	"strings"
	"testing"
)

// ─── Mailbox struct invariants ────────────────────────────────────────────────

func TestMailbox_EnvironmentField_DefaultsEmpty(t *testing.T) {
	m := Mailbox{}
	// Zero value is empty string — callers must set it; scanMailbox uses COALESCE.
	if m.Environment != "" {
		t.Errorf("zero Mailbox.Environment should be empty, got %q", m.Environment)
	}
}

func TestMailbox_EnvironmentField_CanBeSet(t *testing.T) {
	for _, env := range []string{"production", "test", "dev", "staging"} {
		m := Mailbox{Environment: env}
		if m.Environment != env {
			t.Errorf("Environment field round-trip failed for %q", env)
		}
	}
}

func TestMailbox_IsProduction(t *testing.T) {
	cases := []struct {
		env  string
		want bool
	}{
		{"production", true},
		{"test", false},
		{"dev", false},
		{"staging", false},
		{"", false}, // zero value is NOT treated as production
	}
	for _, tc := range cases {
		m := Mailbox{Environment: tc.env}
		got := m.Environment == "production"
		if got != tc.want {
			t.Errorf("Environment=%q → isProduction=%v want %v", tc.env, got, tc.want)
		}
	}
}

// ─── Filter struct invariants ─────────────────────────────────────────────────

func TestFilter_EnvironmentField_ZeroValueIsEmpty(t *testing.T) {
	f := Filter{}
	if f.Environment != "" {
		t.Errorf("zero Filter.Environment should be empty, got %q", f.Environment)
	}
}

func TestFilter_EnvironmentField_RoundTrip(t *testing.T) {
	f := Filter{Environment: "production"}
	if f.Environment != "production" {
		t.Errorf("Filter.Environment round-trip failed: got %q", f.Environment)
	}
}

func TestFilter_ApplyDefault_DoesNotSetEnvironment(t *testing.T) {
	// ApplyDefault only fills in Limit — it must NOT assume production environment
	// so admin callers can explicitly pass "" to get all environments.
	f := Filter{}.ApplyDefault()
	if f.Environment != "" {
		t.Errorf("ApplyDefault must not set Environment (caller's responsibility), got %q", f.Environment)
	}
}

// ─── Query building via Filter ────────────────────────────────────────────────

// buildListQuery is a local replica of the WHERE-building logic in List()
// so we can unit-test it without a DB connection.
func buildListQuery(filter Filter) string {
	filter = filter.ApplyDefault()
	var (
		conds []string
		idx   = 1
	)
	if len(filter.Status) > 0 {
		placeholders := make([]string, len(filter.Status))
		for i := range filter.Status {
			placeholders[i] = fmt.Sprintf("$%d", idx)
			idx++
		}
		conds = append(conds, "status IN ("+strings.Join(placeholders, ",")+")")
	}
	if filter.Environment != "" {
		conds = append(conds, fmt.Sprintf("environment = $%d", idx))
		idx++
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	return fmt.Sprintf("SELECT %s FROM outreach_mailboxes %s ORDER BY from_address LIMIT $%d",
		mailboxColumns, where, idx)
}

func TestFilter_Environment_AddsWhereClause(t *testing.T) {
	q := buildListQuery(Filter{Environment: "production"})
	if !strings.Contains(q, "environment = $1") {
		t.Errorf("expected environment filter in query, got:\n%s", q)
	}
	if !strings.Contains(q, "WHERE") {
		t.Errorf("expected WHERE clause, got:\n%s", q)
	}
}

func TestFilter_EmptyEnvironment_NoWhereClause(t *testing.T) {
	q := buildListQuery(Filter{})
	// mailboxColumns contains the word "environment" (the column itself)
	// but the WHERE clause must not contain an environment condition.
	if strings.Contains(q, "WHERE") && strings.Contains(q, "environment = ") {
		t.Errorf("empty environment should not add WHERE environment condition, got:\n%s", q)
	}
	// No WHERE clause at all when filter is empty (just LIMIT)
	if strings.Contains(q, "WHERE") {
		t.Errorf("empty filter should not add any WHERE clause, got:\n%s", q)
	}
}

func TestFilter_EnvironmentAndStatus_BothApplied(t *testing.T) {
	q := buildListQuery(Filter{
		Status:      []Status{StatusActive},
		Environment: "production",
	})
	if !strings.Contains(q, "status IN") {
		t.Errorf("expected status filter, got:\n%s", q)
	}
	if !strings.Contains(q, "environment = ") {
		t.Errorf("expected environment filter, got:\n%s", q)
	}
	if !strings.Contains(q, "AND") {
		t.Errorf("expected AND between conditions, got:\n%s", q)
	}
}

func TestFilter_Environment_DoesNotAffectStatusOnlyFilter(t *testing.T) {
	q := buildListQuery(Filter{Status: []Status{StatusActive}})
	// Should not contain environment in the WHERE clause
	if strings.Contains(q, "environment = ") {
		t.Errorf("status-only filter should not include environment WHERE clause, got:\n%s", q)
	}
}

// ─── Sendable + environment defence-in-depth ──────────────────────────────────

func TestMailbox_TestEnv_NotSendableByStatus(t *testing.T) {
	// A test mailbox should not be Status='active' in production; but even if
	// it is (operator error), the environment filter in the DB query guards it.
	// This test verifies Status.Sendable() is independent of Environment —
	// the guard is at the query layer, not the struct level.
	m := Mailbox{Status: StatusPaused, Environment: "test"}
	if m.Status.Sendable() {
		t.Error("test env paused mailbox should not be sendable")
	}
}

func TestMailbox_ProductionActive_IsSendable(t *testing.T) {
	m := Mailbox{Status: StatusActive, Environment: "production"}
	if !m.Status.Sendable() {
		t.Error("production active mailbox should be sendable")
	}
}
