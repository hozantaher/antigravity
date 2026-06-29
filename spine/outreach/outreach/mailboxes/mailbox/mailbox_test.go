package mailbox

import (
	"context"
	"errors"
	"testing"
	"time"
)

func validMailbox() Mailbox {
	return Mailbox{
		ID:          1,
		FromAddress: "jan@sender.test",
		DisplayName: "Jan Novák",
		SMTPHost:    "smtp.sender.test",
		SMTPPort:    587,
		Status:      StatusActive,
		TZ:          "Europe/Prague",
		Locale:      "cs-CZ",
	}
}

func TestStatus_Valid(t *testing.T) {
	for _, s := range []Status{
		StatusActive, StatusPaused, StatusBounceHold, StatusRetired,
	} {
		if !s.Valid() {
			t.Errorf("%q should be a valid status", s)
		}
	}
	if Status("carrier_pigeon").Valid() {
		t.Error("unknown status must be invalid")
	}
}

func TestStatus_Sendable(t *testing.T) {
	cases := map[Status]bool{
		StatusActive:     true,
		StatusPaused:     false,
		StatusBounceHold: false,
		StatusRetired:    false,
	}
	for s, want := range cases {
		if got := s.Sendable(); got != want {
			t.Errorf("%s.Sendable(): got %v want %v", s, got, want)
		}
	}
}

