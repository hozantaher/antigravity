package mailbox

import (
	"testing"
	"time"
)

func TestShouldRelease_StandardWindow(t *testing.T) {
	cfg := AdaptiveReleaseConfig{}.WithDefaults()
	tests := []struct {
		name     string
		held     float64
		sent7d   int
		adaptive bool
		want     bool
		reason   string
	}{
		{"under 7d, no adaptive", 100, 200, false, false, ""},
		{"at 7d", 7 * 24, 200, false, true, "standard_window_168h"},
		{"over 7d", 10 * 24, 200, false, true, "standard_window_168h"},
		{"low-volume at 72h, adaptive off", 72, 10, false, false, ""},
		{"low-volume at 72h, adaptive on", 72, 10, true, true, "adaptive_low_volume_72h"},
		{"high-volume at 72h, adaptive on", 72, 200, true, false, ""},
		{"low-volume at 48h, adaptive on", 48, 10, true, false, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := ReleaseCandidate{
				HeldHours:        tc.held,
				Sent7d:           tc.sent7d,
				AdaptiveEligible: tc.sent7d < cfg.LowVolumeThreshold,
			}
			c2 := c
			if got := c2.ShouldRelease(AdaptiveReleaseConfig{AdaptiveEnable: tc.adaptive}); got != tc.want {
				t.Errorf("ShouldRelease = %v, want %v (held=%.0fh, sent7d=%d)", got, tc.want, tc.held, tc.sent7d)
			}
			if tc.want && c2.ReleaseReason != tc.reason {
				t.Errorf("reason = %q, want %q", c2.ReleaseReason, tc.reason)
			}
		})
	}
}

func TestShouldRelease_AdaptiveRespectsThreshold(t *testing.T) {
	cfg := AdaptiveReleaseConfig{
		AdaptiveEnable:     true,
		LowVolumeThreshold: 20,
		FastWindow:         48 * time.Hour,
	}.WithDefaults()

	c := ReleaseCandidate{
		HeldHours:        cfg.FastWindow.Hours(),
		Sent7d:           15,
		AdaptiveEligible: true,
	}
	if !c.ShouldRelease(cfg) {
		t.Fatal("low-volume at exactly FastWindow should release")
	}
	if c.ReleaseWindowHours != 48 {
		t.Errorf("ReleaseWindowHours = %d, want 48", c.ReleaseWindowHours)
	}
}

func TestShouldRelease_NeverReleasesBeforeWindow(t *testing.T) {
	c := ReleaseCandidate{
		HeldHours:        23,
		Sent7d:           5,
		AdaptiveEligible: true,
	}
	if c.ShouldRelease(AdaptiveReleaseConfig{AdaptiveEnable: true}.WithDefaults()) {
		t.Fatal("held 23h should never release regardless of volume")
	}
}
