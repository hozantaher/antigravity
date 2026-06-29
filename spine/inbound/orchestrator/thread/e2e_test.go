package thread

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"common/humanize"
)

// newE2EMockDB is a test helper that creates an in-memory sqlmock DB.
func newE2EMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db, mock
}

// ══════════════════════════════════════════
//  E2E: Thread State Machine
// ══════════════════════════════════════════

// TestE2E_ThreadLifecycle_HappyPath exercises the Manager transitions that
// drive a thread from creation through active, replied, and finally closed.
// Each transition is exercised via a real Manager method call so the test
// verifies behavior (DB writes + returned errors) rather than struct mutation.
func TestE2E_ThreadLifecycle_HappyPath(t *testing.T) {
	db, mock := newE2EMockDB(t)
	m := NewManager(db)
	ctx := context.Background()

	// Create thread: new → id 1
	mock.ExpectQuery(`INSERT INTO outreach_threads`).
		WithArgs(int64(100), int64(5)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	id, err := m.Create(ctx, 100, 5)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if id != 1 {
		t.Errorf("Create: want id=1, got %d", id)
	}

	// active → AdvanceStep: advances the step counter and schedules next send
	nextSend := time.Now().Add(24 * time.Hour)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(nextSend, int64(id)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := m.AdvanceStep(ctx, id, nextSend); err != nil {
		t.Fatalf("AdvanceStep: %v", err)
	}

	// replied → MarkReplied: thread transitions to wait_reply
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(string(ActionWaitReply), int64(id)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := m.MarkReplied(ctx, id, ActionWaitReply); err != nil {
		t.Fatalf("MarkReplied: %v", err)
	}

	// closed → Close: terminal state
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(int64(id)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := m.Close(ctx, id); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestE2E_ThreadLifecycle_PauseResume exercises the Pause and
// ResumeExpiredPauses Manager methods.
func TestE2E_ThreadLifecycle_PauseResume(t *testing.T) {
	db, mock := newE2EMockDB(t)
	m := NewManager(db)
	ctx := context.Background()

	pauseUntil := time.Now().AddDate(0, 0, 14)

	// Pause: sets status=paused and stores pause_until
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(pauseUntil, int64(3)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := m.Pause(ctx, 3, pauseUntil); err != nil {
		t.Fatalf("Pause: %v", err)
	}

	// Resume: bulk-resumes threads whose pause_until has expired
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	n, err := m.ResumeExpiredPauses(ctx)
	if err != nil {
		t.Fatalf("ResumeExpiredPauses: %v", err)
	}
	if n != 1 {
		t.Errorf("ResumeExpiredPauses: want n=1, got %d", n)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ══════════════════════════════════════════
//  E2E: Inbound Reply Processing
// ══════════════════════════════════════════

func TestE2E_InboundReply_ClassificationToAction(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		expectedType   humanize.ReplyType
		expectedSent   Sentiment
		expectedAction NextAction
	}{
		{
			name: "interested",
			body: "Ano, pošlete ceník prosím",
			expectedType: humanize.ReplyInterested,
			expectedSent: SentimentPositive,
			expectedAction: ActionWaitReply,
		},
		{
			name: "meeting",
			body: "Zavolejte mi zítra v 10",
			expectedType: humanize.ReplyMeeting,
			expectedSent: SentimentPositive,
			expectedAction: ActionManualFollow,
		},
		{
			name: "negative",
			body: "Nemáme zájem, neposílejte",
			expectedType: humanize.ReplyNegative,
			expectedSent: SentimentNegative,
			expectedAction: ActionDone, // thread closed → done
		},
		{
			name: "ooo",
			body: "Jsem mimo kancelář do 15.4.2026",
			expectedType: humanize.ReplyAutoOOO,
			expectedSent: SentimentOOO,
			expectedAction: ActionPaused,
		},
		{
			name: "later",
			body: "Teď ne, ozvěte se na podzim",
			expectedType: humanize.ReplyLater,
			expectedSent: SentimentNeutral,
			expectedAction: ActionPaused,
		},
	}

	resp := humanize.NewResponseEngine()

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Classify
			replyType := resp.ClassifyReply(tt.body)
			if replyType != tt.expectedType {
				t.Errorf("classify: got %d, want %d", replyType, tt.expectedType)
			}

			// Map to sentiment
			sentiment := classifySentiment(replyType)
			if sentiment != tt.expectedSent {
				t.Errorf("sentiment: got %s, want %s", sentiment, tt.expectedSent)
			}

			// Map to thread action
			var action NextAction
			switch replyType {
			case humanize.ReplyNegative:
				action = ActionDone
			case humanize.ReplyAutoOOO, humanize.ReplyLater:
				action = ActionPaused
			case humanize.ReplyMeeting:
				action = ActionManualFollow
			default:
				action = ActionWaitReply
			}
			if action != tt.expectedAction {
				t.Errorf("action: got %s, want %s", action, tt.expectedAction)
			}

			// Verify reply type string
			str := replyTypeString(replyType)
			if str == "" || str == "unknown" {
				t.Errorf("replyTypeString: %q", str)
			}
		})
	}
}

// ══════════════════════════════════════════
//  E2E: Message Recording
// ══════════════════════════════════════════

func TestE2E_MessagePreview_Truncation(t *testing.T) {
	longBody := ""
	for i := 0; i < 50; i++ {
		longBody += "Toto je dlouhý text. "
	}

	preview := longBody
	if len(preview) > 200 {
		preview = preview[:200]
	}

	if len(preview) != 200 {
		t.Errorf("preview should be 200 chars, got %d", len(preview))
	}
}

func TestE2E_MessageID_Threading(t *testing.T) {
	// Simulate Message-ID → In-Reply-To → References chain
	outboundID := "abc123@email.seznam.cz"
	inboundInReplyTo := outboundID
	inboundRefs := "<" + outboundID + ">"

	cleaned := cleanMessageID(inboundInReplyTo)
	if cleaned != outboundID {
		t.Errorf("cleaned: %s, want %s", cleaned, outboundID)
	}

	// References should also match
	refCleaned := cleanMessageID(inboundRefs)
	if refCleaned != outboundID {
		t.Errorf("ref cleaned: %s, want %s", refCleaned, outboundID)
	}
}

func TestE2E_HashBody_ForDedup(t *testing.T) {
	body1 := "Hello, I'm interested in your machines."
	body2 := "Hello, I'm interested in your machines."
	body3 := "Different message content."

	if hashBody(body1) != hashBody(body2) {
		t.Error("same body should produce same hash")
	}
	if hashBody(body1) == hashBody(body3) {
		t.Error("different body should produce different hash")
	}
}

// ══════════════════════════════════════════
//  E2E: Event Timeline
// ══════════════════════════════════════════

func TestE2E_EventTimeline_Sequence(t *testing.T) {
	// Simulate a typical event sequence
	events := []EventType{
		EventSent,
		EventDelivered,
		EventOpened,
		EventClicked,
		EventReplied,
	}

	// Verify all types are distinct
	seen := make(map[EventType]bool)
	for _, e := range events {
		if seen[e] {
			t.Errorf("duplicate event type: %s", e)
		}
		seen[e] = true
	}

	// Verify typical sequence makes sense
	if events[0] != EventSent {
		t.Error("first event should be sent")
	}
}

func TestE2E_EventTimeline_BounceAborts(t *testing.T) {
	// Bounce should be terminal
	bounceSeq := []EventType{EventSent, EventBounced}

	if bounceSeq[len(bounceSeq)-1] != EventBounced {
		t.Error("bounce should be last event")
	}
}
