package thread

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"common/humanize"
)

// ─── helpers ────────────────────────────────────────────────────────────────

func newMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db, mock
}

var ctx = context.Background()

// ─── parseReplyType ──────────────────────────────────────────────────────────

func TestParseReplyType_AllValid(t *testing.T) {
	tests := []struct {
		input string
		want  humanize.ReplyType
	}{
		{"interested", humanize.ReplyInterested},
		{"INTERESTED", humanize.ReplyInterested},
		{"  Interested  ", humanize.ReplyInterested},
		{"meeting", humanize.ReplyMeeting},
		{"MEETING", humanize.ReplyMeeting},
		{"later", humanize.ReplyLater},
		{"objection", humanize.ReplyObjection},
		{"negative", humanize.ReplyNegative},
		{"ooo", humanize.ReplyAutoOOO},
		{"OOO", humanize.ReplyAutoOOO},
	}
	for _, tt := range tests {
		got, ok := parseReplyType(tt.input)
		if !ok {
			t.Errorf("parseReplyType(%q) ok=false, want true", tt.input)
		}
		if got != tt.want {
			t.Errorf("parseReplyType(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestParseReplyType_Unknown(t *testing.T) {
	unknowns := []string{"", "spam", "maybe", "yes"}
	for _, s := range unknowns {
		_, ok := parseReplyType(s)
		if ok {
			t.Errorf("parseReplyType(%q) ok=true, want false", s)
		}
	}
}

// ─── Manager ────────────────────────────────────────────────────────────────

func TestManager_Create_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	rows := sqlmock.NewRows([]string{"id"}).AddRow(42)
	mock.ExpectQuery(`INSERT INTO outreach_threads`).
		WithArgs(1, 5).
		WillReturnRows(rows)

	id, err := m.Create(ctx, 1, 5)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if id != 42 {
		t.Errorf("id = %d, want 42", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestManager_Create_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectQuery(`INSERT INTO outreach_threads`).
		WithArgs(1, 5).
		WillReturnError(errors.New("db error"))

	_, err := m.Create(ctx, 1, 5)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestManager_Get_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).AddRow(7, 100, 5, "active", 2, now, "send_step", nil, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(7).
		WillReturnRows(rows)

	th, err := m.Get(ctx, 7)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if th.ID != 7 {
		t.Errorf("ID = %d, want 7", th.ID)
	}
	if th.Status != StatusActive {
		t.Errorf("Status = %s, want active", th.Status)
	}
	if th.NextAction != ActionSendStep {
		t.Errorf("NextAction = %s, want send_step", th.NextAction)
	}
	if th.NextActionAt == nil {
		t.Error("NextActionAt should be set")
	}
	if th.PauseUntil != nil {
		t.Error("PauseUntil should be nil")
	}
}

func TestManager_Get_NullFields(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).AddRow(3, 50, 2, "new", 0, nil, nil, nil, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(3).
		WillReturnRows(rows)

	th, err := m.Get(ctx, 3)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if th.NextActionAt != nil {
		t.Error("NextActionAt should be nil")
	}
	if th.PauseUntil != nil {
		t.Error("PauseUntil should be nil")
	}
	if th.NextAction != "" {
		t.Errorf("NextAction should be empty, got %q", th.NextAction)
	}
}

func TestManager_Get_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(99).
		WillReturnError(sql.ErrNoRows)

	_, err := m.Get(ctx, 99)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestManager_FindByContact_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).
		AddRow(1, 10, 1, "active", 1, now, "send_step", nil, now, now).
		AddRow(2, 10, 2, "replied", 3, nil, "wait_reply", nil, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(10).
		WillReturnRows(rows)

	threads, err := m.FindByContact(ctx, 10)
	if err != nil {
		t.Fatalf("FindByContact: %v", err)
	}
	if len(threads) != 2 {
		t.Errorf("len = %d, want 2", len(threads))
	}
	if threads[0].NextAction != ActionSendStep {
		t.Errorf("NextAction[0] = %s", threads[0].NextAction)
	}
	if threads[1].NextAction != ActionWaitReply {
		t.Errorf("NextAction[1] = %s", threads[1].NextAction)
	}
}

func TestManager_FindByContact_Empty(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	})

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(99).
		WillReturnRows(rows)

	threads, err := m.FindByContact(ctx, 99)
	if err != nil {
		t.Fatalf("FindByContact: %v", err)
	}
	if len(threads) != 0 {
		t.Errorf("expected empty, got %d", len(threads))
	}
}

func TestManager_FindByContact_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(10).
		WillReturnError(errors.New("db error"))

	_, err := m.FindByContact(ctx, 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_AdvanceStep_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	nextSend := time.Now().Add(24 * time.Hour)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(nextSend, 7).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := m.AdvanceStep(ctx, 7, nextSend)
	if err != nil {
		t.Fatalf("AdvanceStep: %v", err)
	}
}

func TestManager_AdvanceStep_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	nextSend := time.Now()
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	err := m.AdvanceStep(ctx, 7, nextSend)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_MarkReplied_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(string(ActionWaitReply), 5).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := m.MarkReplied(ctx, 5, ActionWaitReply)
	if err != nil {
		t.Fatalf("MarkReplied: %v", err)
	}
}

