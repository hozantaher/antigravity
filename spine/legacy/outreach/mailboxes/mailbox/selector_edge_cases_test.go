package mailbox

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// ─── Selector.Pick edge-case matrix ───────────────────────────────────────────
//
// Existing mailbox_test.go covers the happy path. These tests widen coverage
// to the edge of the contract: all-disqualified pools, oracle edge returns,
// large pools, stability under ties, and defensive nil checks.

func mkSendable(id int64, lastSend *time.Time) Mailbox {
	return Mailbox{
		ID:          id,
		FromAddress: fmt.Sprintf("m%d@sender.test", id),
		DisplayName: fmt.Sprintf("Mailbox %d", id),
		SMTPHost:    "smtp.sender.test",
		SMTPPort:    587,
		Status:      StatusActive,
		TZ:          "UTC",
		Locale:      "en-US",
		LastSendAt:  lastSend,
	}
}

func TestSelector_Pick_AllPausedReturnsErrNoSendable(t *testing.T) {
	pool := []Mailbox{
		mkSendable(1, nil), mkSendable(2, nil), mkSendable(3, nil),
	}
	for i := range pool {
		pool[i].Status = StatusPaused
	}
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("all paused: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_AllHeldReturnsErrNoSendable(t *testing.T) {
	pool := []Mailbox{mkSendable(1, nil), mkSendable(2, nil)}
	for i := range pool {
		pool[i].Status = StatusBounceHold
	}
	sel := Selector{Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("all on hold: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_AllRetiredReturnsErrNoSendable(t *testing.T) {
	pool := []Mailbox{mkSendable(1, nil), mkSendable(2, nil)}
	for i := range pool {
		pool[i].Status = StatusRetired
	}
	sel := Selector{Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("all retired: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_AllAtZeroCapacityReturnsErrNoSendable(t *testing.T) {
	pool := []Mailbox{mkSendable(1, nil), mkSendable(2, nil)}
	sel := Selector{Capacity: StaticCapacity(0)}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("zero capacity: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_NegativeCapacityIsDropped(t *testing.T) {
	pool := []Mailbox{mkSendable(1, nil)}
	sel := Selector{Capacity: StaticCapacity(-10)}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("negative capacity: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_AllInCooldownReturnsErrNoSendable(t *testing.T) {
	now := time.Now()
	just := now.Add(-5 * time.Second)
	pool := []Mailbox{mkSendable(1, &just), mkSendable(2, &just)}
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), pool, now)
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("all in cooldown: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_ZeroCooldownAlwaysAllows(t *testing.T) {
	now := time.Now()
	just := now
	pool := []Mailbox{mkSendable(1, &just)}
	sel := Selector{Cooldown: 0, Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Errorf("zero cooldown, just sent: want nil err, got %v", err)
	}
}

func TestSelector_Pick_CooldownBoundaryExact(t *testing.T) {
	// When now - lastSend == cooldown exactly, CooldownExpired returns true.
	now := time.Now()
	last := now.Add(-time.Minute)
	pool := []Mailbox{mkSendable(1, &last)}
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	m, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Fatalf("exact cooldown boundary: want pick, got err %v", err)
	}
	if m.ID != 1 {
		t.Errorf("got id %d, want 1", m.ID)
	}
}

func TestSelector_Pick_CooldownBoundaryOneNsShort(t *testing.T) {
	now := time.Now()
	last := now.Add(-time.Minute + time.Nanosecond)
	pool := []Mailbox{mkSendable(1, &last)}
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), pool, now)
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("1ns before cooldown: want ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_OnlyOneSurvivorWins(t *testing.T) {
	now := time.Now()
	old := now.Add(-time.Hour)
	pool := []Mailbox{
		mkSendable(1, &old), // survivor
	}
	pool[0].Status = StatusPaused // kill it
	pool = append(pool, mkSendable(2, nil))
	sel := Selector{Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 2 {
		t.Errorf("got %d, want 2", got.ID)
	}
}

func TestSelector_Pick_OracleErrorOnFirstCandidate(t *testing.T) {
	pool := []Mailbox{mkSendable(1, nil), mkSendable(2, nil)}
	sel := Selector{
		Capacity: func(_ context.Context, _ Mailbox, _ time.Time) (int, error) {
			return 0, errors.New("oracle boom")
		},
	}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if err == nil || err.Error() == ErrNoSendable.Error() {
		t.Errorf("want oracle error propagated, got %v", err)
	}
}

func TestSelector_Pick_OracleErrorWrapsMailboxAddress(t *testing.T) {
	pool := []Mailbox{mkSendable(42, nil)}
	sel := Selector{
		Capacity: func(_ context.Context, _ Mailbox, _ time.Time) (int, error) {
			return 0, errors.New("oracle boom")
		},
	}
	_, err := sel.Pick(context.Background(), pool, time.Now())
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !substr(err.Error(), "m42@sender.test") {
		t.Errorf("error should include address; got %q", err.Error())
	}
}

func TestSelector_Pick_LargePool24Mailboxes(t *testing.T) {
	now := time.Now()
	pool := make([]Mailbox, 24)
	for i := range pool {
		last := now.Add(-time.Duration(i) * time.Hour)
		pool[i] = mkSendable(int64(i+1), &last)
	}
	sel := Selector{Cooldown: 10 * time.Second, Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Fatal(err)
	}
	// Oldest LastSendAt is id 24 (i=23, -23h).
	if got.ID != 24 {
		t.Errorf("got %d, want 24 (oldest)", got.ID)
	}
}

// (old draft test removed — superseded by LargePoolMixedStates2 below)

func TestSelector_Pick_LargePoolMixedStates2(t *testing.T) {
	now := time.Now()
	pool := make([]Mailbox, 10)
	for i := range pool {
		last := now.Add(-time.Duration(i+10) * time.Minute)
		pool[i] = mkSendable(int64(i+1), &last)
	}
	pool[1].Status = StatusPaused
	pool[3].Status = StatusBounceHold
	pool[5].Status = StatusRetired
	// Survivors: id 1, 3, 5, 7, 8, 9, 10 (indices 0,2,4,6,7,8,9).
	// Oldest of survivors: id 10 at -19 min.
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 10 {
		t.Errorf("got id %d, want 10 (oldest survivor)", got.ID)
	}
}

func TestSelector_Pick_TiebreakByIDAscending(t *testing.T) {
	now := time.Now()
	// 5 mailboxes with identical LastSendAt.
	same := now.Add(-time.Hour)
	pool := []Mailbox{
		mkSendable(5, &same),
		mkSendable(3, &same),
		mkSendable(1, &same),
		mkSendable(4, &same),
		mkSendable(2, &same),
	}
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 1 {
		t.Errorf("tiebreak: got id %d, want 1 (lowest)", got.ID)
	}
}

func TestSelector_Pick_NilLastSendTiebreakByIDAscending(t *testing.T) {
	// All never-sent mailboxes.
	pool := []Mailbox{
		mkSendable(7, nil),
		mkSendable(3, nil),
		mkSendable(11, nil),
		mkSendable(5, nil),
	}
	sel := Selector{Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), pool, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 3 {
		t.Errorf("nil-last-send tiebreak: got id %d, want 3", got.ID)
	}
}

func TestSelector_Pick_NilLastSendBeatsRecentNonNil(t *testing.T) {
	now := time.Now()
	old := now.Add(-10 * time.Hour)
	pool := []Mailbox{
		mkSendable(1, &old),
		mkSendable(2, nil),
	}
	sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), pool, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 2 {
		t.Errorf("nil should beat any non-nil; got %d, want 2", got.ID)
	}
}

func TestSelector_Pick_NilCapacityFunc(t *testing.T) {
	sel := Selector{Cooldown: time.Minute}
	_, err := sel.Pick(context.Background(), []Mailbox{mkSendable(1, nil)}, time.Now())
	if err == nil || !substr(err.Error(), "Capacity is nil") {
		t.Errorf("nil Capacity: want explicit error, got %v", err)
	}
}

func TestSelector_Pick_NilPoolSliceSafe(t *testing.T) {
	sel := Selector{Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), ([]Mailbox)(nil), time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("nil slice: want ErrNoSendable, got %v", err)
	}
}

// Status × cooldown × capacity combinatorial matrix (64 cases).
func TestSelector_Pick_StatusCooldownCapacityMatrix(t *testing.T) {
	now := time.Now()
	statuses := []Status{StatusActive, StatusPaused, StatusBounceHold, StatusRetired}
	cooldowns := []struct {
		name    string
		lastAgo time.Duration
		okTime  bool
	}{
		{"never", 0, true}, // never sent, nil
		{"stale", time.Hour, true},
		{"fresh", time.Second, false},
		{"exact", time.Minute, true},
	}
	capacities := []struct {
		name string
		n    int
		ok   bool
	}{
		{"zero", 0, false},
		{"one", 1, true},
		{"large", 1000, true},
		{"neg", -5, false},
	}
	for _, st := range statuses {
		for _, cd := range cooldowns {
			for _, cap_ := range capacities {
				name := fmt.Sprintf("%s/%s/%s", st, cd.name, cap_.name)
				t.Run(name, func(t *testing.T) {
					m := mkSendable(1, nil)
					m.Status = st
					if cd.name != "never" {
						tt := now.Add(-cd.lastAgo)
						m.LastSendAt = &tt
					}
					sel := Selector{Cooldown: time.Minute, Capacity: StaticCapacity(cap_.n)}
					_, err := sel.Pick(context.Background(), []Mailbox{m}, now)

					wantOK := st.Sendable() && cd.okTime && cap_.ok
					if wantOK && err != nil {
						t.Errorf("want pick, got err %v", err)
					}
					if !wantOK && !errors.Is(err, ErrNoSendable) {
						t.Errorf("want ErrNoSendable, got %v", err)
					}
				})
			}
		}
	}
}

func TestSelector_Pick_CapacityOracleSeesMailboxContext(t *testing.T) {
	seen := map[string]int{}
	sel := Selector{
		Capacity: func(_ context.Context, m Mailbox, _ time.Time) (int, error) {
			seen[m.FromAddress]++
			if m.ID == 2 {
				return 10, nil
			}
			return 0, nil
		},
	}
	pool := []Mailbox{mkSendable(1, nil), mkSendable(2, nil), mkSendable(3, nil)}
	got, err := sel.Pick(context.Background(), pool, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 2 {
		t.Errorf("want id 2, got %d", got.ID)
	}
	if len(seen) != 3 {
		t.Errorf("oracle should see every candidate once, saw %d unique", len(seen))
	}
}

func TestSelector_Pick_ContextPropagatedToOracle(t *testing.T) {
	type key struct{}
	ctx := context.WithValue(context.Background(), key{}, "marker")
	sel := Selector{
		Capacity: func(c context.Context, _ Mailbox, _ time.Time) (int, error) {
			if v, _ := c.Value(key{}).(string); v != "marker" {
				t.Errorf("context not propagated to oracle, got %v", v)
			}
			return 1, nil
		},
	}
	if _, err := sel.Pick(ctx, []Mailbox{mkSendable(1, nil)}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

// ─── Mailbox.CooldownExpired ───────────────────────────────────────────────

func TestCooldownExpired_Matrix(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		lastSend *time.Time
		cooldown time.Duration
		want     bool
	}{
		{"never sent, any cooldown", nil, 10 * time.Minute, true},
		{"never sent, zero cooldown", nil, 0, true},
		{"just sent, pos cooldown", &now, time.Minute, false},
		{"sent exactly at cooldown", tPtr(now.Add(-time.Minute)), time.Minute, true},
		{"sent 1ns before cooldown", tPtr(now.Add(-time.Minute + time.Nanosecond)), time.Minute, false},
		{"sent 1ns after cooldown", tPtr(now.Add(-time.Minute - time.Nanosecond)), time.Minute, true},
		{"zero cooldown, just sent", &now, 0, true},
		{"neg cooldown, just sent", &now, -time.Second, true}, // now-now=0 >= -1s: true
		{"1h ago, 10m cooldown", tPtr(now.Add(-time.Hour)), 10 * time.Minute, true},
		{"1h ago, 1h1s cooldown", tPtr(now.Add(-time.Hour)), time.Hour + time.Second, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := Mailbox{LastSendAt: c.lastSend}
			if got := m.CooldownExpired(now, c.cooldown); got != c.want {
				t.Errorf("got %v want %v (lastSend=%v cooldown=%v)",
					got, c.want, c.lastSend, c.cooldown)
			}
		})
	}
}

func tPtr(t time.Time) *time.Time { return &t }

// ─── StaticCapacity ────────────────────────────────────────────────────────

func TestStaticCapacity_AlwaysReturnsConfigured(t *testing.T) {
	cases := []int{-1000, -1, 0, 1, 10, 1_000_000}
	for _, v := range cases {
		t.Run(fmt.Sprint(v), func(t *testing.T) {
			fn := StaticCapacity(v)
			for i := 0; i < 5; i++ {
				got, err := fn(context.Background(), mkSendable(int64(i), nil), time.Now())
				if err != nil {
					t.Errorf("StaticCapacity should never err, got %v", err)
				}
				if got != v {
					t.Errorf("got %d want %d", got, v)
				}
			}
		})
	}
}

// ─── Filter.ApplyDefault ───────────────────────────────────────────────────

func TestFilter_ApplyDefault_LimitMatrix(t *testing.T) {
	cases := []struct {
		name string
		in   int
		want int
	}{
		{"zero", 0, 100},
		{"neg", -1, 100},
		{"big neg", -1000, 100},
		{"one", 1, 1},
		{"50", 50, 50},
		{"100", 100, 100},
		{"1000", 1000, 1000},
		{"maxint", int(^uint(0) >> 1), int(^uint(0) >> 1)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := Filter{Limit: c.in}.ApplyDefault()
			if f.Limit != c.want {
				t.Errorf("got limit %d, want %d", f.Limit, c.want)
			}
		})
	}
}

func TestFilter_ApplyDefault_PreservesStatus(t *testing.T) {
	f := Filter{Status: []Status{StatusActive, StatusPaused}}.ApplyDefault()
	if len(f.Status) != 2 {
		t.Errorf("status filter dropped: %+v", f)
	}
	if f.Limit != 100 {
		t.Errorf("limit default not set: %d", f.Limit)
	}
}

// ─── ShouldAutoHold matrix ────────────────────────────────────────────────

func TestShouldAutoHold_ConsecutiveBounceMatrix(t *testing.T) {
	for n := 0; n <= 10; n++ {
		for _, st := range []Status{StatusActive, StatusPaused, StatusBounceHold, StatusRetired} {
			t.Run(fmt.Sprintf("%s/%d", st, n), func(t *testing.T) {
				m := Mailbox{Status: st, ConsecutiveBounces: n}
				got := ShouldAutoHold(m)
				want := st == StatusActive && n >= BackpressureThreshold
				if got != want {
					t.Errorf("status=%s bounces=%d got=%v want=%v", st, n, got, want)
				}
			})
		}
	}
}

// ─── substr helper reused across this file ────────────────────────────────
// Renamed away from `contains` to avoid collision with the integration-tagged
// schema_invariant_test.go helper of the same name (different signature).

func substr(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOfSub(s, sub) >= 0)
}

func indexOfSub(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
