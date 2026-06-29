package thread

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// fakePreClassifier captures the body it was asked to classify and
// returns a deterministic verdict.
type fakePreClassifier struct {
	mu       sync.Mutex
	calls    int
	lastBody string
	verdict  PreClassification
	err      error
}

func (f *fakePreClassifier) ClassifyReply(ctx context.Context, body string) (PreClassification, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.lastBody = body
	return f.verdict, f.err
}

func (f *fakePreClassifier) snapshotCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// fakeToggle implements PreClassifyEnabledGetter.
type fakeToggle struct {
	value string
	err   error
}

func (f *fakeToggle) Get(ctx context.Context, key string) (string, error) {
	return f.value, f.err
}

func waitFor(t *testing.T, cond func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("waitFor: condition still false after %s", timeout)
}

// 1. nil classifier → goroutine never spawned ─────────────────────────
func TestMaybePreClassifyAsync_NoClassifierWired_NoOp(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	p := NewInboundProcessor(db)

	// Should not panic, should not hang.
	p.maybePreClassifyAsync(RawInbound{
		From:       "jan@example.cz",
		Subject:    "Re: nabídka",
		BodyPlain:  "Mám zájem.",
		ReceivedAt: time.Now(),
	})
}

// 2. empty body → classifier never called ─────────────────────────────
func TestMaybePreClassifyAsync_EmptyBody_ClassifierNotCalled(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	fc := &fakePreClassifier{verdict: PreClassification{Intent: "positive"}}
	p := NewInboundProcessor(db).WithReplyPreClassifier(fc)

	p.maybePreClassifyAsync(RawInbound{
		From:       "jan@example.cz",
		BodyPlain:  "   \n  ",
		ReceivedAt: time.Now(),
	})
	// Give the goroutine a chance to spawn even though we expect it not to.
	time.Sleep(100 * time.Millisecond)
	if got := fc.snapshotCalls(); got != 0 {
		t.Errorf("classifier called %d times, want 0 on empty body", got)
	}
}

// 3. happy path: verdict UPDATEs reply_inbox ─────────────────────────
func TestMaybePreClassifyAsync_HappyPath_PersistsVerdict(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	verdict := PreClassification{
		Intent:     IntentPositiveStr,
		Confidence: 0.91,
		Reasoning:  "asks for meeting",
		ModelUsed:  "claude-haiku-4-5-20251001",
	}
	fc := &fakePreClassifier{verdict: verdict}
	p := NewInboundProcessor(db).WithReplyPreClassifier(fc)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE reply_inbox")).
		WithArgs(
			sqlmock.AnyArg(), // jsonb payload
			"jan@example.cz",
			"Re: nabidka",
			sqlmock.AnyArg(), // window start
			sqlmock.AnyArg(), // window end
			"",               // message-id (none on this inbound → fuzzy fallback)
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p.maybePreClassifyAsync(RawInbound{
		From:       "<jan@example.cz>",
		Subject:    "Re: nabidka",
		BodyPlain:  "Dobry den, mam zajem o nabidku. Domluvme schuzku.",
		ReceivedAt: time.Now(),
	})

	waitFor(t, func() bool { return fc.snapshotCalls() == 1 }, 2*time.Second)
	// Allow ExecContext to complete after classifier returns.
	waitFor(t, func() bool { return mock.ExpectationsWereMet() == nil }, 2*time.Second)
}

// 4. classifier error → still persists unknown verdict ───────────────
func TestMaybePreClassifyAsync_ClassifierError_PersistsUnknown(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	fc := &fakePreClassifier{
		verdict: PreClassification{Intent: "unknown", Confidence: 0},
		err:     errors.New("anthropic transport: dial fail"),
	}
	p := NewInboundProcessor(db).WithReplyPreClassifier(fc)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE reply_inbox")).
		WillReturnResult(sqlmock.NewResult(0, 0))

	p.maybePreClassifyAsync(RawInbound{
		From:       "jan@example.cz",
		Subject:    "Re: x",
		BodyPlain:  "test",
		ReceivedAt: time.Now(),
	})

	waitFor(t, func() bool { return fc.snapshotCalls() == 1 }, 2*time.Second)
	waitFor(t, func() bool { return mock.ExpectationsWereMet() == nil }, 2*time.Second)
}

// 5. toggle "false" → classifier never called ────────────────────────
func TestMaybePreClassifyAsync_ToggleDisabled_Skip(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	fc := &fakePreClassifier{verdict: PreClassification{Intent: "positive"}}
	toggle := &fakeToggle{value: "false"}
	p := NewInboundProcessor(db).
		WithReplyPreClassifier(fc).
		WithPreClassifyToggle(toggle)

	p.maybePreClassifyAsync(RawInbound{
		From:       "jan@example.cz",
		Subject:    "Re: x",
		BodyPlain:  "test",
		ReceivedAt: time.Now(),
	})

	// Give the goroutine time to run + check setting.
	time.Sleep(150 * time.Millisecond)
	if got := fc.snapshotCalls(); got != 0 {
		t.Errorf("classifier called %d times, want 0 when toggle=false", got)
	}
}

// 6. toggle "true" → classifier runs ──────────────────────────────────
func TestMaybePreClassifyAsync_ToggleEnabled_Run(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	fc := &fakePreClassifier{verdict: PreClassification{Intent: "positive", Confidence: 0.7}}
	toggle := &fakeToggle{value: "true"}
	p := NewInboundProcessor(db).
		WithReplyPreClassifier(fc).
		WithPreClassifyToggle(toggle)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE reply_inbox")).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p.maybePreClassifyAsync(RawInbound{
		From:       "jan@example.cz",
		Subject:    "Re: x",
		BodyPlain:  "test",
		ReceivedAt: time.Now(),
	})

	waitFor(t, func() bool { return fc.snapshotCalls() == 1 }, 2*time.Second)
	waitFor(t, func() bool { return mock.ExpectationsWereMet() == nil }, 2*time.Second)
}

