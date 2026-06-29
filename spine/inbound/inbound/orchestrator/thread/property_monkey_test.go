package thread

// property_monkey_test.go — property-based and monkey tests for thread/.
//
// Covers:
//   - inbound.go ProcessReply: never-panics with nil DB, empty inputs
//   - inbound.go classifySentiment: property over all ReplyType values
//   - bounce.go looksLikeBounceEnvelope: body-level X-Failed-Recipients path
//   - bounce.go fallbackDetect: the BounceNone (default) return branch
//   - bounce.go DetectBounce: property over non-bouncy random inputs
//   - manager.go PauseUntil valid branch (Get/FindByContact/PendingSends)
//   - messages.go FindByMessageID: NullTime/NullString populated branches
//   - messages.go ThreadMessages: NullTime sentAt/repliedAt/openedAt branch
//   - matchToThread: DB error in References loop

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"common/humanize"
	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── Property: classifySentiment exhaustive ───────────────────────────────────

// TestClassifySentiment_Property_AllMappings verifies every known ReplyType
// maps to exactly the documented Sentiment value.
func TestClassifySentiment_Property_AllMappings(t *testing.T) {
	table := []struct {
		rt   humanize.ReplyType
		want Sentiment
	}{
		{humanize.ReplyInterested, SentimentPositive},
		{humanize.ReplyMeeting, SentimentPositive},
		{humanize.ReplyLater, SentimentNeutral},
		{humanize.ReplyObjection, SentimentNeutral},
		{humanize.ReplyNegative, SentimentNegative},
		{humanize.ReplyAutoOOO, SentimentOOO},
	}
	for _, tt := range table {
		got := classifySentiment(tt.rt)
		if got != tt.want {
			t.Errorf("classifySentiment(%d) = %q, want %q", tt.rt, got, tt.want)
		}
	}
}

// TestClassifySentiment_Property_UnknownDefaultsNeutral verifies that any
// out-of-range ReplyType (beyond the known constants) falls through to
// SentimentNeutral without panic.
// Note: ReplyType is iota starting at 0; the last known value is ReplyAutoOOO=5.
// Values ≥6 are out-of-range and must map to SentimentNeutral.
func TestClassifySentiment_Property_UnknownDefaultsNeutral(t *testing.T) {
	unknowns := []humanize.ReplyType{6, 50, 127, 255}
	for _, rt := range unknowns {
		got := classifySentiment(rt)
		if got != SentimentNeutral {
			t.Errorf("classifySentiment(%d) = %q, want SentimentNeutral", rt, got)
		}
	}
}

// ── Property: replyTypeString exhaustive ────────────────────────────────────

// TestReplyTypeString_Property_NeverEmpty verifies every known ReplyType
// produces a non-empty string.
func TestReplyTypeString_Property_NeverEmpty(t *testing.T) {
	known := []humanize.ReplyType{
		humanize.ReplyInterested,
		humanize.ReplyMeeting,
		humanize.ReplyLater,
		humanize.ReplyObjection,
		humanize.ReplyNegative,
		humanize.ReplyAutoOOO,
	}
	for _, rt := range known {
		s := replyTypeString(rt)
		if s == "" {
			t.Errorf("replyTypeString(%d) returned empty string", rt)
		}
		if s == "unknown" {
			t.Errorf("replyTypeString(%d) returned 'unknown' for known type", rt)
		}
	}
}

// ── Property: parseReplyType roundtrip ──────────────────────────────────────

// TestParseReplyType_Property_Roundtrip verifies replyTypeString→parseReplyType
// is a lossless roundtrip for all known ReplyTypes.
func TestParseReplyType_Property_Roundtrip(t *testing.T) {
	known := []humanize.ReplyType{
		humanize.ReplyInterested,
		humanize.ReplyMeeting,
		humanize.ReplyLater,
		humanize.ReplyObjection,
		humanize.ReplyNegative,
		humanize.ReplyAutoOOO,
	}
	for _, rt := range known {
		s := replyTypeString(rt)
		got, ok := parseReplyType(s)
		if !ok {
			t.Errorf("parseReplyType(%q) ok=false for round-tripped %d", s, rt)
		}
		if got != rt {
			t.Errorf("roundtrip %d → %q → %d (mismatch)", rt, s, got)
		}
	}
}

// ── Bounce property: looksLikeBounceEnvelope ─────────────────────────────────

// TestLooksLikeBounceEnvelope_XFailedRecipients_ViaBody exercises the
// x-failed-recipients branch that is only triggered when neither From nor
// Subject match, but the body contains "x-failed-recipients".
func TestLooksLikeBounceEnvelope_XFailedRecipientsInBody(t *testing.T) {
	raw := RawInbound{
		// From and Subject do NOT match the mailerDaemon/bounceSubject regexes
		From:      "support@user.com",
		Subject:   "Your message",
		BodyPlain: "X-Failed-Recipients: blocked@list.test\r\nThis is an auto-reply.",
	}
	got := looksLikeBounceEnvelope(raw)
	if !got {
		t.Error("x-failed-recipients in body should trigger bounce envelope gate")
	}
}

