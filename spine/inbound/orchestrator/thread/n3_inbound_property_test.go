package thread

// n3_inbound_property_test.go — N3 task: property + monkey tests for
// orchestrator/thread package.
//
// Covers gaps from the coverage report:
//   - processBounce: 75% → covers the hard-bounce contact-update path and the
//     BounceNone kind branch (already tested in property_monkey_test.go, but
//     adds record-inbound-error early-exit path)
//   - ProcessReply: 95.1% → covers the matchToThread DB-error branch via
//     In-Reply-To when error is non-ErrNoRows
//   - classifySentiment: property — all known types + out-of-range sentinel
//   - parseReplyType: property — all valid inputs + boundary strings
//   - cleanMessageID: idempotency property + boundary inputs
//   - BounceInfo: IsBounce contract property
//   - Monkey: NewInboundProcessor with nil DB + WithClassifier + WithInterestedHook
//
// Test count: ≥10 in this file.

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"testing/quick"
	"time"

	"common/humanize"
	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── Monkey: NewInboundProcessor constructors ──────────────────────────────────

// TestNewInboundProcessor_NilDB_NeverPanics verifies the constructor and
// option-setters never panic when given nil/zero arguments.
func TestNewInboundProcessor_NilDB_NeverPanics(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("NewInboundProcessor panicked: %v", r)
		}
	}()
	p := NewInboundProcessor(nil)
	if p == nil {
		t.Fatal("NewInboundProcessor returned nil")
	}
	// WithClassifier(nil) should not panic
	p2 := p.WithClassifier(nil)
	if p2 == nil {
		t.Fatal("WithClassifier returned nil")
	}
	// WithInterestedHook(nil) should not panic
	p3 := p.WithInterestedHook(nil)
	if p3 == nil {
		t.Fatal("WithInterestedHook returned nil")
	}
}

// TestNewInboundProcessor_WithNilClassifier_ProcessReply_NilDB_NoMatch verifies
// ProcessReply on a nil-DB processor with no InReplyTo/References silently
// returns nil (no thread match path — no DB calls needed).
func TestNewInboundProcessor_WithNilClassifier_ProcessReply_NilDB_NoMatch(t *testing.T) {
	p := NewInboundProcessor(nil)
	raw := RawInbound{
		MessageID:  "nomatch@test.cz",
		InReplyTo:  "",    // empty → skip InReplyTo lookup
		References: "",    // empty → skip References lookup
		BodyPlain:  "Hi",
		ReceivedAt: time.Now(),
	}
	// Should return nil without touching DB (matchToThread returns 0,0,nil
	// immediately when both InReplyTo and References are empty).
	err := p.ProcessReply(context.Background(), raw)
	if err != nil {
		t.Errorf("expected nil error for no-match path with nil DB, got %v", err)
	}
}

// ── Property: classifySentiment is total and bounded ─────────────────────────

// TestClassifySentiment_Property_ExhaustiveKnown verifies every known ReplyType
// maps to the documented Sentiment value.
func TestClassifySentiment_Property_ExhaustiveKnown(t *testing.T) {
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

// TestClassifySentiment_Property_OutOfRange verifies that out-of-range values
// (≥6, the first undefined iota value) default to SentimentNeutral.
func TestClassifySentiment_Property_OutOfRange(t *testing.T) {
	outOfRange := []humanize.ReplyType{6, 10, 50, 100, 127, 255}
	for _, rt := range outOfRange {
		got := classifySentiment(rt)
		if got != SentimentNeutral {
			t.Errorf("classifySentiment(%d) = %q, want SentimentNeutral (default)", rt, got)
		}
	}
}

// TestClassifySentiment_Property_OutputBounded verifies that classifySentiment
// always returns one of the four defined Sentiment constants for any ReplyType
// value in a broad range.
func TestClassifySentiment_Property_OutputBounded(t *testing.T) {
	valid := map[Sentiment]bool{
		SentimentPositive: true,
		SentimentNeutral:  true,
		SentimentNegative: true,
		SentimentOOO:      true,
	}
	f := func(rt uint8) bool {
		got := classifySentiment(humanize.ReplyType(rt))
		return valid[got]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 256}); err != nil {
		t.Errorf("classifySentiment returned out-of-set value: %v", err)
	}
}

