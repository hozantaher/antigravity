package mailbox

import (
	"fmt"
	"testing"
	"time"
)

// ─── AdaptiveReleaseConfig.WithDefaults ─────────────────────────────────

func TestWithDefaults_AllZeroFilled(t *testing.T) {
	c := AdaptiveReleaseConfig{}.WithDefaults()
	if c.StandardWindow != 7*24*time.Hour {
		t.Errorf("StandardWindow default: got %v, want 168h", c.StandardWindow)
	}
	if c.FastWindow != 72*time.Hour {
		t.Errorf("FastWindow default: got %v, want 72h", c.FastWindow)
	}
	if c.LowVolumeThreshold != 50 {
		t.Errorf("LowVolumeThreshold default: got %d, want 50", c.LowVolumeThreshold)
	}
	if c.CanaryCount != 10 {
		t.Errorf("CanaryCount default: got %d, want 10", c.CanaryCount)
	}
}

func TestWithDefaults_PreservesNonZero(t *testing.T) {
	orig := AdaptiveReleaseConfig{
		AdaptiveEnable:     true,
		StandardWindow:     14 * 24 * time.Hour,
		FastWindow:         48 * time.Hour,
		LowVolumeThreshold: 25,
		CanaryCount:        3,
	}
	got := orig.WithDefaults()
	if got != orig {
		t.Errorf("WithDefaults overwrote non-zero values:\n  got  %+v\n  want %+v", got, orig)
	}
}

func TestWithDefaults_PartialFields(t *testing.T) {
	cases := []struct {
		name string
		in   AdaptiveReleaseConfig
	}{
		{"only StandardWindow", AdaptiveReleaseConfig{StandardWindow: 5 * 24 * time.Hour}},
		{"only FastWindow", AdaptiveReleaseConfig{FastWindow: 24 * time.Hour}},
		{"only LowVolumeThreshold", AdaptiveReleaseConfig{LowVolumeThreshold: 10}},
		{"only CanaryCount", AdaptiveReleaseConfig{CanaryCount: 5}},
		{"AdaptiveEnable only", AdaptiveReleaseConfig{AdaptiveEnable: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.in.WithDefaults()
			// Any zero field in input should be filled.
			if got.StandardWindow <= 0 {
				t.Errorf("StandardWindow <= 0: %v", got.StandardWindow)
			}
			if got.FastWindow <= 0 {
				t.Errorf("FastWindow <= 0: %v", got.FastWindow)
			}
			if got.LowVolumeThreshold <= 0 {
				t.Errorf("LowVolumeThreshold <= 0: %d", got.LowVolumeThreshold)
			}
			if got.CanaryCount <= 0 {
				t.Errorf("CanaryCount <= 0: %d", got.CanaryCount)
			}
		})
	}
}

func TestWithDefaults_NegativesTreatedAsZero(t *testing.T) {
	c := AdaptiveReleaseConfig{
		StandardWindow:     -10 * time.Hour,
		FastWindow:         -5 * time.Hour,
		LowVolumeThreshold: -1,
		CanaryCount:        -3,
	}.WithDefaults()
	if c.StandardWindow != 7*24*time.Hour {
		t.Errorf("negative StandardWindow not defaulted: %v", c.StandardWindow)
	}
	if c.FastWindow != 72*time.Hour {
		t.Errorf("negative FastWindow not defaulted: %v", c.FastWindow)
	}
	if c.LowVolumeThreshold != 50 {
		t.Errorf("negative LowVolumeThreshold not defaulted: %d", c.LowVolumeThreshold)
	}
	if c.CanaryCount != 10 {
		t.Errorf("negative CanaryCount not defaulted: %d", c.CanaryCount)
	}
}

func TestWithDefaults_Idempotent(t *testing.T) {
	a := AdaptiveReleaseConfig{}.WithDefaults()
	b := a.WithDefaults()
	if a != b {
		t.Errorf("WithDefaults not idempotent:\n  a=%+v\n  b=%+v", a, b)
	}
}

// ─── ShouldRelease exhaustive matrix ────────────────────────────────────

