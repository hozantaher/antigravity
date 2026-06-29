package thread

import (
	"context"
	"testing"
	"time"

	"common/humanize"
)

// ── Status & Action Constants ──

func TestStatus_Constants(t *testing.T) {
	statuses := []Status{StatusNew, StatusActive, StatusReplied, StatusClosed, StatusPaused, StatusExpired, StatusError}
	seen := make(map[Status]bool)
	for _, s := range statuses {
		if seen[s] { t.Errorf("duplicate: %s", s) }
		seen[s] = true
	}
	if len(statuses) != 7 { t.Errorf("expected 7 statuses, got %d", len(statuses)) }
}

func TestNextAction_Constants(t *testing.T) {
	actions := []NextAction{ActionSendStep, ActionWaitReply, ActionManualFollow, ActionPaused, ActionDone}
	if len(actions) != 5 { t.Errorf("expected 5 actions, got %d", len(actions)) }
}

// ── Direction & Sentiment ──

func TestDirection(t *testing.T) {
	if Outbound != "outbound" { t.Error("outbound") }
	if Inbound != "inbound" { t.Error("inbound") }
}

func TestSentiment(t *testing.T) {
	if SentimentPositive != "positive" { t.Error("positive") }
	if SentimentNegative != "negative" { t.Error("negative") }
	if SentimentNeutral != "neutral" { t.Error("neutral") }
	if SentimentOOO != "ooo" { t.Error("ooo") }
}

// ── Event Types ──

func TestEventType_Constants(t *testing.T) {
	types := []EventType{
		EventSent, EventDelivered, EventOpened, EventClicked,
		EventReplied, EventBounced, EventComplained,
		EventSuppressed, EventScoreChanged,
	}
	if len(types) != 9 { t.Errorf("expected 9 event types, got %d", len(types)) }
}

// ── HashBody ──

func TestHashBody_Deterministic(t *testing.T) {
	h1 := hashBody("Hello World")
	h2 := hashBody("Hello World")
	if h1 != h2 { t.Error("same input → different hash") }
}

func TestHashBody_Different(t *testing.T) {
	if hashBody("a") == hashBody("b") { t.Error("different input → same hash") }
}

func TestHashBody_Length(t *testing.T) {
	h := hashBody("test")
	if len(h) != 32 { t.Errorf("expected 32 hex chars (16 bytes), got %d", len(h)) }
}

// ── CleanMessageID ──