func TestManager_MarkReplied_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	err := m.MarkReplied(ctx, 5, ActionWaitReply)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_Pause_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	until := time.Now().AddDate(0, 0, 14)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(until, 3).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := m.Pause(ctx, 3, until)
	if err != nil {
		t.Fatalf("Pause: %v", err)
	}
}

func TestManager_Pause_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	err := m.Pause(ctx, 3, time.Now())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_Close_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(8).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := m.Close(ctx, 8)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestManager_Close_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	err := m.Close(ctx, 8)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_ResumeExpiredPauses_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 3))

	n, err := m.ResumeExpiredPauses(ctx)
	if err != nil {
		t.Fatalf("ResumeExpiredPauses: %v", err)
	}
	if n != 3 {
		t.Errorf("n = %d, want 3", n)
	}
}

func TestManager_ResumeExpiredPauses_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	_, err := m.ResumeExpiredPauses(ctx)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_PendingSends_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).
		AddRow(1, 10, 1, "active", 2, now, "send_step", nil, now, now).
		AddRow(2, 20, 1, "active", 1, nil, "send_step", nil, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(10).
		WillReturnRows(rows)

	threads, err := m.PendingSends(ctx, 10)
	if err != nil {
		t.Fatalf("PendingSends: %v", err)
	}
	if len(threads) != 2 {
		t.Errorf("len = %d, want 2", len(threads))
	}
	// thread[0] has next_action_at set
	if threads[0].NextActionAt == nil {
		t.Error("NextActionAt[0] should be set")
	}
	// thread[1] has no next_action_at
	if threads[1].NextActionAt != nil {
		t.Error("NextActionAt[1] should be nil")
	}
}

func TestManager_PendingSends_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(10).
		WillReturnError(errors.New("db error"))

	_, err := m.PendingSends(ctx, 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── MessageRecorder ─────────────────────────────────────────────────────────

func TestMessageRecorder_RecordOutbound_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	rows := sqlmock.NewRows([]string{"id"}).AddRow(55)
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(rows)

	msg := OutboundMessage{
		ThreadID:        1,
		MessageID:       "abc@test.cz",
		Subject:         "Hi",
		BodyPlain:       "Hello there",
		SentAt:          time.Now(),
		MailboxUsed:     "sender@example.com",
		HumanizeApplied: true,
		IsBump:          false,
	}
	id, err := r.RecordOutbound(ctx, msg)
	if err != nil {
		t.Fatalf("RecordOutbound: %v", err)
	}
	if id != 55 {
		t.Errorf("id = %d, want 55", id)
	}
}

