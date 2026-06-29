package enrich

import "testing"

// ── Suppression Reason Constants ──

func TestSuppressionReason_Constants(t *testing.T) {
	reasons := []SuppressionReason{
		SuppressHardBounce, SuppressComplaint, SuppressUnsubscribe,
		SuppressNegativeReply, SuppressManual, SuppressHoneypot,
	}
	seen := make(map[SuppressionReason]bool)
	for _, r := range reasons {
		if seen[r] { t.Errorf("duplicate: %s", r) }
		seen[r] = true
		if r == "" { t.Error("empty reason") }
	}
	if len(reasons) != 6 { t.Errorf("expected 6 reasons, got %d", len(reasons)) }
}

func TestSuppressionReason_Values(t *testing.T) {
	if SuppressHardBounce != "hard_bounce" { t.Error("hard_bounce") }
	if SuppressComplaint != "complaint" { t.Error("complaint") }
	if SuppressUnsubscribe != "unsubscribe" { t.Error("unsubscribe") }
	if SuppressNegativeReply != "negative_reply" { t.Error("negative_reply") }
	if SuppressManual != "manual" { t.Error("manual") }
	if SuppressHoneypot != "honeypot" { t.Error("honeypot") }
}