func TestShouldRelease_ExhaustiveMatrix(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()
	std := cfg.StandardWindow.Hours()  // 168
	fast := cfg.FastWindow.Hours()     // 72
	thr := cfg.LowVolumeThreshold      // 50

	cases := []struct {
		heldHours float64
		sent7d    int
		want      bool
	}{
		// Well below both windows.
		{0, 0, false},
		{0.01, 0, false},
		{1, 100, false},
		{24, 10, false},
		{48, 10, false},
		{71, 10, false},
		{71.999, 10, false},
		// Hit fast window exactly (low volume).
		{fast, thr - 1, true},
		{fast, 0, true},
		{fast + 0.01, 1, true},
		{fast * 2, 10, true},
		// Fast window elapsed but high volume → must wait for standard.
		{fast, thr, false},
		{fast, thr + 1, false},
		{fast, 1000, false},
		{100, 1000, false},
		{std - 1, 1000, false},
		// Hit standard window regardless of volume.
		{std, 0, true},
		{std, thr, true},
		{std, 10_000, true},
		{std + 0.01, 10_000, true},
		{std * 2, 10_000, true},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprintf("held=%.2f/sent7d=%d", tc.heldHours, tc.sent7d), func(t *testing.T) {
			c := ReleaseCandidate{
				HeldHours:        tc.heldHours,
				Sent7d:           tc.sent7d,
				AdaptiveEligible: tc.sent7d < thr,
			}
			got := c.ShouldRelease(cfg)
			if got != tc.want {
				t.Errorf("case[%d] got %v want %v", i, got, tc.want)
			}
			// When ShouldRelease returns true, it must stamp reason + window.
			if got {
				if c.ReleaseReason == "" {
					t.Error("ShouldRelease true but ReleaseReason empty")
				}
				if c.ReleaseWindowHours <= 0 {
					t.Errorf("ReleaseWindowHours should be positive, got %d", c.ReleaseWindowHours)
				}
			} else {
				if c.ReleaseReason != "" {
					t.Errorf("ShouldRelease false but ReleaseReason set: %q", c.ReleaseReason)
				}
			}
		})
	}
}

func TestShouldRelease_AdaptiveDisabledIgnoresFastWindow(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: false}.WithDefaults()
	c := ReleaseCandidate{
		HeldHours:        100, // past fast (72), before standard (168)
		Sent7d:           5,
		AdaptiveEligible: true,
	}
	if c.ShouldRelease(cfg) {
		t.Error("adaptive disabled: must not release before standard window")
	}
}

func TestShouldRelease_AdaptiveIneligibleIgnoresFastWindow(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()
	c := ReleaseCandidate{
		HeldHours:        100, // past fast but not standard
		Sent7d:           500,
		AdaptiveEligible: false, // operator flagged ineligible
	}
	if c.ShouldRelease(cfg) {
		t.Error("adaptive ineligible: must not release before standard window")
	}
}

func TestShouldRelease_StandardWindowStampsCorrectReason(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()
	c := ReleaseCandidate{HeldHours: 200, Sent7d: 0, AdaptiveEligible: true}
	if !c.ShouldRelease(cfg) {
		t.Fatal("expected release")
	}
	// Even when adaptive is eligible, if both windows pass, the function
	// picks standard (168) first because the code checks standard before fast.
	if c.ReleaseWindowHours != 168 {
		t.Errorf("ReleaseWindowHours = %d, want 168 (standard wins when both match)", c.ReleaseWindowHours)
	}
}

func TestShouldRelease_FastWindowStampsCorrectReason(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()
	c := ReleaseCandidate{HeldHours: 80, Sent7d: 5, AdaptiveEligible: true}
	if !c.ShouldRelease(cfg) {
		t.Fatal("expected release")
	}
	if c.ReleaseWindowHours != 72 {
		t.Errorf("ReleaseWindowHours = %d, want 72", c.ReleaseWindowHours)
	}
	if c.ReleaseReason != "adaptive_low_volume_72h" {
		t.Errorf("ReleaseReason = %q, want adaptive_low_volume_72h", c.ReleaseReason)
	}
}

func TestShouldRelease_CustomWindows(t *testing.T) {
	cfg := AdaptiveReleaseConfig{
		AdaptiveEnable:     true,
		StandardWindow:     14 * 24 * time.Hour,
		FastWindow:         36 * time.Hour,
		LowVolumeThreshold: 20,
	}.WithDefaults()

	// Low volume at 40h → should release on fast
	c1 := ReleaseCandidate{HeldHours: 40, Sent7d: 10, AdaptiveEligible: true}
	if !c1.ShouldRelease(cfg) {
		t.Error("custom 36h fast window: 40h held, sent7d=10 should release")
	}
	if c1.ReleaseWindowHours != 36 {
		t.Errorf("custom ReleaseWindowHours = %d, want 36", c1.ReleaseWindowHours)
	}
	// Low volume at 35h (before fast) → hold
	c2 := ReleaseCandidate{HeldHours: 35, Sent7d: 10, AdaptiveEligible: true}
	if c2.ShouldRelease(cfg) {
		t.Error("35h held (below 36h custom fast): should NOT release")
	}
	// High volume at 40h but below 14 days → hold
	c3 := ReleaseCandidate{HeldHours: 40, Sent7d: 100, AdaptiveEligible: false}
	if c3.ShouldRelease(cfg) {
		t.Error("high volume at 40h: should wait for 14-day standard")
	}
	// High volume at 14 days → release on standard
	c4 := ReleaseCandidate{HeldHours: 14 * 24, Sent7d: 100, AdaptiveEligible: false}
	if !c4.ShouldRelease(cfg) {
		t.Error("high volume at 14d: should release via standard")
	}
	if c4.ReleaseWindowHours != 14*24 {
		t.Errorf("ReleaseWindowHours = %d, want %d", c4.ReleaseWindowHours, 14*24)
	}
}

