package mailbox

import "testing"

// TestIsPlaceholderPassword_DetectsKnownBadValues locks the invariant that
// placeholder / default credentials (like the "123p123p123p123" value that
// shipped into outreach_mailboxes during the 2026-04-22 debug session) are
// never accepted as legitimate SMTP AUTH material. This test is the RED
// half of the TDD cycle for SEND-S6.1.
//
// Important: we never put a real mailbox password in this test. Every value
// here is either a known-bad placeholder or a synthetic realistic-shape
// string that must not match the detector.
func TestIsPlaceholderPassword_DetectsKnownBadValues(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		input string
		want  bool
	}{
		// --- known-bad placeholders (MUST be detected) ---
		{name: "known_bad_123p_repeated_15char", input: "123p123p123p123", want: true},
		{name: "known_bad_123p_prefix_short", input: "123p123p", want: true},
		{name: "xxxx_repeated_char_pattern", input: "xxxx", want: true},
		{name: "empty_string", input: "", want: true},
		{name: "too_short_abc", input: "abc", want: true},

		// --- realistic passwords (MUST NOT be detected) ---
		{name: "realistic_mixed_secret", input: "S3cr3tP@ss2026!", want: false},
		{name: "realistic_app_password_format", input: "app-xxxx-yyyy-zzzz", want: false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := IsPlaceholderPassword(tc.input)
			if got != tc.want {
				t.Fatalf("IsPlaceholderPassword(<redacted %d chars>) = %v, want %v",
					len(tc.input), got, tc.want)
			}
		})
	}
}
