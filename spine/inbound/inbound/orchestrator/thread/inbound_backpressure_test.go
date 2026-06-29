package thread

import (
	"context"
	"sync"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// F3-1 — InboundProcessor.processBounce must feed
// mailbox.Backpressure.RecordBounce with the from_address of the
// bounced outbound message (hard bounces only). Pre-fix, the
// per-mailbox auto-hold trigger only fired from the SMTP-immediate
// bounce path; IMAP-arrived DSNs (the majority on a real campaign)
// never reached the registry.

// recBounceCall captures the (fromAddress, reason) args of one
// RecordBounce call.
type recBounceCall struct {
	fromAddress string
	reason      string
}

// fakeBounceRecorder implements BounceRecorder for tests.
type fakeBounceRecorder struct {
	mu      sync.Mutex
	calls   []recBounceCall
	heldFor map[string]bool // when true, RecordBounce returns held=true
}

func (f *fakeBounceRecorder) RecordBounce(_ context.Context, fromAddress, reason string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recBounceCall{fromAddress, reason})
	return f.heldFor[fromAddress]
}

func (f *fakeBounceRecorder) snapshot() []recBounceCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]recBounceCall, len(f.calls))
	copy(out, f.calls)
	return out
}

func TestProcessBounce_HardBounce_FeedsBackpressure(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Step 1: RecordInbound INSERT
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(101)))
	// Step 2: SELECT from_address (NEW, F3-1)
	mock.ExpectQuery(`SELECT.*from_address.*FROM outreach_messages WHERE message_id`).
		WithArgs("orig-msg-id@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"from_address"}).AddRow("jan@sender.test"))
	// Step 2 cont: UPDATE outbound bounced
	mock.ExpectExec(`UPDATE outreach_messages.*SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Step 3: UPDATE thread → bounced
	mock.ExpectExec(`UPDATE outreach_threads.*SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Step 4: LogBounced — INSERT bounce_events + UPDATE counters
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Step 5: UPDATE contact → bounced (hard only)
	mock.ExpectExec(`UPDATE outreach_contacts.*SET status = 'bounced'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rec := &fakeBounceRecorder{}
	p := NewInboundProcessor(db).WithBounceRecorder(rec)
	raw := RawInbound{
		MessageID:  "<dsn-123@mailer-daemon>",
		InReplyTo:  "<orig-msg-id@example.com>",
		Subject:    "Mail Delivery Failed",
		BodyPlain:  "550 5.1.1 user unknown",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1", Diagnostic: "user unknown"}

	if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}

	calls := rec.snapshot()
	if len(calls) != 1 {
		t.Fatalf("expected 1 RecordBounce call, got %d", len(calls))
	}
	if calls[0].fromAddress != "jan@sender.test" {
		t.Errorf("from_address = %q, want jan@sender.test", calls[0].fromAddress)
	}
	if calls[0].reason != "imap_dsn:5.1.1" {
		t.Errorf("reason = %q, want imap_dsn:5.1.1", calls[0].reason)
	}
}

func TestProcessBounce_SoftBounce_DoesNotFeedBackpressure(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(102)))
	mock.ExpectQuery(`SELECT.*from_address.*FROM outreach_messages WHERE message_id`).
		WithArgs("orig-msg-id-soft@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"from_address"}).AddRow("jan@sender.test"))
	mock.ExpectExec(`UPDATE outreach_messages.*SET bounced_at`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Soft → Pause path. Manager.Pause issues an UPDATE outreach_threads.
	mock.ExpectExec(`UPDATE outreach_threads`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO bounce_events`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	rec := &fakeBounceRecorder{}
	p := NewInboundProcessor(db).WithBounceRecorder(rec)
	raw := RawInbound{
		MessageID:  "<dsn-456@mailer-daemon>",
		InReplyTo:  "<orig-msg-id-soft@example.com>",
		Subject:    "Mail Delivery Delayed",
		BodyPlain:  "452 4.2.2 mailbox temporarily full",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceSoft, DSNCode: "4.2.2", Diagnostic: "mailbox full"}
	if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}

	calls := rec.snapshot()
	if len(calls) != 0 {
		t.Errorf("soft bounce must NOT feed backpressure, got %d calls", len(calls))
	}
}

func TestProcessBounce_NilRecorder_DoesNotPanic(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(103)))
	mock.ExpectQuery(`SELECT.*from_address.*FROM outreach_messages WHERE message_id`).
		WithArgs("orig-msg-id-nil@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"from_address"}).AddRow("jan@sender.test"))
	mock.ExpectExec(`UPDATE outreach_messages.*SET bounced_at`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))

	// No WithBounceRecorder — recorder stays nil. Must not panic.
	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID: "x", InReplyTo: "<orig-msg-id-nil@example.com>",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}
}

func TestProcessBounce_EmptyFromAddress_SkipsBackpressure(t *testing.T) {
	// If the lookup returns empty from_address (legacy message without
	// the column populated, or message not found), we skip RecordBounce
	// — feeding the registry with "" would corrupt the per-mailbox
	// counter for the empty-string key.
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(104)))
	mock.ExpectQuery(`SELECT.*from_address.*FROM outreach_messages WHERE message_id`).
		WithArgs("orig-msg-id-empty@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"from_address"}).AddRow(""))
	mock.ExpectExec(`UPDATE outreach_messages.*SET bounced_at`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))

	rec := &fakeBounceRecorder{}
	p := NewInboundProcessor(db).WithBounceRecorder(rec)
	raw := RawInbound{
		MessageID:  "x",
		InReplyTo:  "<orig-msg-id-empty@example.com>",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}
	if len(rec.snapshot()) != 0 {
		t.Errorf("empty from_address must skip RecordBounce, got %d calls", len(rec.calls))
	}
}