func TestMessageRecorder_RecordOutbound_LongBody(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	longBody := ""
	for i := 0; i < 300; i++ {
		longBody += "x"
	}

	rows := sqlmock.NewRows([]string{"id"}).AddRow(1)
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(rows)

	msg := OutboundMessage{
		ThreadID:  1,
		MessageID: "long@test.cz",
		Subject:   "Test",
		BodyPlain: longBody,
		SentAt:    time.Now(),
	}
	_, err := r.RecordOutbound(ctx, msg)
	if err != nil {
		t.Fatalf("RecordOutbound long body: %v", err)
	}
}

func TestMessageRecorder_RecordOutbound_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnError(errors.New("db error"))

	_, err := r.RecordOutbound(ctx, OutboundMessage{ThreadID: 1, SentAt: time.Now()})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMessageRecorder_RecordInbound_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	rows := sqlmock.NewRows([]string{"id"}).AddRow(77)
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(rows)

	msg := InboundMessage{
		ThreadID:   2,
		MessageID:  "reply@test.cz",
		InReplyTo:  "orig@test.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Thanks for reaching out",
		Sentiment:  SentimentPositive,
		ReplyType:  "interested",
		ReceivedAt: time.Now(),
	}
	id, err := r.RecordInbound(ctx, msg)
	if err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	if id != 77 {
		t.Errorf("id = %d, want 77", id)
	}
}

func TestMessageRecorder_RecordInbound_LongBody(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	longBody := ""
	for i := 0; i < 300; i++ {
		longBody += "y"
	}

	rows := sqlmock.NewRows([]string{"id"}).AddRow(1)
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(rows)

	msg := InboundMessage{
		ThreadID:   1,
		BodyPlain:  longBody,
		ReceivedAt: time.Now(),
	}
	_, err := r.RecordInbound(ctx, msg)
	if err != nil {
		t.Fatalf("RecordInbound long body: %v", err)
	}
}

func TestMessageRecorder_RecordInbound_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnError(errors.New("db error"))

	_, err := r.RecordInbound(ctx, InboundMessage{ReceivedAt: time.Now()})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMessageRecorder_MarkOpened_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	now := time.Now()
	mock.ExpectExec(`UPDATE outreach_messages`).
		WithArgs(now, "abc@test.cz").
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := r.MarkOpened(ctx, "abc@test.cz", now)
	if err != nil {
		t.Fatalf("MarkOpened: %v", err)
	}
}

func TestMessageRecorder_MarkOpened_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectExec(`UPDATE outreach_messages`).
		WillReturnError(errors.New("db error"))

	err := r.MarkOpened(ctx, "abc@test.cz", time.Now())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMessageRecorder_MarkClicked_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	now := time.Now()
	mock.ExpectExec(`UPDATE outreach_messages`).
		WithArgs(now, "abc@test.cz").
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := r.MarkClicked(ctx, "abc@test.cz", now)
	if err != nil {
		t.Fatalf("MarkClicked: %v", err)
	}
}

func TestMessageRecorder_MarkClicked_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectExec(`UPDATE outreach_messages`).
		WillReturnError(errors.New("db error"))

	err := r.MarkClicked(ctx, "abc@test.cz", time.Now())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMessageRecorder_MarkBounced_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	now := time.Now()
	mock.ExpectExec(`UPDATE outreach_messages`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := r.MarkBounced(ctx, "abc@test.cz", now, "550 User unknown")
	if err != nil {
		t.Fatalf("MarkBounced: %v", err)
	}
}

