package thread

import (
	"testing"
)

// TestIsTestMessage verifies the R5 test message filter recognizes internal
// test/smoke message prefixes before they can pollute unmatched_inbound.
func TestIsTestMessage(t *testing.T) {
	tests := []struct {
		name    string
		subject string
		want    bool
	}{
		// Happy path — test prefixes
		{"[smoke] prefix", "[smoke] Test outreach", true},
		{"[smoke-clean] prefix", "[smoke-clean] Another test", true},
		{"[hdr-test] prefix", "[hdr-test] Header validation", true},
		{"[test-A] prefix", "[test-A] Variant A", true},
		{"[test-B] prefix", "[test-B] Variant B", true},
		{"[test] prefix", "[test] Generic test", true},
		{"probe prefix", "probe Automated check", true},

		// Case-insensitive matching
		{"[SMOKE] uppercase", "[SMOKE] Test outreach", true},
		{"[SmOkE] mixed case", "[SmOkE] Test outreach", true},
		{"PROBE prefix uppercase", "PROBE Automated check", true},

		// Substring matching (anywhere in subject)
		{"[smoke] mid-subject", "Re: [smoke] test reply", true},
		{"probe mid-subject", "Your probe results here", true},

		// Non-test subjects — should return false
		{"normal reply", "Re: Question about deliverability", false},
		{"customer email", "Let's schedule a meeting", false},
		{"empty subject", "", false},
		{"similar but not test", "[smok] Typo in prefix", false},
		{"probe as domain", "probe.cz response", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isTestMessage(tt.subject)
			if got != tt.want {
				t.Errorf("isTestMessage(%q) = %v, want %v", tt.subject, got, tt.want)
			}
		})
	}
}

// TestTruncateSubject verifies safe truncation for logging.
func TestTruncateSubject(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		n      int
		expect string
	}{
		{"short string no truncate", "hello", 10, "hello"},
		{"exact length", "hello", 5, "hello"},
		{"truncate to 3", "hello", 3, "hel"},
		{"empty string", "", 10, ""},
		{"long subject line", "Re: Question about our sales proposal and deliverability", 20, "Re: Question about o"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncateSubject(tt.input, tt.n)
			if got != tt.expect {
				t.Errorf("truncateSubject(%q, %d) = %q, want %q", tt.input, tt.n, got, tt.expect)
			}
		})
	}
}
