package profile

import (
	"testing"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.7 — operator-level full reset.
// ════════════════════════════════════════════════════════════════════════

// 1. ResetAll(embedded) reverts profile overrides.
func TestS27_ResetAll_RevertsOverride(t *testing.T) {
	r := loadedRegistry(t)
	r.Apply("seznam.lab", map[string]interface{}{"rate_limit_per_hour": 1})
	if err := r.ResetAll("embedded"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	if p.RateLimitPerHour == 1 {
		t.Errorf("override persisted after reset (got %d)", p.RateLimitPerHour)
	}
}

// 2. ResetAll clears rate tracker.
func TestS27_ResetAll_ClearsRate(t *testing.T) {
	r := loadedRegistry(t)
	r.RateRecord("seznam.lab", "a@seznam.lab")
	r.RateRecord("seznam.lab", "a@seznam.lab")
	if err := r.ResetAll("embedded"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	count, _, _ := r.RateCount("seznam.lab", "a@seznam.lab")
	if count != 0 {
		t.Errorf("post-reset rate count %d, want 0", count)
	}
}

// 3. ResetAll clears greylist tracker.
func TestS27_ResetAll_ClearsGreylist(t *testing.T) {
	r := loadedRegistry(t)
	// Graduate a triplet first
	r.greylist.Allow("1.2.3.4", "s@x", "r@outlook.lab")
	// Force graduation by manipulating state directly via tracker
	r.greylist.entries[tripletKey("1.2.3.4", "s@x", "r@outlook.lab")].accepted = true
	if !r.greylist.Known("1.2.3.4", "s@x", "r@outlook.lab") {
		t.Fatal("setup failed: triplet not graduated")
	}
	if err := r.ResetAll("embedded"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if r.greylist.Known("1.2.3.4", "s@x", "r@outlook.lab") {
		t.Error("post-reset greylist still graduated")
	}
}

// 4. ResetAll clears quota tracker.
func TestS27_ResetAll_ClearsQuota(t *testing.T) {
	r := loadedRegistry(t)
	r.QuotaAdd("seznam.lab", "a@seznam.lab", 999)
	if err := r.ResetAll("embedded"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	used, _, _ := r.QuotaUsage("seznam.lab", "a@seznam.lab")
	if used != 0 {
		t.Errorf("post-reset quota %d, want 0", used)
	}
}

// 5. ResetAll(embedded) reloads all 3 default profiles.
func TestS27_ResetAll_ReloadsProfiles(t *testing.T) {
	r := loadedRegistry(t)
	if err := r.ResetAll("embedded"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if got := len(r.List()); got != 3 {
		t.Errorf("post-reset profile count %d, want 3", got)
	}
}

// 6. ResetAll(invalid path) errors out.
func TestS27_ResetAll_InvalidPath_Errors(t *testing.T) {
	r := loadedRegistry(t)
	err := r.ResetAll("/path/that/does/not/exist")
	if err == nil {
		t.Error("expected error for invalid path")
	}
}

// 7. After ResetAll, Apply works on freshly-loaded profile.
func TestS27_ResetAll_AcceptsNewApply(t *testing.T) {
	r := loadedRegistry(t)
	r.ResetAll("embedded")
	out, err := r.Apply("gmail.lab", map[string]interface{}{"rate_limit_per_hour": 42})
	if err != nil {
		t.Fatalf("apply post-reset: %v", err)
	}
	if out.(*Profile).RateLimitPerHour != 42 {
		t.Error("post-reset apply did not take effect")
	}
}

// 8. ResetAll twice in a row is idempotent.
func TestS27_ResetAll_Idempotent(t *testing.T) {
	r := loadedRegistry(t)
	r.ResetAll("embedded")
	r.RateRecord("seznam.lab", "a@seznam.lab")
	r.ResetAll("embedded")
	r.ResetAll("embedded")
	count, _, _ := r.RateCount("seznam.lab", "a@seznam.lab")
	if count != 0 {
		t.Errorf("post-double-reset rate count %d, want 0", count)
	}
}

// 9. ResetAll preserves baseline profile values (per initiative table).
func TestS27_ResetAll_BaselineValues(t *testing.T) {
	r := loadedRegistry(t)
	r.Apply("seznam.lab", map[string]interface{}{
		"rate_limit_per_hour":   999,
		"max_message_size_bytes": 1,
	})
	r.ResetAll("embedded")
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	if p.RateLimitPerHour != 100 || p.MaxMessageSizeBytes != 31457280 {
		t.Errorf("baseline drift: rate=%d size=%d", p.RateLimitPerHour, p.MaxMessageSizeBytes)
	}
}

// 10. ResetAll(embedded) on freshly-created registry boots cleanly.
func TestS27_ResetAll_FromEmpty(t *testing.T) {
	r := NewRegistry()
	if err := r.ResetAll("embedded"); err != nil {
		t.Fatalf("reset on empty: %v", err)
	}
	if got := len(r.List()); got != 3 {
		t.Errorf("count %d, want 3", got)
	}
}