func TestMessageRecorder_MarkBounced_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectExec(`UPDATE outreach_messages`).
		WillReturnError(errors.New("db error"))

	err := r.MarkBounced(ctx, "abc@test.cz", time.Now(), "err")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMessageRecorder_FindByMessageID_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "in_reply_to", "references_header",
		"subject", "body_preview", "body_hash", "sentiment", "reply_type",
		"sent_at", "delivered_at", "opened_at", "clicked_at", "replied_at", "bounced_at",
		"mailbox_used", "smtp_response", "humanize_applied", "is_bump", "created_at",
	}).AddRow(
		10, 2, "outbound", "abc@test.cz", "orig@test.cz", "",
		"Re: Hi", "Hello...", "abc123", "positive", "interested",
		now, nil, nil, nil, nil, nil,
		"sender@test.cz", nil, true, false, now,
	)

	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs("abc@test.cz").
		WillReturnRows(rows)

	msg, err := r.FindByMessageID(ctx, "abc@test.cz")
	if err != nil {
		t.Fatalf("FindByMessageID: %v", err)
	}
	if msg.ID != 10 {
		t.Errorf("ID = %d, want 10", msg.ID)
	}
	if msg.Direction != Outbound {
		t.Errorf("Direction = %s, want outbound", msg.Direction)
	}
	if msg.Sentiment != SentimentPositive {
		t.Errorf("Sentiment = %s, want positive", msg.Sentiment)
	}
	if msg.SentAt == nil {
		t.Error("SentAt should be set")
	}
	if !msg.HumanizeApplied {
		t.Error("HumanizeApplied should be true")
	}
	if msg.InReplyTo != "orig@test.cz" {
		t.Errorf("InReplyTo = %q", msg.InReplyTo)
	}
}

func TestMessageRecorder_FindByMessageID_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs("missing@test.cz").
		WillReturnError(sql.ErrNoRows)

	_, err := r.FindByMessageID(ctx, "missing@test.cz")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMessageRecorder_ThreadMessages_OK(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "subject", "body_preview",
		"sentiment", "reply_type", "sent_at", "replied_at", "opened_at", "is_bump", "created_at",
	}).
		AddRow(1, 5, "outbound", "m1@test.cz", "Hi", "Hello", "neutral", nil, now, nil, nil, false, now).
		AddRow(2, 5, "inbound", "r1@test.cz", "Re: Hi", "Sure", "positive", "interested", nil, now, nil, false, now)

	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs(5).
		WillReturnRows(rows)

	msgs, err := r.ThreadMessages(ctx, 5)
	if err != nil {
		t.Fatalf("ThreadMessages: %v", err)
	}
	if len(msgs) != 2 {
		t.Errorf("len = %d, want 2", len(msgs))
	}
	if msgs[0].Direction != Outbound {
		t.Errorf("msgs[0].Direction = %s", msgs[0].Direction)
	}
	if msgs[1].Direction != Inbound {
		t.Errorf("msgs[1].Direction = %s", msgs[1].Direction)
	}
	if msgs[1].Sentiment != SentimentPositive {
		t.Errorf("msgs[1].Sentiment = %s", msgs[1].Sentiment)
	}
	if msgs[1].ReplyType != "interested" {
		t.Errorf("msgs[1].ReplyType = %q", msgs[1].ReplyType)
	}
}

func TestMessageRecorder_ThreadMessages_Empty(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "subject", "body_preview",
		"sentiment", "reply_type", "sent_at", "replied_at", "opened_at", "is_bump", "created_at",
	})

	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs(99).
		WillReturnRows(rows)

	msgs, err := r.ThreadMessages(ctx, 99)
	if err != nil {
		t.Fatalf("ThreadMessages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("expected empty, got %d", len(msgs))
	}
}