func TestCleanMessageID(t *testing.T) {
	tests := []struct{ in, want string }{
		{"<abc@test.cz>", "abc@test.cz"},
		{"abc@test.cz", "abc@test.cz"},
		{"  <abc@test.cz>  ", "abc@test.cz"},
		{"<>", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := cleanMessageID(tt.in); got != tt.want {
			t.Errorf("cleanMessageID(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ── ClassifySentiment ──

func TestClassifySentiment(t *testing.T) {
	tests := []struct {
		replyType humanize.ReplyType
		want      Sentiment
	}{
		{humanize.ReplyInterested, SentimentPositive},
		{humanize.ReplyMeeting, SentimentPositive},
		{humanize.ReplyLater, SentimentNeutral},
		{humanize.ReplyObjection, SentimentNeutral},
		{humanize.ReplyNegative, SentimentNegative},
		{humanize.ReplyAutoOOO, SentimentOOO},
	}
	for _, tt := range tests {
		if got := classifySentiment(tt.replyType); got != tt.want {
			t.Errorf("classifySentiment(%d) = %s, want %s", tt.replyType, got, tt.want)
		}
	}
}

// ── ReplyTypeString ──

func TestReplyTypeString(t *testing.T) {
	tests := []struct {
		rt   humanize.ReplyType
		want string
	}{
		{humanize.ReplyInterested, "interested"},
		{humanize.ReplyMeeting, "meeting"},
		{humanize.ReplyLater, "later"},
		{humanize.ReplyObjection, "objection"},
		{humanize.ReplyNegative, "negative"},
		{humanize.ReplyAutoOOO, "ooo"},
	}
	for _, tt := range tests {
		if got := replyTypeString(tt.rt); got != tt.want {
			t.Errorf("replyTypeString(%d) = %q, want %q", tt.rt, got, tt.want)
		}
	}
}

// ── Constructors ──

func TestNewManager(t *testing.T) {
	m := NewManager(nil)
	if m == nil { t.Fatal("nil manager") }
}

func TestNewMessageRecorder(t *testing.T) {
	r := NewMessageRecorder(nil)
	if r == nil { t.Fatal("nil recorder") }
}

func TestNewEventLogger(t *testing.T) {
	l := NewEventLogger(nil)
	if l == nil { t.Fatal("nil logger") }
}

func TestNewInboundProcessor(t *testing.T) {
	p := NewInboundProcessor(nil)
	if p == nil { t.Fatal("nil processor") }
	if p.response == nil { t.Error("response engine not initialized") }
}

// ── Thread Struct ──

func TestThread_Struct(t *testing.T) {
	now := time.Now()
	th := Thread{
		ID: 1, ContactID: 42, CampaignID: 5,
		Status: StatusActive, CurrentStep: 1,
		NextActionAt: &now, NextAction: ActionSendStep,
	}
	if th.Status != StatusActive { t.Error("status") }
	if th.NextAction != ActionSendStep { t.Error("action") }
	if th.NextActionAt == nil { t.Error("action_at") }
}

// ── Message Struct ──

func TestMessage_Struct(t *testing.T) {
	now := time.Now()
	msg := Message{
		ID: 1, ThreadID: 2, Direction: Outbound,
		MessageID: "abc@test.cz", Subject: "Test",
		BodyPreview: "Hello...", Sentiment: SentimentPositive,
		SentAt: &now, HumanizeApplied: true, IsBump: false,
	}
	if msg.Direction != Outbound { t.Error("direction") }
	if msg.Sentiment != SentimentPositive { t.Error("sentiment") }
}

// ── OutboundMessage ──

func TestOutboundMessage_Preview(t *testing.T) {
	body := ""
	for i := 0; i < 300; i++ { body += "x" }
	msg := OutboundMessage{BodyPlain: body}
	preview := msg.BodyPlain
	if len(preview) > 200 { preview = preview[:200] }
	if len(preview) != 200 { t.Errorf("preview length: %d", len(preview)) }
}

// ── Event Struct ──

func TestEvent_Struct(t *testing.T) {
	tid := 1
	e := Event{
		ID: 1, ContactID: 42, ThreadID: &tid,
		Type: EventSent, Metadata: map[string]any{"key": "val"},
	}
	if e.Type != EventSent { t.Error("type") }
	if e.Metadata["key"] != "val" { t.Error("metadata") }
}

// ── Default branches ──

func TestClassifySentiment_Default(t *testing.T) {
	// Unknown reply type → default → SentimentNeutral
	got := classifySentiment(humanize.ReplyType(99))
	if got != SentimentNeutral {
		t.Errorf("default classifySentiment = %s, want SentimentNeutral", got)
	}
}

func TestReplyTypeString_Default(t *testing.T) {
	// Unknown reply type → default → "unknown"
	got := replyTypeString(humanize.ReplyType(99))
	if got != "unknown" {
		t.Errorf("default replyTypeString = %q, want 'unknown'", got)
	}
}

// ── WithClassifier and WithInterestedHook ──

func TestInboundProcessor_WithClassifier(t *testing.T) {
	p := NewInboundProcessor(nil)
	var classifier SentimentClassifier
	result := p.WithClassifier(classifier)
	if result != p {
		t.Error("WithClassifier should return same processor for chaining")
	}
}

func TestInboundProcessor_WithInterestedHook(t *testing.T) {
	p := NewInboundProcessor(nil)
	called := false
	hook := func(_ context.Context, _ string, _ int64) { called = true }
	result := p.WithInterestedHook(hook)
	if result != p {
		t.Error("WithInterestedHook should return same processor for chaining")
	}
	// Verify hook is stored and callable
	p.onInterested(context.Background(), "x@y.cz", 1)
	if !called {
		t.Error("stored hook should be callable")
	}
}
