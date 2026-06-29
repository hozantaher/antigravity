package campaign

import (
	"strings"
	"testing"
	"time"
)

// KT-A5 — staircase decision-function tests.
//
// Coverage targets (memory: feedback_extreme_testing — ≥ 10 cases):
//   - DefaultStaircase shape + immutability
//   - ParseStaircase happy + nil + empty + invalid
//   - ValidateStaircase boundary table (length, negative, oversized,
//     non-monotonic)
//   - AdvanceStep decision matrix: every cell of (quota satisfied?) ×
//     (soak elapsed?) × (out-of-range step?) × (cap == 0?)
//   - CapForStep boundary cases
//
// HARD RULE (memory feedback_campaign_send): no test in this file
// invokes sender.Engine.Send(). All assertions are on pure helpers.

// ── DefaultStaircase ────────────────────────────────────────────────

func TestDefaultStaircase_Shape(t *testing.T) {
	got := DefaultStaircase()
	want := []int{1, 5, 20, 100}
	if len(got) != len(want) {
		t.Fatalf("len(DefaultStaircase) = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("DefaultStaircase[%d] = %d, want %d", i, got[i], want[i])
		}
	}
}

func TestDefaultStaircase_ReturnsCopy(t *testing.T) {
	a := DefaultStaircase()
	a[0] = 9999
	a[3] = -1

	b := DefaultStaircase()
	if b[0] != 1 {
		t.Errorf("DefaultStaircase aliased: [0] = %d, want 1", b[0])
	}
	if b[3] != 100 {
		t.Errorf("DefaultStaircase aliased: [3] = %d, want 100", b[3])
	}
}

// ── ParseStaircase ──────────────────────────────────────────────────

