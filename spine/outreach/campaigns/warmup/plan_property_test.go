package warmup_test

import (
	"testing"
	"testing/quick"

	"campaigns/warmup"
)

// ── LimitForDay property tests ────────────────────────────────────────────

func TestLimitForDay_EmptyPlan_ReturnsZero(t *testing.T) {
	p := warmup.Plan{Name: "empty"}
	if got := p.LimitForDay(1); got != 0 {
		t.Errorf("empty plan LimitForDay(1) = %d, want 0", got)
	}
}

func TestLimitForDay_MonotonicProperty(t *testing.T) {
	// For any valid plan, LimitForDay is non-decreasing: day+1 >= day.
	p := warmup.Plan{
		Name: "ramp",
		Schedule: []warmup.ScheduleEntry{
			{Day: 1, DailyLimit: 5},
			{Day: 7, DailyLimit: 20},
			{Day: 14, DailyLimit: 50},
			{Day: 30, DailyLimit: 100},
		},
	}
	f := func(day uint8) bool {
		d := int(day) + 1
		return p.LimitForDay(d+1) >= p.LimitForDay(d)
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("LimitForDay not monotonic: %v", err)
	}
}

func TestLimitForDay_ReturnsBoundedPositive(t *testing.T) {
	p := warmup.Plan{
		Name: "bounded",
		Schedule: []warmup.ScheduleEntry{
			{Day: 1, DailyLimit: 10},
			{Day: 30, DailyLimit: 200},
		},
	}
	f := func(day uint16) bool {
		limit := p.LimitForDay(int(day) + 1)
		return limit >= 0
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("LimitForDay returned negative value: %v", err)
	}
}

func TestLimitForDay_ExceedMaxDay_ReturnsFinalLimit(t *testing.T) {
	p := warmup.Plan{
		Name: "finite",
		Schedule: []warmup.ScheduleEntry{
			{Day: 1, DailyLimit: 5},
			{Day: 30, DailyLimit: 100},
		},
	}
	// Any day beyond 30 should return 100 (the max schedule entry's limit)
	for _, day := range []int{31, 50, 100, 365} {
		got := p.LimitForDay(day)
		if got != 100 {
			t.Errorf("LimitForDay(%d) = %d, want 100 (final schedule entry)", day, got)
		}
	}
}

func TestLimitForDay_BeforeFirstDay_ReturnsFirstLimit(t *testing.T) {
	p := warmup.Plan{
		Name: "starts-at-7",
		Schedule: []warmup.ScheduleEntry{
			{Day: 7, DailyLimit: 20},
			{Day: 14, DailyLimit: 50},
		},
	}
	// days 1–6 should return the first schedule limit
	for day := 1; day <= 6; day++ {
		got := p.LimitForDay(day)
		if got != 20 {
			t.Errorf("LimitForDay(%d) = %d, want 20 (first entry before day 7)", day, got)
		}
	}
}

// ── IsComplete property tests ─────────────────────────────────────────────

func TestIsComplete_AlwaysFalseBeforeFinalDay(t *testing.T) {
	p := warmup.Plan{
		Name: "30day",
		Schedule: []warmup.ScheduleEntry{
			{Day: 1, DailyLimit: 5},
			{Day: 30, DailyLimit: 100},
		},
	}
	for day := 0; day < 30; day++ {
		if p.IsComplete(day) {
			t.Errorf("IsComplete(%d) should be false before final day 30", day)
		}
	}
}

func TestIsComplete_TrueAtOrAfterFinalDay(t *testing.T) {
	p := warmup.Plan{
		Name: "14day",
		Schedule: []warmup.ScheduleEntry{
			{Day: 1, DailyLimit: 5},
			{Day: 14, DailyLimit: 75},
		},
	}
	for _, day := range []int{14, 15, 30, 100} {
		if !p.IsComplete(day) {
			t.Errorf("IsComplete(%d) should be true at/after final day 14", day)
		}
	}
}

func TestIsComplete_EmptyPlan_AlwaysTrue(t *testing.T) {
	// Empty plan = no warmup needed → IsComplete is always true (by design)
	p := warmup.Plan{Name: "empty"}
	f := func(day uint8) bool {
		return p.IsComplete(int(day))
	}
	if err := quick.Check(f, nil); err != nil {
		t.Errorf("empty plan IsComplete should always return true: %v", err)
	}
}

// ── Ramp schedule invariants ──────────────────────────────────────────────

func TestPlan_Ramp_LimitsArePositive(t *testing.T) {
	plans := []warmup.Plan{
		{
			Name: "standard",
			Schedule: []warmup.ScheduleEntry{
				{Day: 1, DailyLimit: 5},
				{Day: 3, DailyLimit: 10},
				{Day: 7, DailyLimit: 25},
				{Day: 14, DailyLimit: 50},
				{Day: 30, DailyLimit: 100},
			},
		},
		{
			Name: "aggressive",
			Schedule: []warmup.ScheduleEntry{
				{Day: 1, DailyLimit: 20},
				{Day: 7, DailyLimit: 100},
				{Day: 14, DailyLimit: 200},
			},
		},
	}
	for _, p := range plans {
		for _, e := range p.Schedule {
			if e.DailyLimit <= 0 {
				t.Errorf("plan %q: DailyLimit for day %d is %d (must be positive)", p.Name, e.Day, e.DailyLimit)
			}
			if e.Day <= 0 {
				t.Errorf("plan %q: Day %d must be positive", p.Name, e.Day)
			}
		}
	}
}