func TestNormaliseAddress(t *testing.T) {
	cases := map[string]string{
		"jan@sender.test":   "jan@sender.test",
		"  JAN@SENDER.TEST": "jan@sender.test",
		"Jan@Sender.Test ":  "jan@sender.test",
	}
	for in, want := range cases {
		if got := NormaliseAddress(in); got != want {
			t.Errorf("NormaliseAddress(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMailbox_Validate(t *testing.T) {
	if err := validMailbox().Validate(); err != nil {
		t.Errorf("valid mailbox rejected: %v", err)
	}

	cap := -1
	badCap := validMailbox()
	badCap.DailyCapOverride = &cap

	cases := []struct {
		name string
		mut  func(*Mailbox)
	}{
		{"empty from", func(m *Mailbox) { m.FromAddress = "" }},
		{"uppercase from", func(m *Mailbox) { m.FromAddress = "Jan@sender.test" }},
		{"whitespace from", func(m *Mailbox) { m.FromAddress = "   " }},
		{"empty display name", func(m *Mailbox) { m.DisplayName = "" }},
		{"empty smtp host", func(m *Mailbox) { m.SMTPHost = "" }},
		{"smtp port zero", func(m *Mailbox) { m.SMTPPort = 0 }},
		{"smtp port too high", func(m *Mailbox) { m.SMTPPort = 70000 }},
		{"imap port invalid when host set", func(m *Mailbox) {
			m.IMAPHost = "imap.sender.test"
			m.IMAPPort = 0
		}},
		{"negative daily cap", func(m *Mailbox) { m.DailyCapOverride = &cap }},
		{"unknown status", func(m *Mailbox) { m.Status = "vanished" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := validMailbox()
			tc.mut(&m)
			if err := m.Validate(); err == nil {
				t.Errorf("expected validation error for %s", tc.name)
			}
		})
	}
}

func TestMailbox_CooldownExpired(t *testing.T) {
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	cooldown := 5 * time.Minute

	// Never sent → always expired.
	m := validMailbox()
	if !m.CooldownExpired(now, cooldown) {
		t.Error("mailbox that never sent should report cooldown expired")
	}

	// Last send 4m ago → not expired.
	four := now.Add(-4 * time.Minute)
	m.LastSendAt = &four
	if m.CooldownExpired(now, cooldown) {
		t.Error("4m ago should still be on cooldown under 5m threshold")
	}

	// Last send exactly 5m ago → expired (>=, inclusive).
	five := now.Add(-5 * time.Minute)
	m.LastSendAt = &five
	if !m.CooldownExpired(now, cooldown) {
		t.Error("5m ago should be exactly at threshold")
	}

	// Zero cooldown → always expired (rate limiter off).
	if !m.CooldownExpired(now, 0) {
		t.Error("zero cooldown should always report expired")
	}
}

func TestFilter_ApplyDefault(t *testing.T) {
	if got := (Filter{}).ApplyDefault().Limit; got != 100 {
		t.Errorf("default Limit: got %d want 100", got)
	}
	if got := (Filter{Limit: 7}).ApplyDefault().Limit; got != 7 {
		t.Errorf("explicit Limit must be preserved, got %d", got)
	}
}

func TestShouldAutoHold(t *testing.T) {
	// Under threshold → no hold.
	m := validMailbox()
	m.ConsecutiveBounces = BackpressureThreshold - 1
	if ShouldAutoHold(m) {
		t.Error("below threshold must not trigger auto-hold")
	}

	// At threshold → hold.
	m.ConsecutiveBounces = BackpressureThreshold
	if !ShouldAutoHold(m) {
		t.Error("at threshold must trigger auto-hold")
	}

	// Already paused → never auto-hold (idempotent).
	paused := m
	paused.Status = StatusPaused
	if ShouldAutoHold(paused) {
		t.Error("paused mailbox must not auto-hold")
	}

	// Retired → never auto-hold.
	retired := m
	retired.Status = StatusRetired
	if ShouldAutoHold(retired) {
		t.Error("retired mailbox must not auto-hold")
	}
}

func TestSelector_Pick_PrefersOldestLastSend(t *testing.T) {
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	older := now.Add(-30 * time.Minute)
	newer := now.Add(-10 * time.Minute)

	a := validMailbox()
	a.ID = 1
	a.FromAddress = "a@sender.test"
	a.LastSendAt = &newer

	b := validMailbox()
	b.ID = 2
	b.FromAddress = "b@sender.test"
	b.LastSendAt = &older // oldest — should win

	c := validMailbox()
	c.ID = 3
	c.FromAddress = "c@sender.test"
	c.LastSendAt = &newer

	sel := Selector{Cooldown: 1 * time.Minute, Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), []Mailbox{a, b, c}, now)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if got.ID != b.ID {
		t.Errorf("expected mailbox %d (oldest), got %d", b.ID, got.ID)
	}
}

func TestSelector_Pick_NeverSentWinsOverAny(t *testing.T) {
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	t1 := now.Add(-1 * time.Hour)

	sent := validMailbox()
	sent.ID = 1
	sent.LastSendAt = &t1

	fresh := validMailbox()
	fresh.ID = 2
	fresh.FromAddress = "fresh@sender.test"
	// No LastSendAt — should win.

	sel := Selector{Cooldown: 1 * time.Minute, Capacity: StaticCapacity(10)}
	got, err := sel.Pick(context.Background(), []Mailbox{sent, fresh}, now)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if got.ID != fresh.ID {
		t.Errorf("never-sent mailbox must be picked first, got ID %d", got.ID)
	}
}

func TestSelector_Pick_DropsNonSendable(t *testing.T) {
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	sel := Selector{Cooldown: 0, Capacity: StaticCapacity(10)}

	// All non-sendable → ErrNoSendable.
	paused := validMailbox()
	paused.ID = 1
	paused.Status = StatusPaused

	held := validMailbox()
	held.ID = 2
	held.FromAddress = "held@sender.test"
	held.Status = StatusBounceHold

	retired := validMailbox()
	retired.ID = 3
	retired.FromAddress = "retired@sender.test"
	retired.Status = StatusRetired

	_, err := sel.Pick(context.Background(), []Mailbox{paused, held, retired}, now)
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("all-non-sendable pool must yield ErrNoSendable, got %v", err)
	}

	// Only the active one is eligible, rest excluded.
	active := validMailbox()
	active.ID = 4
	active.FromAddress = "active@sender.test"
	got, err := sel.Pick(context.Background(), []Mailbox{paused, held, retired, active}, now)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if got.ID != active.ID {
		t.Errorf("only active mailbox should be picked, got ID %d", got.ID)
	}
}

func TestSelector_Pick_HonoursCooldown(t *testing.T) {
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	recent := now.Add(-30 * time.Second)

	// Single mailbox that just sent — cooldown still active.
	m := validMailbox()
	m.LastSendAt = &recent

	sel := Selector{Cooldown: 5 * time.Minute, Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), []Mailbox{m}, now)
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("cooldown-bound mailbox must be excluded, got %v", err)
	}

	// Advancing time past cooldown unlocks it.
	later := now.Add(10 * time.Minute)
	got, err := sel.Pick(context.Background(), []Mailbox{m}, later)
	if err != nil {
		t.Fatalf("Pick after cooldown: %v", err)
	}
	if got.ID != m.ID {
		t.Errorf("expected mailbox %d after cooldown, got %d", m.ID, got.ID)
	}
}

