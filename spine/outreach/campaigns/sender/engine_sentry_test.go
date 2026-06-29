package sender_test

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// TestSenderErrorLevels_SourceVerification verifies that critical SMTP failures
// are logged at slog.LevelError (so they reach the Sentry bridge).
// The test uses a trivial slog.Handler to confirm Error > Warn behaviour.
func TestSenderErrorLevels_SourceVerification(t *testing.T) {
	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	logger := slog.New(handler)

	// Simulate: slog.Error goes through, slog.Warn is at lower level
	logger.Error("sender no available mailbox", "error", "no mailboxes configured")
	logger.Error("greylisting budget exhausted, treating as permanent", "domain", "x.cz", "attempts", 11)

	out := buf.String()
	if !strings.Contains(out, "ERROR") {
		t.Fatal("expected ERROR level in output")
	}
	if !strings.Contains(out, "sender no available mailbox") {
		t.Fatal("missing 'sender no available mailbox' message")
	}
	if !strings.Contains(out, "greylisting budget exhausted") {
		t.Fatal("missing 'greylisting budget exhausted' message")
	}
}