func TestParseStaircase_Happy(t *testing.T) {
	got, err := ParseStaircase([]byte(`[1, 5, 20]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 3 || got[0] != 1 || got[1] != 5 || got[2] != 20 {
		t.Errorf("got = %v, want [1 5 20]", got)
	}
}

func TestParseStaircase_NilFallsBackToDefault(t *testing.T) {
	got, err := ParseStaircase(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := DefaultStaircase()
	if len(got) != len(want) {
		t.Errorf("got len %d, want %d", len(got), len(want))
	}
}

func TestParseStaircase_EmptyArrayFallsBackToDefault(t *testing.T) {
	got, err := ParseStaircase([]byte(`[]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != len(DefaultStaircase()) {
		t.Errorf("empty array should fall back to default, got %v", got)
	}
}

func TestParseStaircase_NullStringFallsBackToDefault(t *testing.T) {
	got, err := ParseStaircase([]byte(`null`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != len(DefaultStaircase()) {
		t.Errorf("null should fall back to default, got %v", got)
	}
}

func TestParseStaircase_InvalidJSONFails(t *testing.T) {
	_, err := ParseStaircase([]byte(`not-json`))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestParseStaircase_NestedArraysFail(t *testing.T) {
	_, err := ParseStaircase([]byte(`[[1,2],[3,4]]`))
	if err == nil {
		t.Error("expected error for nested arrays")
	}
}

// ── ValidateStaircase ───────────────────────────────────────────────

func TestValidateStaircase_HappyDefault(t *testing.T) {
	if err := ValidateStaircase(DefaultStaircase()); err != nil {
		t.Errorf("default staircase failed validation: %v", err)
	}
}

func TestValidateStaircase_EmptyOK(t *testing.T) {
	// Operator may pre-create with no staircase; runner falls back to
	// default at parse time. Validation tolerates this.
	if err := ValidateStaircase([]int{}); err != nil {
		t.Errorf("empty staircase rejected: %v", err)
	}
}

func TestValidateStaircase_BoundaryTable(t *testing.T) {
	cases := []struct {
		name    string
		stair   []int
		wantErr string
	}{
		{
			name:    "negative cap",
			stair:   []int{1, -5, 20},
			wantErr: "must be ≥ 0",
		},
		{
			name:    "cap exceeds max",
			stair:   []int{1, 5, MaxStaircasePerStep + 1},
			wantErr: "max",
		},
		{
			name:    "non-monotonic decrease",
			stair:   []int{1, 5, 3},
			wantErr: "non-decreasing",
		},
		{
			name:    "non-monotonic step 0 -> 1",
			stair:   []int{10, 5},
			wantErr: "non-decreasing",
		},
		{
			name:    "too many steps",
			stair:   make([]int, MaxStaircaseSteps+1),
			wantErr: "max",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateStaircase(tc.stair)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %q, want substring %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// ── AdvanceStep decision matrix ─────────────────────────────────────

func TestAdvanceStep_QuotaUnderCap_StaysAndAllows(t *testing.T) {
	stair := []int{1, 5, 20, 100}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	last := now.Add(-2 * time.Hour)

	next, allowed := AdvanceStep(1, 3, last, now, stair)
	if next != 1 {
		t.Errorf("next = %d, want 1 (still on rung)", next)
	}
	if !allowed {
		t.Error("allowed = false, want true (quota under cap)")
	}
}

func TestAdvanceStep_QuotaSatisfiedSoakElapsed_AdvancesAndAllows(t *testing.T) {
	stair := []int{1, 5, 20, 100}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	// Last send 2h ago — soak (1h) has long elapsed.
	last := now.Add(-2 * time.Hour)

	next, allowed := AdvanceStep(0, 1, last, now, stair)
	if next != 1 {
		t.Errorf("next = %d, want 1 (advance)", next)
	}
	if !allowed {
		t.Error("allowed = false, want true (soak elapsed)")
	}
}

func TestAdvanceStep_QuotaSatisfiedSoakNotElapsed_StaysAndBlocks(t *testing.T) {
	stair := []int{1, 5, 20, 100}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	// Last send 30 min ago — soak window not yet elapsed.
	last := now.Add(-30 * time.Minute)

	next, allowed := AdvanceStep(1, 5, last, now, stair)
	if next != 1 {
		t.Errorf("next = %d, want 1 (do not advance during soak)", next)
	}
	if allowed {
		t.Error("allowed = true, want false (soak active)")
	}
}

func TestAdvanceStep_BoundarySoakExactlyOneHour_Advances(t *testing.T) {
	stair := []int{1, 5, 20, 100}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	// Last send exactly 1h ago — soak deadline = now → not Before(now).
	last := now.Add(-MinStaircaseSoakDuration)

	next, allowed := AdvanceStep(0, 1, last, now, stair)
	if next != 1 || !allowed {
		t.Errorf("at exact soak boundary: next=%d allowed=%v, want next=1 allowed=true", next, allowed)
	}
}

func TestAdvanceStep_BeyondLastRung_ReturnsExhausted(t *testing.T) {
	stair := []int{1, 5}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)

	next, allowed := AdvanceStep(2, 0, time.Time{}, now, stair)
	if next != 2 {
		t.Errorf("next = %d, want %d (len(stair))", next, len(stair))
	}
	if allowed {
		t.Error("allowed = true past last rung, want false (campaign exhausted)")
	}
}

func TestAdvanceStep_NegativeCurrentStep_TreatedAsZero(t *testing.T) {
	stair := []int{1, 5, 20}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)

	next, allowed := AdvanceStep(-1, 0, time.Time{}, now, stair)
	if next != 0 {
		t.Errorf("negative step: next = %d, want 0", next)
	}
	if !allowed {
		t.Error("negative step: allowed = false, want true (defensive default)")
	}
}

func TestAdvanceStep_ZeroCap_AdvancesWithoutSending(t *testing.T) {
	stair := []int{0, 5, 20}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)

	next, allowed := AdvanceStep(0, 0, time.Time{}, now, stair)
	if next != 1 {
		t.Errorf("cap=0: next = %d, want 1 (advance past dry-run rung)", next)
	}
	if allowed {
		t.Error("cap=0: allowed = true, want false (caller routes to dry-run)")
	}
}

func TestAdvanceStep_EmptyStaircase_FallsBackToDefault(t *testing.T) {
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)

	next, allowed := AdvanceStep(0, 0, time.Time{}, now, nil)
	// Default[0] = 1, sentForStep = 0 → quota under cap → stay+allow.
	if next != 0 || !allowed {
		t.Errorf("nil staircase: next=%d allowed=%v, want next=0 allowed=true", next, allowed)
	}
}

func TestAdvanceStep_QuotaSatisfiedNoLastSent_AllowsAdvance(t *testing.T) {
	stair := []int{1, 5, 20}
	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)

	// sentForStep == cap but lastSentAt zero → operator forced quota
	// manually; advance permissively.
	next, allowed := AdvanceStep(0, 1, time.Time{}, now, stair)
	if next != 1 || !allowed {
		t.Errorf("forced quota: next=%d allowed=%v, want next=1 allowed=true", next, allowed)
	}
}

// ── CapForStep boundary cases ───────────────────────────────────────

func TestCapForStep_HappyMid(t *testing.T) {
	stair := []int{1, 5, 20, 100}
	if got := CapForStep(2, stair); got != 20 {
		t.Errorf("CapForStep(2) = %d, want 20", got)
	}
}

func TestCapForStep_NegativeReturnsFirst(t *testing.T) {
	stair := []int{1, 5, 20}
	if got := CapForStep(-3, stair); got != 1 {
		t.Errorf("CapForStep(-3) = %d, want 1 (first cap)", got)
	}
}

func TestCapForStep_PastEndReturnsLast(t *testing.T) {
	stair := []int{1, 5, 20}
	if got := CapForStep(99, stair); got != 20 {
		t.Errorf("CapForStep(99) = %d, want 20 (last cap, not 0)", got)
	}
}

func TestCapForStep_EmptyStaircaseReturnsSentinel(t *testing.T) {
	if got := CapForStep(0, nil); got != -1 {
		t.Errorf("CapForStep(0, nil) = %d, want -1 (sentinel)", got)
	}
}
