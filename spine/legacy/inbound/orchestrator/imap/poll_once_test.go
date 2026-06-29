package imap

import (
	"context"
	"testing"

	"common/config"
)

// TestPollOnce_NoMailboxes verifies the trivial empty case.
func TestPollOnce_NoMailboxes(t *testing.T) {
	p := NewPoller(nil, nil)
	results, err := p.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

// TestPollOnce_EmptyIMAPHost covers the skip branch (IMAPHost == "").
func TestPollOnce_EmptyIMAPHost(t *testing.T) {
	mb := config.MailboxConfig{Address: "a@test.local", IMAPHost: "", IMAPPort: 0}
	p := NewPoller([]config.MailboxConfig{mb}, nil)
	results, err := p.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Mailbox skipped — no result appended.
	if len(results) != 0 {
		t.Errorf("expected 0 results (skipped), got %d", len(results))
	}
}

// TestPollOnce_FetchError_CancelledContext covers the fetchNewMessages error
// branch: a pre-cancelled context makes runWithReconnect exit immediately,
// fetchNewMessages returns context.Canceled, and PollOnce records Errors=1.
func TestPollOnce_FetchError_CancelledContext(t *testing.T) {
	mb := config.MailboxConfig{
		Address:  "test@test.local",
		IMAPHost: "127.0.0.1",
		IMAPPort: 143,
	}
	p := NewPoller([]config.MailboxConfig{mb}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before PollOnce — makes runWithReconnect exit immediately

	results, err := p.PollOnce(ctx)
	if err != nil {
		t.Fatalf("PollOnce should not propagate error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Errors != 1 {
		t.Errorf("expected Errors=1, got %d", results[0].Errors)
	}
	if results[0].Mailbox != "test@test.local" {
		t.Errorf("unexpected mailbox: %s", results[0].Mailbox)
	}
}