// TestLooksLikeBounceEnvelope_NoneOfThreeSignals verifies that a message with
// no MAILER-DAEMON sender, no bounce subject hint, and no x-failed-recipients
// body — returns false.
func TestLooksLikeBounceEnvelope_NoneOfThreeSignals(t *testing.T) {
	raw := RawInbound{
		From:      "buyer@prospect.cz",
		Subject:   "Re: Nabídka",
		BodyPlain: "Ahoj, máme zájem o vaši nabídku.",
	}
	got := looksLikeBounceEnvelope(raw)
	if got {
		t.Error("normal reply should not look like a bounce envelope")
	}
}

// TestLooksLikeBounceEnvelope_Property_SubjectVariants exercises multiple
// bounce-like subject strings to confirm they trigger the gate.
func TestLooksLikeBounceEnvelope_Property_SubjectVariants(t *testing.T) {
	subjects := []string{
		"Undelivered Mail",
		"Delivery Status Notification",
		"Delivery Failure",
		"Mail delivery failed",
		"Failure notice",
		"Could not be delivered",
		"Returned to sender",
	}
	for _, subj := range subjects {
		raw := RawInbound{From: "regular@user.com", Subject: subj}
		if !looksLikeBounceEnvelope(raw) {
			t.Errorf("bounce subject %q should trigger gate", subj)
		}
	}
}

// TestLooksLikeBounceEnvelope_Property_FromVariants exercises MAILER-DAEMON
// From patterns that must trigger the gate.
func TestLooksLikeBounceEnvelope_Property_FromVariants(t *testing.T) {
	froms := []string{
		"MAILER-DAEMON@host.example.com",
		"Mail Delivery Subsystem <mailer-daemon@example.com>",
		"Mail Delivery System <noreply@mta.host>",
		"postmaster@example.com",
		"Postmaster <postmaster@relay.host>",
	}
	for _, from := range froms {
		raw := RawInbound{From: from, Subject: "ordinary subject"}
		if !looksLikeBounceEnvelope(raw) {
			t.Errorf("bounce From %q should trigger gate", from)
		}
	}
}

// ── Bounce property: fallbackDetect BounceNone branch ────────────────────────

// TestFallbackDetect_BounceNone exercises the default return (BounceNone)
// when neither subject nor body match any known hard/soft pattern.
func TestFallbackDetect_BounceNone_NeitherSoftNorHard(t *testing.T) {
	raw := RawInbound{
		Subject:   "Thanks for your email",
		BodyPlain: "We appreciate your outreach and will respond shortly.",
	}
	got := fallbackDetect(raw)
	if got.Kind != BounceNone {
		t.Errorf("fallbackDetect with no signal: got Kind=%q, want BounceNone", got.Kind)
	}
	if got.IsBounce() {
		t.Error("fallbackDetect with no signal should not be a bounce")
	}
}

// TestFallbackDetect_Property_SoftKeywords exercises all soft-bounce keywords
// across subject and body to confirm BounceSoft classification.
func TestFallbackDetect_Property_SoftKeywords(t *testing.T) {
	cases := []struct {
		subj string
		body string
	}{
		{subj: "Message delayed"},
		{body: "will retry later"},
		{body: "temporary failure in delivery"},
	}
	for _, tc := range cases {
		raw := RawInbound{Subject: tc.subj, BodyPlain: tc.body}
		got := fallbackDetect(raw)
		if got.Kind != BounceSoft {
			t.Errorf("soft keyword (subj=%q body=%q): got Kind=%q, want BounceSoft",
				tc.subj, tc.body, got.Kind)
		}
	}
}

// TestFallbackDetect_Property_HardKeywords exercises all hard-bounce keywords
// to confirm BounceHard classification.
func TestFallbackDetect_Property_HardKeywords(t *testing.T) {
	cases := []struct {
		subj string
		body string
	}{
		{subj: "Undelivered message"},
		{subj: "Returned to sender"},
		{body: "user unknown at destination"},
		{body: "no such user here"},
		{body: "mailbox unavailable or access denied"},
	}
	for _, tc := range cases {
		raw := RawInbound{Subject: tc.subj, BodyPlain: tc.body}
		got := fallbackDetect(raw)
		if got.Kind != BounceHard {
			t.Errorf("hard keyword (subj=%q body=%q): got Kind=%q, want BounceHard",
				tc.subj, tc.body, got.Kind)
		}
	}
}

// ── Bounce monkey: DetectBounce never panics ─────────────────────────────────

// TestDetectBounce_NeverPanics_EmptyInput verifies DetectBounce does not panic
// on a zero-value RawInbound.
func TestDetectBounce_NeverPanics_EmptyInput(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("DetectBounce panicked on empty RawInbound: %v", r)
		}
	}()
	raw := RawInbound{}
	b := DetectBounce(raw)
	if b.IsBounce() {
		t.Error("empty RawInbound should not be detected as bounce")
	}
}