// ── Property: parseReplyType ──────────────────────────────────────────────────

// TestParseReplyType_Property_CaseInsensitive verifies that all known category
// strings parse correctly regardless of case.
func TestParseReplyType_Property_CaseInsensitive(t *testing.T) {
	cases := []struct {
		inputs []string
		want   humanize.ReplyType
	}{
		{[]string{"interested", "INTERESTED", "Interested", " interested "}, humanize.ReplyInterested},
		{[]string{"meeting", "MEETING", "Meeting"}, humanize.ReplyMeeting},
		{[]string{"later", "LATER", "Later"}, humanize.ReplyLater},
		{[]string{"objection", "OBJECTION", "Objection"}, humanize.ReplyObjection},
		{[]string{"negative", "NEGATIVE", "Negative"}, humanize.ReplyNegative},
		{[]string{"ooo", "OOO", "Ooo"}, humanize.ReplyAutoOOO},
	}
	for _, tc := range cases {
		for _, in := range tc.inputs {
			got, ok := parseReplyType(in)
			if !ok {
				t.Errorf("parseReplyType(%q) ok=false, want true", in)
				continue
			}
			if got != tc.want {
				t.Errorf("parseReplyType(%q) = %d, want %d", in, got, tc.want)
			}
		}
	}
}

// TestParseReplyType_Property_UnknownReturnsFalse verifies that strings which
// are not valid category names return ok=false.
func TestParseReplyType_Property_UnknownReturnsFalse(t *testing.T) {
	unknowns := []string{"", " ", "spam", "maybe", "yes", "no", "positive", "neutral",
		"angry", "happy", "sad", "UNKNOWN", "123", "\x00"}
	for _, s := range unknowns {
		_, ok := parseReplyType(s)
		if ok {
			t.Errorf("parseReplyType(%q) ok=true, want false", s)
		}
	}
}

// ── Property: replyTypeString + parseReplyType round-trip ────────────────────

// TestReplyTypeString_ParseReplyType_Roundtrip verifies that for every known
// ReplyType: replyTypeString(rt) → parseReplyType → same rt.
func TestReplyTypeString_ParseReplyType_Roundtrip(t *testing.T) {
	known := []humanize.ReplyType{
		humanize.ReplyInterested, humanize.ReplyMeeting, humanize.ReplyLater,
		humanize.ReplyObjection, humanize.ReplyNegative, humanize.ReplyAutoOOO,
	}
	for _, rt := range known {
		s := replyTypeString(rt)
		if s == "" || s == "unknown" {
			t.Errorf("replyTypeString(%d) = %q (should not be empty or 'unknown')", rt, s)
			continue
		}
		got, ok := parseReplyType(s)
		if !ok {
			t.Errorf("parseReplyType(%q) ok=false for round-tripped %d", s, rt)
			continue
		}
		if got != rt {
			t.Errorf("roundtrip %d → %q → %d (mismatch)", rt, s, got)
		}
	}
}

// ── Property: cleanMessageID idempotency ─────────────────────────────────────

// TestCleanMessageID_Property_Idempotent_N3 verifies cleanMessageID is
// idempotent: running it twice on any input gives the same result as once.
func TestCleanMessageID_Property_Idempotent_N3(t *testing.T) {
	f := func(s string) bool {
		once := cleanMessageID(s)
		twice := cleanMessageID(once)
		return once == twice
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 1000}); err != nil {
		t.Errorf("cleanMessageID not idempotent: %v", err)
	}
}