func TestShouldRelease_BoundaryExactWindows(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()
	// Exact standard window boundary.
	c := ReleaseCandidate{HeldHours: 168, AdaptiveEligible: false}
	if !c.ShouldRelease(cfg) {
		t.Error("exactly 168h held (standard): should release")
	}
	// 1µs below 168, adaptive eligible at fast → fast path
	c2 := ReleaseCandidate{HeldHours: 167.999999, Sent7d: 5, AdaptiveEligible: true}
	if !c2.ShouldRelease(cfg) {
		t.Error("167.999h + adaptive eligible: should release via fast")
	}
}

func TestShouldRelease_DoesNotMutateOnFalse(t *testing.T) {
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()
	c := ReleaseCandidate{
		HeldHours:        10,
		Sent7d:           5,
		AdaptiveEligible: true,
		ReleaseReason:    "pre-existing",
		ReleaseWindowHours: 99,
	}
	snap := c
	if c.ShouldRelease(cfg) {
		t.Fatal("10h held: should not release")
	}
	// Should NOT overwrite pre-existing reason when returning false.
	if c.ReleaseReason != snap.ReleaseReason {
		t.Errorf("ReleaseReason mutated on false: was %q, is %q", snap.ReleaseReason, c.ReleaseReason)
	}
	if c.ReleaseWindowHours != snap.ReleaseWindowHours {
		t.Errorf("ReleaseWindowHours mutated on false: was %d, is %d", snap.ReleaseWindowHours, c.ReleaseWindowHours)
	}
}

func TestShouldRelease_AdaptiveEligibleFieldRespected(t *testing.T) {
	// Caller may pre-compute AdaptiveEligible regardless of threshold in config.
	// ShouldRelease should trust the field, not re-derive from sent7d.
	cfg := AdaptiveReleaseConfig{AdaptiveEnable: true, LowVolumeThreshold: 10}.WithDefaults()
	// sent7d > threshold but operator forced AdaptiveEligible=true
	c := ReleaseCandidate{
		HeldHours:        80,
		Sent7d:           1000,
		AdaptiveEligible: true,
	}
	if !c.ShouldRelease(cfg) {
		t.Error("AdaptiveEligible=true should be trusted even when sent7d > threshold")
	}
	// sent7d < threshold but AdaptiveEligible=false
	c2 := ReleaseCandidate{
		HeldHours:        80,
		Sent7d:           0,
		AdaptiveEligible: false,
	}
	if c2.ShouldRelease(cfg) {
		t.Error("AdaptiveEligible=false should block fast release even with low sent7d")
	}
}

// Matrix: window exact × {adaptive on/off} × {eligible T/F} × ... sub-cases.
func TestShouldRelease_FourWayMatrix(t *testing.T) {
	cfg := AdaptiveReleaseConfig{}.WithDefaults()
	hours := []float64{0, 24, 72, 100, 168, 200}
	enables := []bool{false, true}
	eligibles := []bool{false, true}

	for _, h := range hours {
		for _, en := range enables {
			for _, el := range eligibles {
				name := fmt.Sprintf("h=%.0f/en=%v/el=%v", h, en, el)
				t.Run(name, func(t *testing.T) {
					c := ReleaseCandidate{
						HeldHours:        h,
						AdaptiveEligible: el,
					}
					cfg2 := cfg
					cfg2.AdaptiveEnable = en
					got := c.ShouldRelease(cfg2)

					// Expected:
					// - true if h >= 168
					// - OR (en && el && h >= 72)
					var want bool
					if h >= 168 {
						want = true
					} else if en && el && h >= 72 {
						want = true
					}
					if got != want {
						t.Errorf("got %v want %v (h=%.0f en=%v el=%v)", got, want, h, en, el)
					}
				})
			}
		}
	}
}