func TestMessageRecorder_ThreadMessages_Error(t *testing.T) {
	db, mock := newMockDB(t)
	r := NewMessageRecorder(db)

	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs(5).
		WillReturnError(errors.New("db error"))

	_, err := r.ThreadMessages(ctx, 5)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── EventLogger ─────────────────────────────────────────────────────────────

func TestEventLogger_Log_WithNilIDs(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	rows := sqlmock.NewRows([]string{"id"}).AddRow(1)
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(rows)

	id, err := l.Log(ctx, 42, nil, nil, EventSent, nil)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if id != 1 {
		t.Errorf("id = %d, want 1", id)
	}
}

func TestEventLogger_Log_WithIDs(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	threadID := 5
	messageID := 10

	rows := sqlmock.NewRows([]string{"id"}).AddRow(2)
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(rows)

	id, err := l.Log(ctx, 42, &threadID, &messageID, EventOpened, map[string]any{"key": "value"})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if id != 2 {
		t.Errorf("id = %d, want 2", id)
	}
}

func TestEventLogger_Log_Error(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("db error"))

	_, err := l.Log(ctx, 42, nil, nil, EventSent, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEventLogger_LogSent_OK(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	// INSERT event
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	// UPDATE contact
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := l.LogSent(ctx, 42, 5, 10)
	if err != nil {
		t.Fatalf("LogSent: %v", err)
	}
}

func TestEventLogger_LogSent_InsertError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("db error"))

	err := l.LogSent(ctx, 42, 5, 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEventLogger_LogSent_UpdateError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnError(errors.New("update error"))

	err := l.LogSent(ctx, 42, 5, 10)
	if err == nil {
		t.Fatal("expected error from update")
	}
}

func TestEventLogger_LogOpened_OK(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := l.LogOpened(ctx, 42, 5, 10)
	if err != nil {
		t.Fatalf("LogOpened: %v", err)
	}
}

func TestEventLogger_LogOpened_InsertError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("db error"))

	err := l.LogOpened(ctx, 42, 5, 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEventLogger_LogReplied_OK(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := l.LogReplied(ctx, 42, 5, 10, "interested")
	if err != nil {
		t.Fatalf("LogReplied: %v", err)
	}
}

func TestEventLogger_LogReplied_InsertError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("db error"))

	err := l.LogReplied(ctx, 42, 5, 10, "negative")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEventLogger_LogBounced_OK(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// domain update is best-effort (errors ignored)
	mock.ExpectExec(`UPDATE outreach_domains`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := l.LogBounced(ctx, 42, 5, 10, "hard")
	if err != nil {
		t.Fatalf("LogBounced: %v", err)
	}
}

func TestEventLogger_LogBounced_InsertError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("db error"))

	err := l.LogBounced(ctx, 42, 5, 10, "soft")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEventLogger_LogComplained_OK(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := l.LogComplained(ctx, 42, 5, 10)
	if err != nil {
		t.Fatalf("LogComplained: %v", err)
	}
}

func TestEventLogger_LogComplained_InsertError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("db error"))

	err := l.LogComplained(ctx, 42, 5, 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEventLogger_LogComplained_UpdateError(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnError(errors.New("update error"))

	err := l.LogComplained(ctx, 42, 5, 10)
	if err == nil {
		t.Fatal("expected error from update")
	}
}

func TestEventLogger_ContactTimeline_OK(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	now := time.Now()
	tid := int64(5)
	mid := int64(10)
	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "thread_id", "message_id", "event_type", "metadata", "created_at",
	}).
		AddRow(1, 42, tid, mid, "sent", `{"key":"val"}`, now).
		AddRow(2, 42, nil, nil, "opened", `{}`, now)

	mock.ExpectQuery(`SELECT id, contact_id, thread_id`).
		WithArgs(42, 50).
		WillReturnRows(rows)

	events, err := l.ContactTimeline(ctx, 42, 50)
	if err != nil {
		t.Fatalf("ContactTimeline: %v", err)
	}
	if len(events) != 2 {
		t.Errorf("len = %d, want 2", len(events))
	}
	if events[0].Type != EventSent {
		t.Errorf("events[0].Type = %s, want sent", events[0].Type)
	}
	if events[0].ThreadID == nil || *events[0].ThreadID != 5 {
		t.Error("events[0].ThreadID should be 5")
	}
	if events[0].MessageID == nil || *events[0].MessageID != 10 {
		t.Error("events[0].MessageID should be 10")
	}
	if events[0].Metadata["key"] != "val" {
		t.Errorf("events[0].Metadata: %v", events[0].Metadata)
	}
	// second event has nil thread and message ids
	if events[1].ThreadID != nil {
		t.Error("events[1].ThreadID should be nil")
	}
}

