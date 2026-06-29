package campaign_test

import (
	"testing"
	"testing/quick"

	"campaigns/campaign"
)

func TestEmailStatusAllowed_AllowedStatuses(t *testing.T) {
	allowed := []string{"valid"}
	for _, s := range allowed {
		if !campaign.EmailStatusAllowed(s) {
			t.Errorf("EmailStatusAllowed(%q) should be true", s)
		}
	}
}

func TestEmailStatusAllowed_BlockedStatuses(t *testing.T) {
	blocked := []string{"unverified", "invalid", "bounced", "disposable", "spamtrap", "risky", "catch_all", "role_only", "no_email", ""}
	for _, s := range blocked {
		if campaign.EmailStatusAllowed(s) {
			t.Errorf("EmailStatusAllowed(%q) should be false", s)
		}
	}
}

func TestEmailStatusAllowed_NeverPanics_Property(t *testing.T) {
	f := func(status string) bool {
		defer func() { recover() }()
		campaign.EmailStatusAllowed(status)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("EmailStatusAllowed panicked: %v", err)
	}
}

func TestEmailStatusAllowed_OutputIsBool_Property(t *testing.T) {
	f := func(status string) bool {
		result := campaign.EmailStatusAllowed(status)
		return result == true || result == false // always a bool
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("unexpected: %v", err)
	}
}

func TestEmailStatusAllowed_CaseSensitive(t *testing.T) {
	// "VALID" is NOT the same as "valid" — gate is case-sensitive
	if campaign.EmailStatusAllowed("VALID") {
		t.Error("EmailStatusAllowed should be case-sensitive: VALID != valid")
	}
	if campaign.EmailStatusAllowed("Valid") {
		t.Error("EmailStatusAllowed should be case-sensitive: Valid != valid")
	}
}
