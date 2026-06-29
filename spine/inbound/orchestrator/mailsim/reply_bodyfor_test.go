package mailsim

import (
	"strings"
	"testing"
)

// ---- hashVariant ----

func TestHashVariant_Empty(t *testing.T) {
	if hashVariant("") != 0 {
		t.Fatal("empty message ID should return 0")
	}
}

func TestHashVariant_NonEmpty(t *testing.T) {
	a := hashVariant("<msg1@test>")
	b := hashVariant("<msg2@test>")
	// Different IDs may return different variants (not guaranteed but likely)
	_ = a
	_ = b
}

func TestHashVariant_NonNegative(t *testing.T) {
	ids := []string{
		"<test-1@example.com>",
		"<zzzzzzzzzzzzzzzzzzz>",
		"<aaaaaaaaaaaa>",
		"x",
	}
	for _, id := range ids {
		if v := hashVariant(id); v < 0 {
			t.Errorf("hashVariant(%q)=%d want >=0", id, v)
		}
	}
}

func TestHashVariant_Deterministic(t *testing.T) {
	id := "<deterministic@test>"
	if hashVariant(id) != hashVariant(id) {
		t.Fatal("hashVariant not deterministic")
	}
}

// ---- bodyFor — all behaviors ----

var dummyOriginal = &OriginalMessage{
	MessageID: "<orig-123@test>",
	Subject:   "Nabídka strojů",
	From:      "sender@outreach.test",
}

func TestBodyFor_ReplyInterested(t *testing.T) {
	body := bodyFor(BehaviorReplyInterested, dummyOriginal)
	if body == "" {
		t.Fatal("expected non-empty body")
	}
	if !strings.Contains(body, "\r\n") {
		t.Fatal("body must use CRLF line endings")
	}
}

func TestBodyFor_ReplyMeeting(t *testing.T) {
	body := bodyFor(BehaviorReplyMeeting, dummyOriginal)
	if body == "" {
		t.Fatal("expected non-empty body for meeting")
	}
}

func TestBodyFor_ReplyLater(t *testing.T) {
	body := bodyFor(BehaviorReplyLater, dummyOriginal)
	if body == "" {
		t.Fatal("expected non-empty body for later")
	}
}

func TestBodyFor_ReplyObjection(t *testing.T) {
	body := bodyFor(BehaviorReplyObjection, dummyOriginal)
	if body == "" {
		t.Fatal("expected non-empty body for objection")
	}
}

func TestBodyFor_ReplyNegative(t *testing.T) {
	body := bodyFor(BehaviorReplyNegative, dummyOriginal)
	if body == "" {
		t.Fatal("expected non-empty body for negative")
	}
}

func TestBodyFor_OOO(t *testing.T) {
	body := bodyFor(BehaviorOOO, dummyOriginal)
	if body == "" {
		t.Fatal("expected non-empty body for ooo")
	}
}

func TestBodyFor_Default_FallbackBody(t *testing.T) {
	// Deliver/Silent don't have a specific case → default body
	body := bodyFor(BehaviorDeliver, dummyOriginal)
	if body == "" {
		t.Fatal("expected fallback body")
	}
}

func TestBodyFor_VariantRotation(t *testing.T) {
	// Different message IDs should produce same or different body (at least no panic)
	for _, id := range []string{"", "<a@test>", "<b@test>", "<c@test>"} {
		orig := &OriginalMessage{MessageID: id, Subject: "S", From: "f@t"}
		body := bodyFor(BehaviorReplyInterested, orig)
		if body == "" {
			t.Errorf("empty body for message ID %q", id)
		}
	}
}

// ---- ReplyBuilder.Build ----

func TestReplyBuilder_Build_OOO(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{
		MessageID: "<orig@test>",
		Subject:   "Nabídka",
		From:      "sales@outreach.test",
	}
	msg, err := rb.Build(orig, BehaviorOOO, "reply@prospect.test")
	if err != nil {
		t.Fatal(err)
	}
	text := string(msg)
	if !strings.Contains(text, "Auto-Submitted:") {
		t.Fatal("OOO reply must contain Auto-Submitted header")
	}
	if !strings.Contains(text, "In-Reply-To:") {
		t.Fatal("reply must reference original message ID")
	}
}

func TestReplyBuilder_Build_AllReplyBehaviors(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{MessageID: "<o@t>", Subject: "S", From: "f@t"}
	for _, beh := range []Behavior{
		BehaviorReplyInterested, BehaviorReplyMeeting, BehaviorReplyLater,
		BehaviorReplyObjection, BehaviorReplyNegative,
	} {
		msg, err := rb.Build(orig, beh, "from@prospect.test")
		if err != nil {
			t.Errorf("%s: Build error: %v", beh, err)
			continue
		}
		if len(msg) == 0 {
			t.Errorf("%s: empty message", beh)
		}
		if !strings.Contains(string(msg), "Re: S") {
			t.Errorf("%s: missing Re: subject", beh)
		}
	}
}

func TestReplyBuilder_Build_NonReplyBehavior_Err(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{MessageID: "<o@t>", Subject: "S", From: "f@t"}
	_, err := rb.Build(orig, BehaviorDeliver, "from@prospect.test")
	if err == nil {
		t.Fatal("expected error for non-reply behavior")
	}
}

func TestReplyBuilder_Build_NoMessageID(t *testing.T) {
	rb := DefaultReplyBuilder()
	orig := &OriginalMessage{Subject: "S", From: "f@t"} // no MessageID
	msg, err := rb.Build(orig, BehaviorReplyInterested, "from@p.test")
	if err != nil {
		t.Fatal(err)
	}
	text := string(msg)
	// No In-Reply-To when original has no MessageID
	if strings.Contains(text, "In-Reply-To:") {
		t.Fatal("should not have In-Reply-To with empty original MessageID")
	}
}