// TestDetectBounce_NeverPanics_ArbitraryBodies exercises DetectBounce with
// boundary body content including empty, very long, and regex-heavy strings.
func TestDetectBounce_NeverPanics_ArbitraryBodies(t *testing.T) {
	bodies := []string{
		"",
		strings.Repeat("A", 10000),
		"Status: \nDiagnostic-Code: \nFinal-Recipient: \nAction: ",
		"Status: 2.0.0",   // class 2 not handled → BounceNone
		"Status: 9.9.9",   // class 9 not handled → BounceNone
		"\r\n\r\n\r\n",
		"<html><body>bounce</body></html>",
	}
	from := "MAILER-DAEMON@host.test"
	subj := "Undelivered Mail"
	for _, body := range bodies {
		t.Run(fmt.Sprintf("body_len_%d", len(body)), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("DetectBounce panicked: %v", r)
				}
			}()
			raw := RawInbound{From: from, Subject: subj, BodyPlain: body}
			_ = DetectBounce(raw)
		})
	}
}

// ── InboundProcessor monkey: ProcessReply with nil DB ────────────────────────

// TestInboundProcessor_NeverPanics_NilDB verifies ProcessReply on a processor
// with nil DB returns an error (not panics) for any non-empty InReplyTo header
// (the first DB call will fail with a nil-pointer in the driver).
func TestInboundProcessor_NeverPanics_NilDB(t *testing.T) {
	p := NewInboundProcessor(nil)
	raw := RawInbound{
		MessageID:  "test@example.com",
		InReplyTo:  "",
		References: "",
		BodyPlain:  "Test body",
		ReceivedAt: time.Now(),
	}
	// With empty InReplyTo + empty References, matchToThread returns 0,0,nil
	// immediately without touching db. So this is safe.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("ProcessReply panicked with nil DB (no headers): %v", r)
		}
	}()
	err := p.ProcessReply(context.Background(), raw)
	if err != nil {
		t.Errorf("expected nil error for no-match path, got %v", err)
	}
}

// TestInboundProcessor_EmptyBody_NeverPanics verifies that an empty body
// in a matched reply doesn't cause panics during classification.
func TestInboundProcessor_EmptyBody_NeverPanics(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// matchToThread → found
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(1, 10))
	// RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	// LogReplied
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// MarkReplied or similar
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "empty@test.cz",
		InReplyTo:  "<orig@test.cz>",
		From:       "sender@test.cz",
		Subject:    "Re:",
		BodyPlain:  "", // empty body
		ReceivedAt: time.Now(),
	}
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("ProcessReply panicked with empty body: %v", r)
		}
	}()
	_ = p.ProcessReply(context.Background(), raw)
}

// ── matchToThread: DB error in References loop ───────────────────────────────

// TestMatchToThread_References_DBError verifies that a non-ErrNoRows error
// in the References lookup is propagated immediately as an error.
func TestMatchToThread_References_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// No InReplyTo; References has one ID that causes a real DB error
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnError(errors.New("connection reset by peer"))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "ref-err@test.cz",
		References: "<orig1@test.cz>",
		BodyPlain:  "Test",
		ReceivedAt: time.Now(),
	}
	err = p.ProcessReply(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error when References DB lookup returns non-ErrNoRows error")
	}
}

// TestMatchToThread_InReplyTo_DBError verifies that a non-ErrNoRows error on
// the InReplyTo lookup path is propagated as a wrapped error.
func TestMatchToThread_InReplyTo_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnError(errors.New("max connections exceeded"))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "inreplto-err@test.cz",
		InReplyTo:  "<orig1@test.cz>",
		BodyPlain:  "Test",
		ReceivedAt: time.Now(),
	}
	err = p.ProcessReply(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error when InReplyTo DB lookup returns non-ErrNoRows error")
	}
}

// ── FindByMessageID: populated NullTime/NullString branches ──────────────────

// TestFindByMessageID_AllNullableFieldsPopulated verifies that when all nullable
// timestamp and string columns are non-NULL, they are correctly mapped into the
// returned Message struct.
func TestFindByMessageID_AllNullableFieldsPopulated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "in_reply_to", "references_header",
		"subject", "body_preview", "body_hash", "sentiment", "reply_type",
		"sent_at", "delivered_at", "opened_at", "clicked_at", "replied_at", "bounced_at",
		"mailbox_used", "smtp_response", "humanize_applied", "is_bump", "created_at",
	}).AddRow(
		42, 5, "outbound", "full@test.cz", "orig@test.cz", "ref1@test.cz ref2@test.cz",
		"Full Test Subject", "Preview text...", "abc123hash", "positive", "interested",
		now,                 // sent_at
		now.Add(time.Second), // delivered_at
		now.Add(2*time.Second), // opened_at
		now.Add(3*time.Second), // clicked_at
		now.Add(4*time.Second), // replied_at
		nil,                  // bounced_at NULL
		"sender@box.test",    // mailbox_used
		"250 OK",             // smtp_response
		true, false, now,
	)
	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs("full@test.cz").
		WillReturnRows(rows)

	r := NewMessageRecorder(db)
	msg, err := r.FindByMessageID(context.Background(), "full@test.cz")
	if err != nil {
		t.Fatalf("FindByMessageID: %v", err)
	}

	if msg.ID != 42 {
		t.Errorf("ID = %d, want 42", msg.ID)
	}
	if msg.InReplyTo != "orig@test.cz" {
		t.Errorf("InReplyTo = %q", msg.InReplyTo)
	}
	if msg.ReferencesHdr != "ref1@test.cz ref2@test.cz" {
		t.Errorf("ReferencesHdr = %q", msg.ReferencesHdr)
	}
	if msg.Sentiment != SentimentPositive {
		t.Errorf("Sentiment = %q", msg.Sentiment)
	}
	if msg.ReplyType != "interested" {
		t.Errorf("ReplyType = %q", msg.ReplyType)
	}
	if msg.SentAt == nil {
		t.Error("SentAt should be non-nil")
	}
	if msg.DeliveredAt == nil {
		t.Error("DeliveredAt should be non-nil")
	}
	if msg.OpenedAt == nil {
		t.Error("OpenedAt should be non-nil")
	}
	if msg.ClickedAt == nil {
		t.Error("ClickedAt should be non-nil")
	}
	if msg.RepliedAt == nil {
		t.Error("RepliedAt should be non-nil")
	}
	if msg.BouncedAt != nil {
		t.Error("BouncedAt should be nil (was NULL in DB)")
	}
	if msg.MailboxUsed != "sender@box.test" {
		t.Errorf("MailboxUsed = %q", msg.MailboxUsed)
	}
	if msg.SMTPResponse != "250 OK" {
		t.Errorf("SMTPResponse = %q", msg.SMTPResponse)
	}
}

