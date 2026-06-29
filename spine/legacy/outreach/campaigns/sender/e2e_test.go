package sender

import (
	"common/config"
	"strings"
	"testing"
)

// ══════════════════════════════════════════
//  E2E: Content → Humanize Headers → buildMessage
// ══════════════════════════════════════════

func TestE2E_BuildMessage_HumanizedEmail(t *testing.T) {
	// Simulate humanize output → buildMessage
	humanizeHeaders := map[string]string{
		"X-Mailer":                  "Seznam.cz",
		"Date":                      "Tue, 07 Apr 2026 10:00:00 +0200",
		"Message-ID":                "<abc123def456@email.seznam.cz>",
		"Content-Type":              "text/plain; charset=utf-8",
		"Content-Transfer-Encoding": "quoted-printable",
		"List-Unsubscribe":          "<https://example.com/unsub?t=xyz>",
		"List-Unsubscribe-Post":     "List-Unsubscribe=One-Click",
	}

	msg := buildMessage(
		"jan@technotrade.cz",
		"info@target-firma.cz",
		"Poptavka stroju",
		"Dobry den,\n\nHledame dodavatele CNC stroju.\n\nJan Novak\nTel: +420123",
		"<html><body><div style=\"font-family: Arial;\">Dobry den,<br><br>Hledame dodavatele CNC stroju.<br><br>Jan Novak<br>Tel: +420123</div></body></html>",
		humanizeHeaders,
		"<abc123def456@email.seznam.cz>",
	)

	s := string(msg)

	// Standard headers
	if !strings.Contains(s, "From: jan@technotrade.cz") {
		t.Error("missing From")
	}
	if !strings.Contains(s, "To: info@target-firma.cz") {
		t.Error("missing To")
	}
	if !strings.Contains(s, "Subject: Poptavka stroju") {
		t.Error("missing Subject")
	}

	// Humanize headers
	if !strings.Contains(s, "X-Mailer: Seznam.cz") {
		t.Error("missing X-Mailer")
	}
	if !strings.Contains(s, "Date: Tue, 07 Apr 2026") {
		t.Error("missing humanize Date")
	}
	if !strings.Contains(s, "List-Unsubscribe:") {
		t.Error("missing List-Unsubscribe")
	}
	if !strings.Contains(s, "List-Unsubscribe-Post:") {
		t.Error("missing List-Unsubscribe-Post")
	}

	// Message-ID from humanize (not auto-generated)
	if !strings.Contains(s, "Message-ID: <abc123def456@email.seznam.cz>") {
		t.Error("should use humanize Message-ID")
	}

	// Multipart structure
	if !strings.Contains(s, "multipart/alternative") {
		t.Error("should be multipart when HTML body provided")
	}
	if !strings.Contains(s, "text/plain") {
		t.Error("missing plain text part")
	}
	if !strings.Contains(s, "text/html") {
		t.Error("missing HTML part")
	}

	// No duplicate standard headers
	fromCount := strings.Count(s, "\r\nFrom:")
	if fromCount > 0 { // one in initial, none extra
		toCount := strings.Count(s, "\r\nTo:")
		if toCount > 1 {
			t.Error("duplicate To header")
		}
	}

	// Content present in both parts
	if !strings.Contains(s, "CNC stroju") {
		t.Error("missing body content")
	}
}

func TestE2E_BuildMessage_PlainOnly_NoHumanize(t *testing.T) {
	// Without humanize — just content engine output
	contentHeaders := map[string]string{
		"List-Unsubscribe":      "<https://example.com/unsub>",
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	}

	msg := buildMessage(
		"sender@firma.cz", "recipient@target.cz",
		"Subject Line", "Plain body text only.", "",
		contentHeaders, "generated-id@firma.cz",
	)

	s := string(msg)

	// Should be plain text only (no multipart)
	if strings.Contains(s, "multipart") {
		t.Error("should not be multipart without HTML")
	}
	if !strings.Contains(s, "text/plain; charset=utf-8") {
		t.Error("should be text/plain")
	}
	if !strings.Contains(s, "Plain body text only.") {
		t.Error("missing body")
	}
	if !strings.Contains(s, "List-Unsubscribe:") {
		t.Error("missing content header")
	}
}

