package contact

import "testing"

// Tests for ExcludedStatuses. Prior to this file the function was
// exported, documented as "statuses that MUST NOT receive outbound
// mail", and 0 % covered. These tests lock in the current return set
// so a silent removal (e.g. someone dropping StatusUnsubscribed from
// the list during a refactor) fails here rather than shipping as an
// anti-spam regression.
//
// The function's contract is operational, not legal: it is consumed
// (or should be consumed — see the adjacent exclusion-vocabulary
// audit) by every caller that decides whether a contact may be
// emailed. Silent drift of this set is the worst class of bug this
// package could ship: it would enable outbound mail to addresses
// that have bounced, been blacklisted, unsubscribed, or are
// syntactically invalid.

func TestExcludedStatuses_ContainsExpectedSet(t *testing.T) {
	got := ExcludedStatuses()
	want := map[Status]bool{
		StatusBounced:      true,
		StatusBlacklisted:  true,
		StatusInvalid:      true,
		StatusUnsubscribed: true,
	}

	if len(got) != len(want) {
		t.Fatalf("ExcludedStatuses returned %d entries, want %d — set has drifted: %v",
			len(got), len(want), got)
	}
	for _, s := range got {
		if !want[s] {
			t.Errorf("ExcludedStatuses returned unexpected status %q", s)
		}
		delete(want, s)
	}
	for s := range want {
		t.Errorf("ExcludedStatuses missing required status %q", s)
	}
}

func TestExcludedStatuses_NoDuplicates(t *testing.T) {
	got := ExcludedStatuses()
	seen := make(map[Status]int)
	for _, s := range got {
		seen[s]++
	}
	for s, n := range seen {
		if n > 1 {
			t.Errorf("ExcludedStatuses returned %q %d times — duplicates waste runner-query planner cycles and indicate sloppy refactor", s, n)
		}
	}
}

func TestExcludedStatuses_AllEntriesAreCanonicalStatuses(t *testing.T) {
	// Migration 033 (status_enum_check) locks the canonical status
	// vocabulary at the DB level. Any status returned by
	// ExcludedStatuses must also be in that vocabulary, otherwise
	// downstream filters that consult this function would filter on
	// values that cannot legally appear in the table — a silent no-op.
	//
	// This test enumerates the canonical lifecycle + opt-out set from
	// migration 033's CHECK constraint. If migration 033 expands, this
	// list expands with it. If ExcludedStatuses adds a value outside
	// this set, the constraint will reject the row, not the runner.
	canonical := map[Status]bool{
		"new":                true,
		"validating":         true,
		"valid":              true,
		"invalid":            true,
		"active":             true,
		"sent":               true,
		"opened":             true,
		"replied":            true,
		"bounced":            true,
		"unsubscribed":       true,
		"blacklisted":        true,
		"opted_out":          true,
		"human_handoff":      true,
		"paused_human":       true,
		"completed_no_reply": true,
		"retention_expired":  true,
	}
	for _, s := range ExcludedStatuses() {
		if !canonical[s] {
			t.Errorf("ExcludedStatuses returned %q which is not in migration 033 canonical vocabulary — the runner would filter on an unreachable value", s)
		}
	}
}

func TestExcludedStatuses_ReturnsNewSlice(t *testing.T) {
	// Callers must be free to sort/mutate the returned slice without
	// affecting subsequent calls. If the function ever returns a
	// shared package-level slice, this test flags it.
	a := ExcludedStatuses()
	if len(a) == 0 {
		t.Fatal("ExcludedStatuses returned empty slice")
	}
	orig := a[0]
	a[0] = "poisoned"
	b := ExcludedStatuses()
	if b[0] == "poisoned" {
		t.Errorf("ExcludedStatuses returns a shared slice — mutating the first call affected the second (b[0]=%q). Callers that sort or filter in place would corrupt every other caller.", b[0])
	}
	if b[0] != orig {
		t.Errorf("ExcludedStatuses second call returned %q, want %q — non-deterministic return", b[0], orig)
	}
}