// TestCleanMessageID_Property_NoBrackets verifies that cleanMessageID always
// removes the outermost angle brackets from a bracketed message-id.
func TestCleanMessageID_Property_NoBrackets(t *testing.T) {
	bracketed := []struct {
		in   string
		want string
	}{
		{"<abc@test.cz>", "abc@test.cz"},
		{"abc@test.cz", "abc@test.cz"},
		{"  <abc@test.cz>  ", "abc@test.cz"},
		{"<>", ""},
		{"", ""},
		{"<nested<bad>@test.cz>", "nested<bad>@test.cz"},
	}
	for _, c := range bracketed {
		got := cleanMessageID(c.in)
		if got != c.want {
			t.Errorf("cleanMessageID(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ── Property: BounceInfo.IsBounce contract ───────────────────────────────────

// TestBounceInfo_IsBounce_Property_N3 verifies the BounceInfo.IsBounce method
// returns true only for BounceHard and BounceSoft.
func TestBounceInfo_IsBounce_Property_N3(t *testing.T) {
	table := []struct {
		kind BounceKind
		want bool
	}{
		{BounceHard, true},
		{BounceSoft, true},
		{BounceNone, false},
		{"", false},
		{"unknown", false},
	}
	for _, tt := range table {
		b := BounceInfo{Kind: tt.kind}
		if got := b.IsBounce(); got != tt.want {
			t.Errorf("IsBounce(%q) = %v, want %v", tt.kind, got, tt.want)
		}
	}
}

// ── processBounce: RecordInbound-error early-exit path ───────────────────────

// TestProcessBounce_RecordInboundError_ReturnsError covers the early return in
// processBounce when RecordInbound (INSERT INTO outreach_messages) fails.
// This is the path at line 202-204 of inbound.go that has 75% coverage.
func TestProcessBounce_RecordInboundError_ReturnsError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// RecordInbound fails
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnError(errors.New("disk full"))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "bounce-err@test.cz",
		InReplyTo:  "<orig@test.cz>",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1", Diagnostic: "User unknown"}

	if err := p.processBounce(context.Background(), raw, 5, 50, bounce); err == nil {
		t.Fatal("expected error when RecordInbound fails in processBounce")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// TestProcessBounce_HardBounce_ContactStatusFlipped covers the hard-bounce
// contact-status UPDATE at the end of processBounce (step 5 in inbound.go).
// Previously uncovered by the 75% score.
func TestProcessBounce_HardBounce_ContactStatusFlipped(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. RecordInbound
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// 2. Mark outbound bounced (InReplyTo set)
	mock.ExpectExec(`UPDATE outreach_messages SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 3. Hard: UPDATE outreach_threads SET status='bounced'
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 4. LogBounced: INSERT event
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	// 5. LogBounced: UPDATE contacts total_bounced
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// 6. LogBounced: UPDATE domains (best-effort)
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// 7. Hard: UPDATE outreach_contacts SET status='bounced'  ← the coverage gap
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<hard-cov@test.cz>",
		InReplyTo:  "<orig-cov@test.cz>",
		From:       "MAILER-DAEMON@mx.test",
		Subject:    "Undelivered Mail",
		BodyPlain:  "Status: 5.1.1\nDiagnostic-Code: smtp; 550 User unknown",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1", Diagnostic: "550 User unknown"}

	if err := p.processBounce(context.Background(), raw, 10, 100, bounce); err != nil {
		t.Fatalf("processBounce hard: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations not met (step 7 hard-bounce contact update expected): %v", err)
	}
}

// TestProcessBounce_HardBounce_ContactUpdateFails_StillOK verifies that a
// failure in the final "flip contact status" UPDATE (step 5 in inbound.go) is
// treated as a non-fatal warning — processBounce must still return nil.
func TestProcessBounce_HardBounce_ContactUpdateFails_StillOK(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(2))
	mock.ExpectExec(`UPDATE outreach_messages SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectExec(`UPDATE outreach_contacts SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// Step 7 fails — should be logged as warning, not returned as error
	mock.ExpectExec(`UPDATE outreach_contacts SET status = 'bounced'`).
		WillReturnError(errors.New("contact update failed"))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<hard-fail@test.cz>",
		InReplyTo:  "<orig-fail@test.cz>",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}

	if err := p.processBounce(context.Background(), raw, 11, 110, bounce); err != nil {
		t.Fatalf("processBounce should be non-fatal when contact-status update fails: %v", err)
	}
}

// ── Monkey: ProcessReply with various body shapes never panics ───────────────

// TestProcessReply_BounceEnvelope_NeverPanics verifies that a well-formed
// bounce envelope (matching MAILER-DAEMON From) processes without panic for a
// variety of body strings including empty, very long, and unicode content.
func TestProcessReply_BounceEnvelope_NeverPanics(t *testing.T) {
	bodies := []string{
		"",
		"Status: 5.1.1\nDiagnostic-Code: smtp; 550 User unknown",
		"Status: 4.2.2\nDiagnostic-Code: smtp; 452 Mailbox full",
		strings.Repeat("x", 5000),
		"žluté švestky 🐛 emoji test",
		"\r\n\r\nStatus: 5.0.0\r\n",
	}
	for _, body := range bodies {
		t.Run("", func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatalf("sqlmock: %v", err)
			}
			defer db.Close()

			// matchToThread → found
			mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
				WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(1, 10))
			// RecordInbound — always attempt
			mock.ExpectQuery(`INSERT INTO outreach_messages`).
				WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
			// Allow any subsequent UPDATE or INSERT to succeed
			for i := 0; i < 6; i++ {
				mock.ExpectExec(`.+`).WillReturnResult(sqlmock.NewResult(0, 1))
			}
			mock.ExpectQuery(`INSERT INTO outreach_events`).
				WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
			mock.ExpectExec(`.+`).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec(`.+`).WillReturnResult(sqlmock.NewResult(0, 1))

			p := NewInboundProcessor(db)
			raw := RawInbound{
				MessageID:  "<monkey@test.cz>",
				InReplyTo:  "<orig@test.cz>",
				From:       "MAILER-DAEMON@mx.test",
				Subject:    "Delivery Status Notification",
				BodyPlain:  body,
				ReceivedAt: time.Now(),
			}
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("ProcessReply panicked with body len=%d: %v", len(body), r)
				}
			}()
			_ = p.ProcessReply(context.Background(), raw)
		})
	}
}

// ── Property: DetectBounce output is always bounded ──────────────────────────

// TestDetectBounce_Property_KindBounded verifies DetectBounce always returns
// one of the three defined BounceKind values for arbitrary inputs.
func TestDetectBounce_Property_KindBounded(t *testing.T) {
	validKinds := map[BounceKind]bool{
		BounceHard: true,
		BounceSoft: true,
		BounceNone: true,
	}
	f := func(from, subject, body string) bool {
		raw := RawInbound{From: from, Subject: subject, BodyPlain: body, ReceivedAt: time.Now()}
		b := DetectBounce(raw)
		return validKinds[b.Kind]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("DetectBounce returned unexpected Kind: %v", err)
	}
}

// ── InboundProcessor: nil DB + InReplyTo → real DB error path ────────────────

// TestProcessReply_InReplyTo_RealDBError_Propagated verifies that a real
// (non-ErrNoRows) DB error in the InReplyTo lookup is propagated as an error.
func TestProcessReply_InReplyTo_RealDBError_Propagated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WillReturnError(errors.New("connection reset by peer"))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<err@test.cz>",
		InReplyTo:  "<orig@test.cz>",
		BodyPlain:  "test",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err == nil {
		t.Fatal("expected error when InReplyTo DB lookup returns non-ErrNoRows")
	}
}

// TestProcessReply_MatchToThread_ErrNoRows_Silent verifies that ErrNoRows in
// the InReplyTo lookup is treated as "no match" and returns nil (not an error).
func TestProcessReply_MatchToThread_ErrNoRows_Silent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// R2: lookup now consults BOTH outreach_messages and send_events.
	// ErrNoRows from outreach_messages falls through to send_events; an
	// empty result there returns the zero tuple silently.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`FROM send_events se`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// No match → parkUnattributed persists the message so the operator still
	// sees it. Its INSERT must be mocked now that parkUnattributed propagates a
	// persist failure (poller-retry guard) instead of swallowing it.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID:  "<norows@test.cz>",
		InReplyTo:  "<orig@test.cz>",
		BodyPlain:  "test",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ErrNoRows should be silent (no match), got: %v", err)
	}
}