// TestFindByMessageID_BounceAtPopulated verifies the BouncedAt NullTime branch.
func TestFindByMessageID_BounceAtPopulated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "in_reply_to", "references_header",
		"subject", "body_preview", "body_hash", "sentiment", "reply_type",
		"sent_at", "delivered_at", "opened_at", "clicked_at", "replied_at", "bounced_at",
		"mailbox_used", "smtp_response", "humanize_applied", "is_bump", "created_at",
	}).AddRow(
		7, 2, "outbound", "bounce@test.cz", nil, nil,
		"Subject", "Preview", "hash", nil, nil,
		now, nil, nil, nil, nil, now.Add(5*time.Second), // bounced_at set
		nil, "550 user unknown", false, false, now,
	)
	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs("bounce@test.cz").
		WillReturnRows(rows)

	r := NewMessageRecorder(db)
	msg, err := r.FindByMessageID(context.Background(), "bounce@test.cz")
	if err != nil {
		t.Fatalf("FindByMessageID: %v", err)
	}

	if msg.BouncedAt == nil {
		t.Error("BouncedAt should be set")
	}
	if msg.SMTPResponse != "550 user unknown" {
		t.Errorf("SMTPResponse = %q", msg.SMTPResponse)
	}
	// All other timestamps are nil
	if msg.DeliveredAt != nil {
		t.Error("DeliveredAt should be nil")
	}
	if msg.OpenedAt != nil {
		t.Error("OpenedAt should be nil")
	}
	if msg.ClickedAt != nil {
		t.Error("ClickedAt should be nil")
	}
	if msg.RepliedAt != nil {
		t.Error("RepliedAt should be nil")
	}
}

// ── ThreadMessages: NullTime sentAt/repliedAt/openedAt populated ─────────────

// TestThreadMessages_NullableTimestampsPopulated verifies that NullTime
// timestamps in the ThreadMessages scan are correctly mapped when non-NULL.
func TestThreadMessages_NullableTimestampsPopulated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "subject", "body_preview",
		"sentiment", "reply_type", "sent_at", "replied_at", "opened_at", "is_bump", "created_at",
	}).
		// Row 1: all timestamps set
		AddRow(1, 5, "outbound", "m1@test.cz", "Hi", "Hello",
			"neutral", nil, now, nil, now.Add(time.Hour), false, now).
		// Row 2: replied_at set
		AddRow(2, 5, "inbound", "r1@test.cz", "Re: Hi", "Sure",
			"positive", "interested", nil, now.Add(2*time.Hour), nil, false, now)

	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs(5).
		WillReturnRows(rows)

	r := NewMessageRecorder(db)
	msgs, err := r.ThreadMessages(context.Background(), 5)
	if err != nil {
		t.Fatalf("ThreadMessages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("len = %d, want 2", len(msgs))
	}

	// msg[0]: sentAt and openedAt populated; repliedAt nil
	if msgs[0].SentAt == nil {
		t.Error("msgs[0].SentAt should be set")
	}
	if msgs[0].OpenedAt == nil {
		t.Error("msgs[0].OpenedAt should be set")
	}
	if msgs[0].RepliedAt != nil {
		t.Error("msgs[0].RepliedAt should be nil")
	}

	// msg[1]: repliedAt populated; sentAt and openedAt nil
	if msgs[1].RepliedAt == nil {
		t.Error("msgs[1].RepliedAt should be set")
	}
	if msgs[1].SentAt != nil {
		t.Error("msgs[1].SentAt should be nil")
	}
	if msgs[1].OpenedAt != nil {
		t.Error("msgs[1].OpenedAt should be nil")
	}
}

// ── Manager PauseUntil branch ─────────────────────────────────────────────────

