package mailbox

import (
	"context"
	"testing"
	"time"
)

// TestSelector_Pick_LjNilBranch covers line 263 (case lj == nil: return false).
// Nil element first → insertion sort compares less(1,0) = less(non-nil,nil) → line 263.
func TestSelector_Pick_LjNilBranch(t *testing.T) {
	now := time.Date(2026, 4, 25, 12, 0, 0, 0, time.UTC)
	t1 := now.Add(-3 * time.Hour)

	// nil element at index 0, non-nil at index 1
	// insertion sort: less(1,0) = less(m1(non-nil), m4(nil)) → lj==nil → line 263
	m4 := validMailbox()
	m4.ID = 4
	m4.FromAddress = "d@sender.test"
	// LastSendAt = nil

	m1 := validMailbox()
	m1.ID = 1
	m1.LastSendAt = &t1

	sel := Selector{Cooldown: 0, Capacity: StaticCapacity(100)}
	got, err := sel.Pick(context.Background(), []Mailbox{m4, m1}, now)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if got.ID != 4 {
		t.Errorf("expected m4 (nil LastSendAt) to win, got ID=%d", got.ID)
	}
}