// 7. senderDomainOnly strips local-part (PII safety) ─────────────────
func TestSenderDomainOnly_StripsLocalPart(t *testing.T) {
	cases := []struct{ in, want string }{
		{"jan.novak@example.cz", "example.cz"},
		{"<jan@firma.cz>", "firma.cz"},
		{"Display Name <addr@DOMAIN.com>", "domain.com"},
		{"", ""},
		{"no-at-sign", ""},
	}
	for _, c := range cases {
		if got := senderDomainOnly(c.in); got != c.want {
			t.Errorf("senderDomainOnly(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 8. verdict targets the specific message by Message-ID (FIX 4) ──────
// When the inbound carries a real Message-ID, the UPDATE keys on it ($6 =
// cleaned id) so two same-subject replies in the window can't cross-
// contaminate (each tags only its own row).
func TestMaybePreClassifyAsync_TargetsByMessageID(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()

	fc := &fakePreClassifier{verdict: PreClassification{Intent: IntentPositiveStr, Confidence: 0.8}}
	p := NewInboundProcessor(db).WithReplyPreClassifier(fc)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE reply_inbox")).
		WithArgs(
			sqlmock.AnyArg(), // jsonb payload
			"jan@example.cz",
			"Re: nabidka",
			sqlmock.AnyArg(), // window start
			sqlmock.AnyArg(), // window end
			"m-1@host.cz",    // cleaned Message-ID → exact-row targeting
		).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p.maybePreClassifyAsync(RawInbound{
		MessageID:  "<m-1@host.cz>",
		From:       "<jan@example.cz>",
		Subject:    "Re: nabidka",
		BodyPlain:  "Mám zájem o nabídku.",
		ReceivedAt: time.Now(),
	})

	waitFor(t, func() bool { return fc.snapshotCalls() == 1 }, 2*time.Second)
	waitFor(t, func() bool { return mock.ExpectationsWereMet() == nil }, 2*time.Second)
}

// Constant for intent string used in test (matches internal/llm package).
const IntentPositiveStr = "positive"