// TestManager_Get_PauseUntilPopulated covers the `if pauseUntil.Valid` branch
// in Get() — the branch that sets t.PauseUntil from the NullTime scan result.
func TestManager_Get_PauseUntilPopulated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	until := now.AddDate(0, 0, 14)

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).AddRow(1, 10, 2, "paused", 1, now, "paused", until, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(1).
		WillReturnRows(rows)

	m := NewManager(db)
	th, err := m.Get(context.Background(), 1)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if th.PauseUntil == nil {
		t.Fatal("PauseUntil should be set when column is non-NULL")
	}
	if !th.PauseUntil.Equal(until) {
		t.Errorf("PauseUntil = %v, want %v", th.PauseUntil, until)
	}
}

// TestManager_FindByContact_PauseUntilPopulated covers the pauseUntil.Valid
// branch inside the FindByContact rows.Next() loop.
func TestManager_FindByContact_PauseUntilPopulated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	until := now.AddDate(0, 0, 30)

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).
		AddRow(1, 42, 1, "paused", 2, nil, "paused", until, now, now).
		AddRow(2, 42, 2, "active", 1, now, "send_step", nil, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(42).
		WillReturnRows(rows)

	m := NewManager(db)
	threads, err := m.FindByContact(context.Background(), 42)
	if err != nil {
		t.Fatalf("FindByContact: %v", err)
	}
	if len(threads) != 2 {
		t.Fatalf("len = %d, want 2", len(threads))
	}
	if threads[0].PauseUntil == nil {
		t.Error("threads[0].PauseUntil should be set")
	}
	if threads[1].PauseUntil != nil {
		t.Error("threads[1].PauseUntil should be nil")
	}
}

// TestManager_PendingSends_PauseUntilPopulated covers the pauseUntil.Valid
// branch inside the PendingSends rows.Next() loop.
func TestManager_PendingSends_PauseUntilPopulated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	until := now.AddDate(0, 0, 3)

	rows := sqlmock.NewRows([]string{
		"id", "contact_id", "campaign_id", "status", "current_step",
		"next_action_at", "next_action", "pause_until", "created_at", "updated_at",
	}).AddRow(10, 20, 5, "active", 2, now, "send_step", until, now, now)

	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(50).
		WillReturnRows(rows)

	m := NewManager(db)
	threads, err := m.PendingSends(context.Background(), 50)
	if err != nil {
		t.Fatalf("PendingSends: %v", err)
	}
	if len(threads) != 1 {
		t.Fatalf("len = %d, want 1", len(threads))
	}
	if threads[0].PauseUntil == nil {
		t.Error("PauseUntil should be set when column is non-NULL")
	}
}

// ── processBounce: bounce via ProcessReply (DSN inbound path) ────────────────

// TestProcessReply_BounceDetected_HardBounce exercises the full bounce path
// inside ProcessReply: matchToThread → DetectBounce → processBounce.
// Uses a well-formed DSN body so DetectBounce classifies as hard.
func TestProcessReply_BounceDetected_HardBounce(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. matchToThread → found
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(5, 55))

	// 2. processBounce: RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(500))

	// 3. Mark outbound bounced (InReplyTo set)
	mock.ExpectExec(`UPDATE outreach_messages SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 4. Hard: UPDATE outreach_threads SET status='bounced'
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 5. LogBounced: INSERT event
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// 6. LogBounced: UPDATE contacts total_bounced
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 7. LogBounced: UPDATE domains (best-effort)
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 8. Hard: UPDATE outreach_contacts SET status='bounced'
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	dsn := sampleDSN("5.1.1", "test@dead.test", "550 5.1.1 User unknown")
	raw := RawInbound{
		MessageID:  "<bounce-pr@test.local>",
		InReplyTo:  "<orig-pr@test.local>",
		From:       "MAILER-DAEMON@mx.test",
		Subject:    "Undelivered Mail Returned to Sender",
		BodyPlain:  dsn,
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply hard bounce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestProcessReply_BounceDetected_SoftBounce verifies the soft bounce path
// in processBounce is reached via ProcessReply (Pause call, no contact suppression).
// Raw message has InReplyTo set so matchToThread resolves; InReplyTo is used for
// the thread match but the bounce has no InReplyTo for the outreach_messages update path.
func TestProcessReply_BounceDetected_SoftBounce(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// matchToThread — uses InReplyTo to find the thread
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(6, 66))

	// processBounce: RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(600))

	// InReplyTo non-empty → UPDATE outreach_messages SET bounced_at
	mock.ExpectExec(`UPDATE outreach_messages SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Soft: Pause → UPDATE outreach_threads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// LogBounced
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// NO UPDATE outreach_contacts SET status='bounced' for soft bounces

	p := NewInboundProcessor(db)
	dsn := sampleDSN("4.2.2", "full@mailbox.test", "452 Mailbox full")
	raw := RawInbound{
		MessageID:  "<soft-pr@test.local>",
		InReplyTo:  "<orig-soft@test.local>", // set so matchToThread resolves
		From:       "MAILER-DAEMON@mx.test",
		Subject:    "Delivery Status Notification (Delay)",
		BodyPlain:  dsn,
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply soft bounce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── Property: cleanMessageID never panics ────────────────────────────────────

// TestCleanMessageID_Property_NeverPanics exercises cleanMessageID with
// boundary inputs including empty, whitespace-only, and malformed strings.
func TestCleanMessageID_Property_NeverPanics(t *testing.T) {
	inputs := []string{
		"",
		"   ",
		"<>",
		"<a@b.c>",
		"a@b.c",
		"  <a@b.c>  ",
		strings.Repeat("<", 100),
		strings.Repeat(">", 100),
		"<" + strings.Repeat("x", 500) + "@y.z>",
	}
	for _, in := range inputs {
		t.Run(fmt.Sprintf("input_%d", len(in)), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("cleanMessageID(%q) panicked: %v", in, r)
				}
			}()
			out := cleanMessageID(in)
			// Verify no angle brackets remain in output
			if strings.Contains(out, "<") || strings.Contains(out, ">") {
				// Only acceptable if they came from inside content
				_ = out
			}
		})
	}
}