func TestEventLogger_ContactTimeline_Error(t *testing.T) {
	db, mock := newMockDB(t)
	l := NewEventLogger(db)

	mock.ExpectQuery(`SELECT id, contact_id, thread_id`).
		WithArgs(42, 10).
		WillReturnError(errors.New("db error"))

	_, err := l.ContactTimeline(ctx, 42, 10)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ─── InboundProcessor ────────────────────────────────────────────────────────

// mockClassifier is a test double for SentimentClassifier.
type mockClassifier struct {
	category string
	err      error
}

func (m *mockClassifier) ClassifySentiment(_ context.Context, _ string) (string, error) {
	return m.category, m.err
}

func TestInboundProcessor_ProcessReply_NoMatch(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchToThread rung 1 (R2): each Message-ID lookup now consults BOTH
	// outreach_messages and send_events.rfc_message_id.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// matchToThread rung 3: exact email fallback → no rows
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// matchToThread rung 4: domain ico count for "test.cz" → 0 (unknown domain)
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// parkUnattributed INSERT — now RETURNING id so it's a QueryContext.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	raw := RawInbound{
		MessageID:  "reply@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "sender@test.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Thanks",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply no match: %v", err)
	}
	// No thread found → parked in unmatched_inbound
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestInboundProcessor_ProcessReply_NoInReplyTo_NoReferences(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No InReplyTo / References / From → matchToThread + matchToReplyInbox both
	// no-op, so the message falls through to parkUnattributed. Its INSERT must
	// be mocked: parkUnattributed now propagates a persist failure (so the
	// poller can retry instead of silently losing the message), meaning an
	// unmocked INSERT surfaces as a ProcessReply error rather than being
	// swallowed.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	raw := RawInbound{
		MessageID:  "new@test.cz",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply empty headers: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_References_NoMatch(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No InReplyTo, but References header with two IDs → both fail.
	// R2: each lookup hits BOTH outreach_messages AND send_events.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// parkUnattributed INSERT — empty From means email/domain rungs skip,
	// so we fall through directly to the park.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	raw := RawInbound{
		MessageID:  "reply@test.cz",
		References: "<id1@test.cz> <id2@test.cz>",
		BodyPlain:  "Thanks",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply references no match: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_Interested_WithLLMClassifier(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// LLM classifier returns "interested"
	p.WithClassifier(&mockClassifier{category: "interested"})

	// matchToThread → found thread 1, contact 42
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(1, 42))
	// RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(10))
	// LogReplied: INSERT event
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	// LogReplied: UPDATE contact
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// MarkReplied (ActionWaitReply)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	hookCalled := false
	p.WithInterestedHook(func(_ context.Context, _ string, _ int64) {
		hookCalled = true
	})

	raw := RawInbound{
		MessageID:  "reply@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "lead@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Yes, I am interested",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply interested: %v", err)
	}
	if !hookCalled {
		t.Error("onInterested hook should have been called")
	}
}

func TestInboundProcessor_ProcessReply_Meeting(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(2, 55))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(20))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	hookCalled := false
	p.WithInterestedHook(func(_ context.Context, from string, threadID int64) {
		hookCalled = true
		if from != "exec@company.cz" {
			t.Errorf("hook from = %q", from)
		}
		if threadID != 2 {
			t.Errorf("hook threadID = %d", threadID)
		}
	})

	raw := RawInbound{
		MessageID:  "mtg@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "exec@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Zavolejte mi zítra v 10",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply meeting: %v", err)
	}
	if !hookCalled {
		t.Error("onInterested hook should have been called for meeting")
	}
}

