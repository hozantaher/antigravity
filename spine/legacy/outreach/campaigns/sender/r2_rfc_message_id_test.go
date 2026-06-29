package sender

// R2 (docs/initiatives/2026-05-12-reply-pipeline-recovery.md) — verify
// SendResult.RFCMessageID is populated from req.Headers["Message-ID"]
// (applyAnonymityHeaders output) so the callback can persist the
// canonical RFC 5322 Message-ID into send_events.rfc_message_id, and
// the inbound matcher can attribute replies that reference it.

import "testing"

// ─── stripAngleBrackets ─────────────────────────────────────────────────────

func TestStripAngleBrackets(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"both brackets", "<abc.def@seznam.cz>", "abc.def@seznam.cz"},
		{"no brackets", "abc.def@seznam.cz", "abc.def@seznam.cz"},
		{"leading bracket only", "<abc@seznam.cz", "abc@seznam.cz"},
		{"trailing bracket only", "abc@seznam.cz>", "abc@seznam.cz"},
		{"leading/trailing whitespace", "  <abc@seznam.cz>  ", "abc@seznam.cz"},
		{"empty", "", ""},
		{"just brackets", "<>", ""},
		{"bracket pair around uuid", "<deadbeef-1234-5678@host>", "deadbeef-1234-5678@host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := stripAngleBrackets(tc.in)
			if got != tc.want {
				t.Errorf("stripAngleBrackets(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestStripAngleBrackets_Idempotent — calling stripAngleBrackets twice on
// any input must produce the same value as calling it once. Defensive
// contract: cleanMessageID in the inbound matcher relies on this so a
// row that already lost its brackets at write time isn't double-mangled.
func TestStripAngleBrackets_Idempotent(t *testing.T) {
	inputs := []string{
		"<abc@host.cz>",
		"abc@host.cz",
		"",
		"<>",
		"  spaces  ",
		"<half@host.cz",
		"half@host.cz>",
	}
	for _, in := range inputs {
		once := stripAngleBrackets(in)
		twice := stripAngleBrackets(once)
		if once != twice {
			t.Errorf("not idempotent: %q → %q → %q", in, once, twice)
		}
	}
}
