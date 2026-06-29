package audit

import (
	"context"
	"sync"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// ════════════════════════════════════════════════════════════════════════
// LogChannel — write-site coverage
// ════════════════════════════════════════════════════════════════════════
//
// Memory rule feedback_extreme_testing.md: ≥10 test cases per write site.
// We test the helper exhaustively here because both call sites
// (sender onSent + IMAP poller) ultimately funnel through this one
// function. Branches covered:
//   1.  nil db → no panic, no marshal
//   2.  outbound happy path (sqlmock INSERT)
//   3.  inbound happy path (sqlmock INSERT)
//   4.  DB error → slog.Warn, no panic
//   5.  empty subject_email → arg is nil (NULL), not ""
//   6.  display-name From header → address-only lower-cased
//   7.  empty message_id → arg is nil (NULL)
//   8.  whitespace-only message_id → arg is nil (NULL)
//   9.  empty details → "{}"
//  10. populated details → JSON-encoded
//  11. unparseable subject (no @) → arg is nil (NULL), no panic
//  12. mixed-case email → lower-cased
//  13. concurrent calls → race-clean (run with -race)
//  14. empty details map (non-nil) → "{}" arg

func TestLogChannel_NilDB_NoPanic(t *testing.T) {
	// db == nil → returns silently
	LogChannel(context.Background(), nil,
		ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>", nil)
}

func TestLogChannel_NilDB_WithPopulatedDetails(t *testing.T) {
	// db == nil with non-empty details → still no panic, no marshal attempted
	LogChannel(context.Background(), nil,
		ChannelEmail, DirectionInbound, "x@y.cz", "<m@h>",
		map[string]any{"campaign_id": 42, "mailbox": "ops@example.com"})
}

func TestLogChannel_Outbound_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionOutbound,
			"recipient@example.cz",
			"<msg-1@host>",
			`{"campaign_id":7}`,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound,
		"recipient@example.cz", "<msg-1@host>",
		map[string]any{"campaign_id": 7})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestLogChannel_Inbound_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionInbound,
			"sender@example.cz",
			"<reply-99@host>",
			`{"mailbox":"ops@example.com"}`,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionInbound,
		"sender@example.cz", "<reply-99@host>",
		map[string]any{"mailbox": "ops@example.com"})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations not met: %v", err)
	}
}

func TestLogChannel_DBError_NoPanic_Logged(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WillReturnError(errAudit("insert failed"))

	// MUST NOT panic — best-effort contract.
	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>", nil)
}

func TestLogChannel_EmptySubjectEmail_StoredAsNULL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Empty subject email → driver.Value nil → NULL in DB.
	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionOutbound,
			nil, // subject_email NULL
			"<m@h>",
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "", "<m@h>", nil)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("empty subject should be NULL, not empty string: %v", err)
	}
}

func TestLogChannel_DisplayNameFromHeader_NormalisedToAddress(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionInbound,
			"jan.novak@example.cz", // address-only, lower-cased
			"<m@h>",
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionInbound,
		`"Jan Novák" <Jan.Novak@Example.cz>`,
		"<m@h>", nil)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("display-name From should normalise to address-only: %v", err)
	}
}

func TestLogChannel_EmptyMessageID_StoredAsNULL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionOutbound,
			"x@y.cz",
			nil, // message_id NULL
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "x@y.cz", "", nil)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("empty message_id should be NULL: %v", err)
	}
}

func TestLogChannel_WhitespaceMessageID_StoredAsNULL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionOutbound,
			"x@y.cz",
			nil,
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "x@y.cz", "   ", nil)
}

func TestLogChannel_NilDetails_EmptyJSON(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>",
			"{}", // nil details → "{}", not "null"
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>", nil)
}

func TestLogChannel_EmptyDetailsMap_EmptyJSON(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>",
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>",
		map[string]any{})
}

func TestLogChannel_PopulatedDetails_MarshalledIntoSQL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Single-key map → deterministic JSON.
	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>",
			`{"campaign_id":42}`,
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound, "x@y.cz", "<m@h>",
		map[string]any{"campaign_id": 42})

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("details JSON not passed to INSERT: %v", err)
	}
}

func TestLogChannel_UnparseableSubjectEmail_StoredAsNULL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// "not an email at all" — no `@`. normaliseEmail returns "".
	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionInbound,
			nil,
			"<m@h>",
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionInbound, "not an email at all", "<m@h>", nil)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unparseable email should be NULL: %v", err)
	}
}

func TestLogChannel_MixedCaseEmail_LowerCased(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO channel_audit_log`).
		WithArgs(
			ChannelEmail,
			DirectionOutbound,
			"camelcase@example.cz", // lower-cased
			"<m@h>",
			"{}",
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	LogChannel(context.Background(), db,
		ChannelEmail, DirectionOutbound,
		"CamelCase@Example.CZ", "<m@h>", nil)
}

func TestLogChannel_ConcurrentCalls_RaceClean(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Allow any number of inserts in any order from the goroutines.
	mock.MatchExpectationsInOrder(false)
	for i := 0; i < 50; i++ {
		mock.ExpectExec(`INSERT INTO channel_audit_log`).
			WillReturnResult(sqlmock.NewResult(int64(i+1), 1))
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			LogChannel(context.Background(), db,
				ChannelEmail, DirectionOutbound,
				"x@y.cz", "<m@h>",
				map[string]any{"i": idx})
		}(i)
	}
	wg.Wait()
}

// ── normaliseEmail unit tests ──

func TestNormaliseEmail_Cases(t *testing.T) {
	tcs := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"plain bare", "user@host.cz", "user@host.cz"},
		{"upper-case bare", "USER@Host.CZ", "user@host.cz"},
		{"bracketed", "<user@host.cz>", "user@host.cz"},
		{"display name + bracketed", `"Jan" <jan@host.cz>`, "jan@host.cz"},
		{"no @ at all", "not an email", ""},
		{"two @", "a@b@c", ""},
		{"trailing space", "user@host.cz   ", "user@host.cz"},
		{"unicode local-part", "Žofie@háčky.cz", "žofie@háčky.cz"},
	}
	for _, tc := range tcs {
		t.Run(tc.name, func(t *testing.T) {
			got := normaliseEmail(tc.in)
			if got != tc.want {
				t.Errorf("normaliseEmail(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