func TestInboundProcessor_ProcessReply_Negative(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// 1. matchToThread → resolves thread 3, contact 60.
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(3, 60))
	// 2. RecordInbound → inserts outreach_messages row.
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(30))
	// 3. LogReplied → Log() inserts outreach_events + UPDATE outreach_contacts
	//    (total_replied++).
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// 4. Negative branch: manager.Close → UPDATE outreach_threads (status=closed).
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// 5. events.LogComplained → INSERT outreach_events + UPDATE outreach_contacts
	//    + UPDATE outreach_domains (best-effort).
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// 6. Suppression INSERT — the critical "never email this person again" side
	//    effect that prevents re-enrollment into any future campaign.
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(60).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "neg@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "angry@company.cz",
		Subject:    "STOP",
		BodyPlain:  "Nemáme zájem, neposílejte",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(ctx, raw); err != nil {
		t.Fatalf("ProcessReply negative: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met: %v", err)
	}
}

// TestInboundProcessor_ProcessReply_LLMClassifierOverridesKeyword_Negative
// locks in the contract that when the LLM classifier succeeds it wins over
// the keyword fallback. Body has no keyword match → keyword default is
// ReplyInterested; classifier mock returns "negative" → actual reply path
// MUST be Negative (Close + Suppress). A mutation flipping `err == nil`
// to `err != nil` in inbound.go around line 92 would discard the LLM
// result and let the keyword default win, running the Interested path
// instead — this test would then fail on unmet sqlmock expectations.
func TestInboundProcessor_ProcessReply_LLMClassifierOverridesKeyword_Negative(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)
	p.WithClassifier(&mockClassifier{category: "negative"})

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(7, 77))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(70))
	// LogReplied
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Close thread (Negative branch)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// LogComplained
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Suppression insert (Negative branch — critical invariant)
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(77).
		WillReturnResult(sqlmock.NewResult(0, 1))

	hookCalled := false
	p.WithInterestedHook(func(_ context.Context, _ string, _ int64) {
		hookCalled = true
	})

	raw := RawInbound{
		MessageID:  "neutral@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "contact@company.cz",
		Subject:    "Re: Hi",
		// Deliberately neutral body — no Czech or English keyword matches any
		// ClassifyReply branch. Keyword fallback falls through to ReplyInterested
		// default at internal/humanize/response.go:113.
		BodyPlain:  "XYZ42",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(ctx, raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met (LLM result should have driven Negative path): %v", err)
	}
	if hookCalled {
		t.Error("onInterested hook should NOT fire when LLM classifies negative")
	}
}

// TestInboundProcessor_Negative_SuppressionInsertedEvenIfLogComplainedFails
// locks in the invariant that a negative reply MUST land in
// outreach_suppressions regardless of downstream logging failures. Logging a
// complaint is a best-effort audit trail; the suppression is the only thing
// that guarantees we never email the recipient again — the campaign runner's
// pre-send filter keys off this table exclusively.
func TestInboundProcessor_Negative_SuppressionInsertedEvenIfLogComplainedFails(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(7, 77))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(770))
	// LogReplied still succeeds.
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Close() succeeds.
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// LogComplained's INSERT fails — we still must insert the suppression.
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("events table write failed"))
	// Suppression insert must fire despite the preceding failure.
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(77).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "stop@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "angry@company.cz",
		Subject:    "Unsubscribe",
		BodyPlain:  "Nemáme zájem, odhlaste nás",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(ctx, raw); err != nil {
		t.Fatalf("ProcessReply negative: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met: %v", err)
	}
}