// ══════════════════════════════════════════
//  E2E: Sender Queue + Mailbox Rotation
// ══════════════════════════════════════════

func TestE2E_Sender_FullQueueCycle(t *testing.T) {
	mbs := []config.MailboxConfig{
		{Address: "mb1@firma.cz", DailyLimit: 50},
		{Address: "mb2@firma.cz", DailyLimit: 50},
		{Address: "mb3@firma.cz", DailyLimit: 50},
	}

	engine := NewEngine(mbs, config.SendingConfig{
		MaxPerDomainHour: 5,
		MinDelaySeconds:  1,
		MaxDelaySeconds:  2,
	}, config.SafetyConfig{MaxBounceRate: 0.1})

	// Enqueue 6 requests
	for i := 1; i <= 6; i++ {
		engine.Enqueue(SendRequest{
			CampaignID: 1,
			ContactID:  int64(i),
			Step:       0,
			ToAddress:  "contact" + string(rune('0'+i)) + "@target.cz",
			Subject:    "Test",
			BodyPlain:  "Body",
		})
	}

	if engine.QueueDepth() != 6 {
		t.Fatalf("queue depth: %d, want 6", engine.QueueDepth())
	}

	// Dequeue and pick mailboxes (round-robin)
	mailboxes := []string{}
	for i := 0; i < 6; i++ {
		req, ok := engine.dequeue()
		if !ok {
			t.Fatalf("dequeue %d failed", i)
		}
		mb, err := engine.pickMailbox("")
		if err != nil {
			t.Fatalf("pickMailbox %d: %v", i, err)
		}
		mailboxes = append(mailboxes, mb.Address)
		engine.recordSend(mb.Address, "target.cz", false)
		_ = req
	}

	// Should rotate through all 3 mailboxes
	mbCounts := map[string]int{}
	for _, mb := range mailboxes {
		mbCounts[mb]++
	}
	if len(mbCounts) != 3 {
		t.Errorf("should use all 3 mailboxes, used %d: %v", len(mbCounts), mbCounts)
	}

	// Queue should be empty
	if engine.QueueDepth() != 0 {
		t.Errorf("queue should be empty, got %d", engine.QueueDepth())
	}
}

func TestE2E_Sender_CircuitBreaker_StopsSending(t *testing.T) {
	engine := NewEngine(
		[]config.MailboxConfig{{Address: "mb@f.cz", DailyLimit: 100}},
		config.SendingConfig{MaxPerDomainHour: 100},
		config.SafetyConfig{MaxBounceRate: 0.05},
	)

	// 20 sends, 2 bounces = 10% > 5% threshold
	for i := 0; i < 18; i++ {
		engine.recordSend("mb@f.cz", "d.cz", false)
	}
	for i := 0; i < 2; i++ {
		engine.recordSend("mb@f.cz", "d.cz", true)
	}

	if !engine.isCircuitOpen() {
		t.Error("circuit should be open at 10% bounce rate (threshold 5%)")
	}

	// Mailbox should still be pickable (circuit breaker is checked in Run loop)
	_, err := engine.pickMailbox("")
	if err != nil {
		t.Error("pickMailbox should still work, circuit check is in Run")
	}
}

func TestE2E_Sender_DomainLimit_Enforcement(t *testing.T) {
	engine := NewEngine(nil, config.SendingConfig{MaxPerDomainHour: 2}, config.SafetyConfig{})

	engine.recordSend("mb@f.cz", "target.cz", false)
	if !engine.allowDomain("target.cz") {
		t.Error("should allow 2nd send")
	}

	engine.recordSend("mb@f.cz", "target.cz", false)
	if engine.allowDomain("target.cz") {
		t.Error("should block 3rd send (limit=2)")
	}

	// Different domain unaffected
	if !engine.allowDomain("other.cz") {
		t.Error("other domain should be allowed")
	}
}