func TestSelector_Pick_HonoursCapacity(t *testing.T) {
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)

	a := validMailbox()
	a.ID = 1
	a.FromAddress = "a@sender.test"

	b := validMailbox()
	b.ID = 2
	b.FromAddress = "b@sender.test"

	// Capacity oracle returns 0 for a, 5 for b → only b eligible.
	cap := CapacityFunc(func(_ context.Context, m Mailbox, _ time.Time) (int, error) {
		if m.ID == a.ID {
			return 0, nil
		}
		return 5, nil
	})

	sel := Selector{Cooldown: 0, Capacity: cap}
	got, err := sel.Pick(context.Background(), []Mailbox{a, b}, now)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if got.ID != b.ID {
		t.Errorf("capacity=0 mailbox must be excluded; expected %d got %d", b.ID, got.ID)
	}

	// All at zero → ErrNoSendable.
	zero := StaticCapacity(0)
	sel2 := Selector{Cooldown: 0, Capacity: zero}
	_, err = sel2.Pick(context.Background(), []Mailbox{a, b}, now)
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("all-zero capacity must yield ErrNoSendable, got %v", err)
	}
}

func TestSelector_Pick_CapacityOracleError(t *testing.T) {
	sentinel := errors.New("oracle boom")
	sel := Selector{
		Cooldown: 0,
		Capacity: func(_ context.Context, _ Mailbox, _ time.Time) (int, error) {
			return 0, sentinel
		},
	}
	_, err := sel.Pick(context.Background(), []Mailbox{validMailbox()}, time.Now())
	if !errors.Is(err, sentinel) {
		t.Errorf("capacity oracle error must propagate, got %v", err)
	}
}

func TestSelector_Pick_NilCapacity(t *testing.T) {
	sel := Selector{Cooldown: 0}
	_, err := sel.Pick(context.Background(), []Mailbox{validMailbox()}, time.Now())
	if err == nil {
		t.Error("nil Capacity must return an error")
	}
}

func TestSelector_Pick_DeterministicTiebreak(t *testing.T) {
	// Two mailboxes with identical LastSendAt → must pick by id asc.
	now := time.Date(2026, 4, 17, 12, 0, 0, 0, time.UTC)
	ts := now.Add(-10 * time.Minute)

	low := validMailbox()
	low.ID = 2
	low.FromAddress = "low@sender.test"
	low.LastSendAt = &ts

	high := validMailbox()
	high.ID = 7
	high.FromAddress = "high@sender.test"
	high.LastSendAt = &ts

	sel := Selector{Cooldown: 0, Capacity: StaticCapacity(10)}

	// Try both orderings to prove order-independence.
	for _, pool := range [][]Mailbox{{low, high}, {high, low}} {
		got, err := sel.Pick(context.Background(), pool, now)
		if err != nil {
			t.Fatalf("Pick: %v", err)
		}
		if got.ID != low.ID {
			t.Errorf("tiebreak must prefer lower id (%d), got %d", low.ID, got.ID)
		}
	}
}

func TestSelector_Pick_EmptyPool(t *testing.T) {
	sel := Selector{Cooldown: 0, Capacity: StaticCapacity(10)}
	_, err := sel.Pick(context.Background(), nil, time.Now())
	if !errors.Is(err, ErrNoSendable) {
		t.Errorf("empty pool must yield ErrNoSendable, got %v", err)
	}
}