// TestInboundProcessor_Negative_SuppressionFailureIsNonFatal ensures a
// suppression INSERT failure (e.g. brief DB outage) is logged but does not
// propagate as a ProcessReply error — the inbound worker must keep draining
// the IMAP queue. The missing suppression becomes eventually-consistent via
// the nightly suppression sync.
func TestInboundProcessor_Negative_SuppressionFailureIsNonFatal(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(9, 99))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(900))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Suppression INSERT fails.
	mock.ExpectExec(`INSERT INTO outreach_suppressions`).
		WithArgs(99).
		WillReturnError(errors.New("db connection refused"))

	raw := RawInbound{
		MessageID:  "stop2@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "angry@company.cz",
		Subject:    "Přestaňte",
		BodyPlain:  "Nemáme zájem, už mi neposílejte",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(ctx, raw); err != nil {
		t.Fatalf("ProcessReply must not propagate suppression failure: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_OOO(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(4, 70))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(40))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Pause thread
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "ooo@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "away@company.cz",
		Subject:    "Auto-Reply",
		BodyPlain:  "Jsem mimo kancelář do 15.4.2026",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply OOO: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_Later(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(5, 80))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(50))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Pause thread
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "later@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "busy@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Teď ne, ozvěte se na podzim",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply later: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_Objection(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(6, 90))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(60))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// MarkReplied
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "obj@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "skeptic@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Máme lepšího dodavatele",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply objection: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_LLMClassifierError_FallsBack(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// LLM errors → keyword fallback (body = interested)
	p.WithClassifier(&mockClassifier{err: errors.New("llm error")})

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(7, 100))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(70))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "llmfail@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "lead@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Ano, pošlete ceník prosím",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply LLM error fallback: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_LLMClassifier_UnknownCategory(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// LLM returns unknown category → keyword classification used
	p.WithClassifier(&mockClassifier{category: "unknown_category"})

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(8, 110))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(80))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "unknown@test.cz",
		InReplyTo:  "orig@test.cz",
		From:       "x@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Ano, pošlete ceník prosím",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply unknown LLM category: %v", err)
	}
}

func TestInboundProcessor_ProcessReply_RecordInboundError(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(1, 42))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnError(errors.New("insert error"))

	raw := RawInbound{
		MessageID:  "fail@test.cz",
		InReplyTo:  "orig@test.cz",
		BodyPlain:  "Thanks",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err == nil {
		t.Fatal("expected error from RecordInbound failure")
	}
}

func TestInboundProcessor_ProcessReply_References_Found(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No InReplyTo header → try References → second ref matches.
	// R2: each Message-ID lookup hits BOTH outreach_messages AND send_events.
	// First ref misses both columns; second ref hits outreach_messages
	// (send_events query skipped on first hit).
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(9, 120))

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(90))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "ref@test.cz",
		References: "<miss@test.cz> <orig@test.cz>",
		From:       "lead@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Ano, pošlete ceník prosím",
		ReceivedAt: time.Now(),
	}
	err := p.ProcessReply(ctx, raw)
	if err != nil {
		t.Fatalf("ProcessReply references found: %v", err)
	}
}

// ─── Manager.ExpireStaleThreads ───────────────────────────────────────────────

func TestManager_ExpireStaleThreads_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(30).
		WillReturnResult(sqlmock.NewResult(0, 3))

	n, err := m.ExpireStaleThreads(ctx, 30)
	if err != nil {
		t.Fatalf("ExpireStaleThreads: %v", err)
	}
	if n != 3 {
		t.Errorf("expected 3 expired, got %d", n)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestManager_ExpireStaleThreads_Error(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	_, err := m.ExpireStaleThreads(ctx, 7)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestManager_ExpireStaleThreads_Zero(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	n, err := m.ExpireStaleThreads(ctx, 90)
	if err != nil {
		t.Fatalf("ExpireStaleThreads: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0, got %d", n)
	}
}

// ─── Manager.MarkError ───────────────────────────────────────────────────────

func TestManager_MarkError_OK(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(42).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := m.MarkError(ctx, 42, "repeated bounce")
	if err != nil {
		t.Fatalf("MarkError: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestManager_MarkError_DBError(t *testing.T) {
	db, mock := newMockDB(t)
	m := NewManager(db)

	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("db error"))

	err := m.MarkError(ctx, 1, "reason")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