func TestProcessBounce_NoInReplyTo_SkipsBackpressure(t *testing.T) {
	// DSN without an In-Reply-To header — we have no way to find the
	// originating outbound, so skip backpressure feed.
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(105)))
	// No SELECT from_address (no InReplyTo) and no UPDATE outbound.
	mock.ExpectExec(`UPDATE outreach_threads.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))

	rec := &fakeBounceRecorder{}
	p := NewInboundProcessor(db).WithBounceRecorder(rec)
	raw := RawInbound{MessageID: "x", InReplyTo: "", ReceivedAt: time.Now()}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}
	if len(rec.snapshot()) != 0 {
		t.Errorf("no In-Reply-To must skip RecordBounce, got %d calls", len(rec.calls))
	}
}

func TestProcessBounce_HeldTrue_LogsAutoHold(t *testing.T) {
	// When RecordBounce returns held=true (registry tripped the
	// auto-hold threshold), the processor logs the event. The test
	// verifies the call shape; we don't assert log content (slog has
	// no public test handle in this package).
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(106)))
	mock.ExpectQuery(`SELECT.*from_address.*FROM outreach_messages WHERE message_id`).
		WithArgs("hot-msg@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"from_address"}).AddRow("hot@sender.test"))
	mock.ExpectExec(`UPDATE outreach_messages.*SET bounced_at`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_contacts.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))

	rec := &fakeBounceRecorder{heldFor: map[string]bool{"hot@sender.test": true}}
	p := NewInboundProcessor(db).WithBounceRecorder(rec)
	raw := RawInbound{
		MessageID:  "x",
		InReplyTo:  "<hot-msg@example.com>",
		ReceivedAt: time.Now(),
	}
	bounce := BounceInfo{Kind: BounceHard, DSNCode: "5.1.1"}
	if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
		t.Fatalf("processBounce: %v", err)
	}
	calls := rec.snapshot()
	if len(calls) != 1 || calls[0].fromAddress != "hot@sender.test" {
		t.Errorf("expected RecordBounce(hot@sender.test), got %v", calls)
	}
}

// Property: 10 contacts, mixed hard/soft DSNs, recorder must be called
// exactly once per HARD bounce and never for soft.
func TestProcessBounce_Property_HardOnly(t *testing.T) {
	cases := []struct {
		mid       string
		fromAddr  string
		kind      BounceKind
		dsnCode   string
		wantCalls int
	}{
		{"m1", "a@s.test", BounceHard, "5.1.1", 1},
		{"m2", "a@s.test", BounceSoft, "4.2.2", 0},
		{"m3", "b@s.test", BounceHard, "5.7.1", 1},
		{"m4", "b@s.test", BounceSoft, "4.5.0", 0},
		{"m5", "c@s.test", BounceHard, "5.0.0", 1},
	}
	for _, c := range cases {
		c := c
		t.Run(c.mid+"/"+string(c.kind), func(t *testing.T) {
			db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			mock.ExpectQuery(`INSERT INTO outreach_messages`).
				WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))
			mock.ExpectQuery(`SELECT.*from_address`).
				WithArgs(c.mid + "@example.com").
				WillReturnRows(sqlmock.NewRows([]string{"from_address"}).AddRow(c.fromAddr))
			mock.ExpectExec(`UPDATE outreach_messages.*SET bounced_at`).WillReturnResult(sqlmock.NewResult(0, 1))
			if c.kind == BounceHard {
				mock.ExpectExec(`UPDATE outreach_threads.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))
			} else {
				mock.ExpectExec(`UPDATE outreach_threads`).WillReturnResult(sqlmock.NewResult(0, 1))
			}
			mock.ExpectExec(`INSERT INTO bounce_events`).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec(`UPDATE outreach_contacts.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec(`UPDATE outreach_domains.*SET total_bounced`).WillReturnResult(sqlmock.NewResult(0, 1))
			if c.kind == BounceHard {
				mock.ExpectExec(`UPDATE outreach_contacts.*SET status = 'bounced'`).WillReturnResult(sqlmock.NewResult(0, 1))
			}

			rec := &fakeBounceRecorder{}
			p := NewInboundProcessor(db).WithBounceRecorder(rec)
			raw := RawInbound{
				MessageID:  c.mid + "-dsn",
				InReplyTo:  "<" + c.mid + "@example.com>",
				ReceivedAt: time.Now(),
			}
			bounce := BounceInfo{Kind: c.kind, DSNCode: c.dsnCode}
			if err := p.processBounce(context.Background(), raw, 7, 42, bounce); err != nil {
				t.Fatalf("processBounce: %v", err)
			}
			if got := len(rec.snapshot()); got != c.wantCalls {
				t.Errorf("kind=%s: got %d RecordBounce calls, want %d", c.kind, got, c.wantCalls)
			}
		})
	}
}