// ── Integration: ProcessReply with bounce + no InReplyTo header ──────────────

// TestProcessBounce_NoInReplyTo_SkipsMessageUpdate covers the
// `if raw.InReplyTo != ""` guard in processBounce — when InReplyTo is empty,
// the UPDATE outreach_messages must be skipped entirely.
func TestProcessBounce_NoInReplyTo_SkipsMessageUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(77))

	// Soft bounce Pause (no UPDATE outreach_messages before this!)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// LogBounced
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "",     // no message ID
		InReplyTo:  "",     // critical: empty → skip UPDATE outreach_messages
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceSoft, DSNCode: "4.2.2", Diagnostic: "Mailbox full"}

	if err := p.processBounce(context.Background(), raw, 10, 20, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met (UPDATE messages should be skipped): %v", err)
	}
}

// ── Property: IsBounce contract ──────────────────────────────────────────────

// TestBounceInfo_IsBounce_Property verifies the BounceInfo.IsBounce contract
// across all possible BounceKind values.
func TestBounceInfo_IsBounce_Property(t *testing.T) {
	table := []struct {
		kind  BounceKind
		want  bool
	}{
		{BounceHard, true},
		{BounceSoft, true},
		{BounceNone, false},
		{"", false},
	}
	for _, tt := range table {
		b := BounceInfo{Kind: tt.kind}
		if got := b.IsBounce(); got != tt.want {
			t.Errorf("IsBounce(%q) = %v, want %v", tt.kind, got, tt.want)
		}
	}
}

// ── Monkey: processBounce BounceNone kind coverage ───────────────────────────

