package sender

import (
	"strings"
	"testing"

	"common/config"
)

// TestPickMailbox_SkipsSelfSend confirms that pickMailbox refuses to use a
// mailbox whose own address matches the recipient. Without this guard, a
// campaign that enrolls one of our own mailboxes as a recipient (intentional
// internal end-to-end test, or unintentional misconfiguration) would have
// the relay send mb→mb — IMAP poller then sees the same message in both
// Sent and Inbox, reply classification runs against the sender's own
// outbound copy, and observability surfaces a phantom "self-reply".
func TestPickMailbox_SkipsSelfSend(t *testing.T) {
	tests := []struct {
		name        string
		recipient   string
		mailboxes   []config.MailboxConfig
		expectAddr  string
		expectError bool
	}{
		{
			name:      "single mailbox is recipient — error (no other to pick)",
			recipient: "a.mazher@email.cz",
			mailboxes: []config.MailboxConfig{
				{Address: "a.mazher@email.cz", DailyLimit: 50},
			},
			expectError: true,
		},
		{
			name:      "rotates past self to second mailbox",
			recipient: "a.mazher@email.cz",
			mailboxes: []config.MailboxConfig{
				{Address: "a.mazher@email.cz", DailyLimit: 50},
				{Address: "b.maarek@email.cz", DailyLimit: 50},
			},
			expectAddr: "b.maarek@email.cz",
		},
		{
			name:      "case-insensitive match still skips self",
			recipient: "A.MAZHER@email.cz",
			mailboxes: []config.MailboxConfig{
				{Address: "a.mazher@email.cz", DailyLimit: 50},
				{Address: "b.maarek@email.cz", DailyLimit: 50},
			},
			expectAddr: "b.maarek@email.cz",
		},
		{
			name:      "empty recipient skips guard (caller opt-out)",
			recipient: "",
			mailboxes: []config.MailboxConfig{
				{Address: "a.mazher@email.cz", DailyLimit: 50},
			},
			expectAddr: "a.mazher@email.cz",
		},
		{
			name:      "non-self recipient unaffected",
			recipient: "external@firma.cz",
			mailboxes: []config.MailboxConfig{
				{Address: "a.mazher@email.cz", DailyLimit: 50},
			},
			expectAddr: "a.mazher@email.cz",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := NewEngine(tt.mailboxes, config.SendingConfig{
				Timezone:    "UTC",
				WindowStart: 0,
				WindowEnd:   24,
			}, config.SafetyConfig{})

			mb, err := e.pickMailbox(tt.recipient)
			if tt.expectError {
				if err == nil {
					t.Fatalf("expected error, got mb=%s", mb.Address)
				}
				if !strings.Contains(err.Error(), "daily limit") {
					t.Fatalf("expected fallthrough error, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if mb.Address != tt.expectAddr {
				t.Errorf("got mb=%s, want %s", mb.Address, tt.expectAddr)
			}
		})
	}
}
