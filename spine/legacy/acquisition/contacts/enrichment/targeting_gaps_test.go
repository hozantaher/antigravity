package enrich

import "testing"

// ── EmailVerificationStatus switch cases ──

func TestTargetingScore_Invalid_SpamtrapNoEmail(t *testing.T) {
	for _, status := range []string{"invalid", "spamtrap", "no_email"} {
		_, f := CalculateTargeting(TargetingInput{EmailVerificationStatus: status})
		if f.EmailQuality != -1.0 {
			t.Errorf("%s EmailQuality = %.2f, want -1.00", status, f.EmailQuality)
		}
	}
}

func TestTargetingScore_CatchAll(t *testing.T) {
	score, f := CalculateTargeting(TargetingInput{EmailVerificationStatus: "catch_all"})
	if f.EmailQuality != -0.3 {
		t.Errorf("catch_all EmailQuality = %.2f, want -0.30", f.EmailQuality)
	}
	_ = score
}

func TestTargetingScore_RoleOnly(t *testing.T) {
	_, f := CalculateTargeting(TargetingInput{EmailVerificationStatus: "role_only"})
	if f.EmailQuality != -0.15 {
		t.Errorf("role_only EmailQuality = %.2f, want -0.15", f.EmailQuality)
	}
}

func TestTargetingScore_Risky(t *testing.T) {
	_, f := CalculateTargeting(TargetingInput{EmailVerificationStatus: "risky"})
	if f.EmailQuality != -0.1 {
		t.Errorf("risky EmailQuality = %.2f, want -0.10", f.EmailQuality)
	}
}

func TestTargetingScore_Unverified(t *testing.T) {
	_, f := CalculateTargeting(TargetingInput{EmailVerificationStatus: "unverified"})
	if f.EmailQuality != -0.05 {
		t.Errorf("unverified EmailQuality = %.2f, want -0.05", f.EmailQuality)
	}
}

// ── Engagement: opened > sent guard (line 141) ──
// Data inconsistency: TotalOpened > TotalSent → opened clamped to TotalSent.

func TestTargetingScore_OpenedExceedsSent(t *testing.T) {
	// TotalOpened > TotalSent — should be clamped, not panic
	_, f := CalculateTargeting(TargetingInput{
		TotalSent:   3,
		TotalOpened: 10, // inconsistent: opened > sent
		TotalBounced:  0,
		TotalReplied:  0,
	})
	// With clamping: opened = 3 (= TotalSent), ghostRatio = (3-3)/3 = 0 → no ghost penalty
	if f.Engagement < -0.5 {
		t.Errorf("engagement = %.2f, expected clamped ghost ratio → no heavy penalty", f.Engagement)
	}
}