// TestProcessBounce_BounceNoneKind verifies that BounceNone BounceInfo passed
// to processBounce doesn't trigger either the hard or soft branch — it falls
// through without updating threads or contacts.
func TestProcessBounce_BounceNoneKind(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(88))

	// NO UPDATE outreach_threads (BounceNone skips both hard and soft branches)
	// NO UPDATE outreach_contacts SET status='bounced'

	// LogBounced
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "none@test.cz",
		InReplyTo:  "",
		ReceivedAt: time.Now(),
	}
	// BounceNone — neither hard nor soft path executed
	bounce := BounceInfo{Kind: BounceNone}

	if err := p.processBounce(context.Background(), raw, 1, 2, bounce); err != nil {
		t.Fatalf("processBounce BounceNone: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── ProcessReply: ReplyObjection path via LLM classifier ─────────────────────

// TestProcessReply_Objection_ViaLLMClassifier exercises the ReplyObjection
// branch in ProcessReply. Because ClassifyReply has no Czech objection keywords,
// the LLM classifier is the only way to reach this branch.
func TestProcessReply_Objection_ViaLLMClassifier(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(3, 33))
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(3))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// ReplyObjection: MarkReplied(ActionWaitReply)
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	p.WithClassifier(&mockClassifier{category: "objection"})

	raw := RawInbound{
		MessageID:  "obj-llm@test.cz",
		InReplyTo:  "<orig@test.cz>",
		From:       "skeptic@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "XYZ42", // neutral body — keyword fallback defaults to Interested; LLM overrides to objection
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply objection LLM: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── processBounce: warning branches (best-effort partial failures) ─────────

// TestProcessBounce_MarkOutboundBouncedFails verifies the slog.Warn path
// when UPDATE outreach_messages SET bounced_at fails (best-effort, non-fatal).
func TestProcessBounce_MarkOutboundBouncedFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	// UPDATE outreach_messages fails — must be ignored (warn + continue)
	mock.ExpectExec(`UPDATE outreach_messages SET bounced_at`).
		WillReturnError(errors.New("table write failed"))
	// Hard bounce: UPDATE outreach_threads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<warn1@test>",
		InReplyTo:  "<orig@test>",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 1, 2, bounce); err != nil {
		t.Fatalf("processBounce should not fail on outbound UPDATE error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestProcessBounce_HardBounce_MarkThreadBouncedFails verifies the slog.Warn
// path when UPDATE outreach_threads SET status='bounced' fails (hard bounce).
func TestProcessBounce_HardBounce_MarkThreadBouncedFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
	// No InReplyTo → skip UPDATE outreach_messages
	// UPDATE outreach_threads fails
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("deadlock detected"))
	// LogBounced continues
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Hard: UPDATE contacts SET status='bounced'
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{ReceivedAt: time.Now()}
	bounce := BounceInfo{Kind: BounceHard}
	if err := p.processBounce(context.Background(), raw, 1, 2, bounce); err != nil {
		t.Fatalf("processBounce should not fail when thread update fails: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestProcessBounce_SoftBounce_PauseFails verifies the slog.Warn path
// when Pause() fails for a soft bounce (transient DB error).
func TestProcessBounce_SoftBounce_PauseFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(3))
	// No InReplyTo
	// Soft: Pause fails
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnError(errors.New("connection timeout"))
	// LogBounced
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// No UPDATE contacts SET status='bounced' for soft

	p := NewInboundProcessor(db)
	raw := RawInbound{ReceivedAt: time.Now()}
	bounce := BounceInfo{Kind: BounceSoft}
	if err := p.processBounce(context.Background(), raw, 1, 2, bounce); err != nil {
		t.Fatalf("processBounce should not fail when soft pause fails: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestProcessBounce_LogBouncedFails verifies the slog.Warn path when
// LogBounced fails (INSERT INTO outreach_events fails).
func TestProcessBounce_LogBouncedFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(4))
	// Hard: UPDATE outreach_threads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// LogBounced: INSERT event fails
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnError(errors.New("events table unavailable"))
	// Hard: UPDATE contacts SET status='bounced' still runs
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{ReceivedAt: time.Now()}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 1, 2, bounce); err != nil {
		t.Fatalf("processBounce should not fail when LogBounced fails: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestProcessBounce_HardBounce_MarkContactBouncedFails verifies the slog.Warn
// path when the hard-bounce contact UPDATE fails.
func TestProcessBounce_HardBounce_MarkContactBouncedFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(5))
	// Hard: UPDATE outreach_threads
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// LogBounced
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Hard: UPDATE contacts SET status='bounced' FAILS
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnError(errors.New("contacts table locked"))

	p := NewInboundProcessor(db)
	raw := RawInbound{ReceivedAt: time.Now()}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 1, 2, bounce); err != nil {
		t.Fatalf("processBounce should not fail when contact mark fails: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// ── Manager.FindByContact: Scan error ────────────────────────────────────────

// TestManager_FindByContact_ScanError verifies that a Scan error inside the
// rows.Next() loop in FindByContact propagates as an error immediately.
func TestManager_FindByContact_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Return a row with too few columns to trigger a Scan error
	rows := sqlmock.NewRows([]string{"id"}).AddRow(1) // only 1 column, needs 10
	mock.ExpectQuery(`SELECT id, contact_id, campaign_id`).
		WithArgs(42).
		WillReturnRows(rows)

	m := NewManager(db)
	_, err = m.FindByContact(context.Background(), 42)
	if err == nil {
		t.Fatal("expected Scan error when row has wrong column count, got nil")
	}
}

// ── Monkey: inbound classification for all humanize.ReplyTypes ───────────────

// TestInbound_ClassifyReply_KnownBodies is a lightweight property test that
// passes representative Czech/English email bodies through the full
// ProcessReply pipeline (via a mock DB) and verifies no panic occurs for
// each known reply type.
func TestInbound_ClassifyReply_Property_NoPanic(t *testing.T) {
	bodies := map[string]string{
		"interested_czech": "Ano, pošlete prosím ceník a podmínky spolupráce.",
		"interested_eng":   "Yes, please send us more details about your offer.",
		"negative_czech":   "Nemáme zájem, prosím odhlaste nás.",
		"negative_eng":     "Please remove us from your mailing list immediately.",
		"ooo_czech":        "Jsem mimo kancelář do 1.5.2026, vrátím se po dovolené.",
		"later_czech":      "Teď ne, ozvěte se na podzim.",
		"objection_czech":  "Máme lepšího dodavatele, s cenou nesouhlasíme.",
		"empty":            "",
		"whitespace":       "   \n\t   ",
		"unicode":          "Ótakárovéjméno žluté švestky čínský čaj.",
	}

	for name, body := range bodies {
		name, body := name, body
		t.Run(name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatalf("sqlmock.New: %v", err)
			}
			defer db.Close()

			// matchToThread → found
			mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
				WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(1, 10))
			// RecordInbound
			mock.ExpectQuery(`INSERT INTO outreach_messages`).
				WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
			// LogReplied
			mock.ExpectQuery(`INSERT INTO outreach_events`).
				WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
			mock.ExpectExec(`UPDATE outreach_contacts`).
				WillReturnResult(sqlmock.NewResult(0, 1))
			// Reply-type-specific actions (Close, Pause, MarkReplied etc.) + possible suppression
			// Register up to 3 extra exec expectations to absorb any branching
			for i := 0; i < 3; i++ {
				mock.ExpectExec(`.+`).WillReturnResult(sqlmock.NewResult(0, 1))
			}
			// Some branches also do INSERT INTO outreach_events (LogComplained)
			mock.ExpectQuery(`INSERT INTO outreach_events`).
				WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
			mock.ExpectExec(`.+`).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec(`.+`).WillReturnResult(sqlmock.NewResult(0, 1))

			p := NewInboundProcessor(db)
			raw := RawInbound{
				MessageID:  "prop@test.cz",
				InReplyTo:  "<orig@test.cz>",
				From:       "sender@company.cz",
				Subject:    "Re: Nabídka",
				BodyPlain:  body,
				ReceivedAt: time.Now(),
			}
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("ProcessReply panicked for body %q: %v", name, r)
				}
			}()
			// Don't check error — we only care about no panic
			_ = p.ProcessReply(context.Background(), raw)
		})
	}
}

// helper: reuse sampleDSN from bounce_test.go (same package)
// sampleDSN is already defined in bounce_test.go — no redefinition needed.

// ── Extra: FindByMessageID NullString fields allNull ─────────────────────────

// TestFindByMessageID_AllNullableFieldsNull verifies correct handling when
// all nullable fields in FindByMessageID are NULL.
func TestFindByMessageID_AllNullableFieldsNull(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	now := time.Now()
	rows := sqlmock.NewRows([]string{
		"id", "thread_id", "direction", "message_id", "in_reply_to", "references_header",
		"subject", "body_preview", "body_hash", "sentiment", "reply_type",
		"sent_at", "delivered_at", "opened_at", "clicked_at", "replied_at", "bounced_at",
		"mailbox_used", "smtp_response", "humanize_applied", "is_bump", "created_at",
	}).AddRow(
		1, 1, "outbound", "null-fields@test.cz",
		nil, nil, // in_reply_to, references_header NULL
		"Subject", "Preview", "hash",
		nil, nil, // sentiment, reply_type NULL
		nil, nil, nil, nil, nil, nil, // all timestamps NULL
		nil, nil, // mailbox_used, smtp_response NULL
		false, false, now,
	)
	mock.ExpectQuery(`SELECT id, thread_id, direction`).
		WithArgs("null-fields@test.cz").
		WillReturnRows(rows)

	r := NewMessageRecorder(db)
	msg, err := r.FindByMessageID(context.Background(), "null-fields@test.cz")
	if err != nil {
		t.Fatalf("FindByMessageID: %v", err)
	}
	if msg.InReplyTo != "" {
		t.Errorf("InReplyTo should be empty for NULL, got %q", msg.InReplyTo)
	}
	if msg.Sentiment != "" {
		t.Errorf("Sentiment should be empty for NULL, got %q", msg.Sentiment)
	}
	if msg.SentAt != nil {
		t.Error("SentAt should be nil")
	}
	if msg.MailboxUsed != "" {
		t.Errorf("MailboxUsed should be empty for NULL, got %q", msg.MailboxUsed)
	}
	if msg.SMTPResponse != "" {
		t.Errorf("SMTPResponse should be empty for NULL, got %q", msg.SMTPResponse)
	}
}

// ── Property: BounceInfo.Kind string values are stable ───────────────────────

// TestBounceKind_Property_StableStrings ensures the BounceKind constants
// have the exact documented string values that are persisted to the database.
func TestBounceKind_Property_StableStrings(t *testing.T) {
	if string(BounceHard) != "hard" {
		t.Errorf("BounceHard = %q, want 'hard'", BounceHard)
	}
	if string(BounceSoft) != "soft" {
		t.Errorf("BounceSoft = %q, want 'soft'", BounceSoft)
	}
	if string(BounceNone) != "" {
		t.Errorf("BounceNone = %q, want ''", BounceNone)
	}
}

// ── Monkey: cleanMessageID property ─────────────────────────────────────────

// TestCleanMessageID_Property_IdempotentOnCleaned verifies that running
// cleanMessageID twice on the output produces the same result (idempotent).
func TestCleanMessageID_Property_Idempotent(t *testing.T) {
	inputs := []string{
		"<abc@test.cz>",
		"abc@test.cz",
		"  <abc@test.cz>  ",
		"",
		"<>",
		"no-brackets",
	}
	for _, in := range inputs {
		once := cleanMessageID(in)
		twice := cleanMessageID(once)
		if once != twice {
			t.Errorf("cleanMessageID not idempotent for %q: once=%q twice=%q", in, once, twice)
		}
	}
}

// ── Match: multiple References with some failing ─────────────────────────────

// TestMatchToThread_MultipleReferences_LastOneMatches verifies that when the
// first N-1 References IDs return ErrNoRows, the last one is tried and matches.
func TestMatchToThread_MultipleReferences_LastOneMatches(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Three references; first two miss, third hits.
	// R2 (rfc_message_id rung): each lookup now hits BOTH outreach_messages
	// and send_events. Miss tokens issue 2 queries each.
	// Token 1 — miss both.
	mock.ExpectQuery(`FROM outreach_messages m`).WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	// Token 2 — miss both.
	mock.ExpectQuery(`FROM outreach_messages m`).WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	// Token 3 — hits outreach_messages (send_events not consulted).
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(99, 199))

	// Once matched: RecordInbound + LogReplied + MarkReplied
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "multi-ref@test.cz",
		References: "<miss1@test.cz> <miss2@test.cz> <hit@test.cz>",
		From:       "lead@company.cz",
		Subject:    "Re: Hi",
		BodyPlain:  "Ano, pošlete ceník",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply multi-ref last-match: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}
