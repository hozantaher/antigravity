package seedstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	op "operator-practice/internal/anonymize"
)

func newMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatalf("sqlmock new: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

// TestSelectQuery_DSRJoinShape — the SQL must LEFT JOIN the union of
// suppression tables so erased subjects never leak into the lab.
// This is a static contract test: we eyeball the constant rather than
// run it, because adding new suppression tables to the JOIN list is a
// review-required change.
func TestSelectQuery_DSRJoinShape(t *testing.T) {
	for _, want := range []string{
		"LEFT JOIN outreach_suppressions",
		"LEFT JOIN suppression_list",
		"s1.email IS NULL",
		"s2.email IS NULL",
		"direction = 'inbound'",
		"reply_type IS NOT NULL",
		"ORDER BY m.created_at DESC",
		"LIMIT $1",
	} {
		if !strings.Contains(SelectQuery, want) {
			t.Errorf("SelectQuery missing %q", want)
		}
	}
}

// TestSelectClassifiedReplies_HappyPath checks the row-scan path with
// two synthetic rows. We use sqlmock with QueryMatcherEqual so the
// exact statement is asserted (defends against accidental query drift).
func TestSelectClassifiedReplies_HappyPath(t *testing.T) {
	db, mock := newMock(t)
	store := New(db)

	now := time.Date(2026, 4, 30, 8, 0, 0, 0, time.UTC)
	rows := sqlmock.NewRows([]string{
		"id", "message_id", "from_addr", "subject",
		"body_text", "body_html", "created_at", "classification", "in_reply_to",
	}).
		AddRow(int64(1), "<m1@x>", "honza@firma.cz", "Re: x", "body", "", now, "interested", "").
		AddRow(int64(2), "<m2@x>", "p@y.cz", "Re: y", "body2", "", now, "ooo", "")
	mock.ExpectQuery(SelectQuery).WithArgs(5).WillReturnRows(rows)

	got, err := store.SelectClassifiedReplies(context.Background(), 5)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 rows; got %d", len(got))
	}
	if got[0].MessageID != "<m1@x>" || got[0].Classification != "interested" {
		t.Errorf("row[0] mismatch: %+v", got[0])
	}
	if got[1].Classification != "ooo" {
		t.Errorf("row[1] classification mapping: %q", got[1].Classification)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestSelectClassifiedReplies_LimitZeroReturnsEmpty — guard against
// accidentally pulling a million rows when the cron is misconfigured.
func TestSelectClassifiedReplies_LimitZeroReturnsEmpty(t *testing.T) {
	db, _ := newMock(t)
	got, err := New(db).SelectClassifiedReplies(context.Background(), 0)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 rows; got %d", len(got))
	}
}

// TestSelectClassifiedReplies_QueryError surfaces the wrapped error
// so callers / Sentry breadcrumb get useful context.
func TestSelectClassifiedReplies_QueryError(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(SelectQuery).WithArgs(3).WillReturnError(errors.New("connection refused"))

	_, err := New(db).SelectClassifiedReplies(context.Background(), 3)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("expected wrapped error; got %v", err)
	}
}

// TestEnsureSchema_ApplyAndIdempotent — schema DDL must be idempotent,
// so the cron can call EnsureSchema every night without failing on a
// pre-existing table. The DDL itself uses IF NOT EXISTS; here we only
// assert the runner hits the right SQL.
func TestEnsureSchema_ApplyAndIdempotent(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectExec(SchemaSQL).WillReturnResult(sqlmock.NewResult(0, 0))
	if err := New(db).EnsureSchema(context.Background()); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if !strings.Contains(SchemaSQL, "IF NOT EXISTS") {
		t.Fatalf("SchemaSQL must use IF NOT EXISTS for idempotency")
	}
}

// TestAlreadySeeded_ReturnsExistingIDs is the core idempotency check:
// re-running the cron on yesterday's window should find every message
// already recorded and skip them.
func TestAlreadySeeded_ReturnsExistingIDs(t *testing.T) {
	db, mock := newMock(t)
	rows := sqlmock.NewRows([]string{"message_id"}).
		AddRow("<m1@x>").
		AddRow("<m3@x>")
	mock.ExpectQuery("SELECT message_id FROM operator_practice_seed_log WHERE message_id IN ($1,$2,$3)").
		WithArgs("<m1@x>", "<m2@x>", "<m3@x>").
		WillReturnRows(rows)

	got, err := New(db).AlreadySeeded(context.Background(),
		[]string{"<m1@x>", "<m2@x>", "<m3@x>"})
	if err != nil {
		t.Fatalf("already seeded: %v", err)
	}
	if _, ok := got["<m1@x>"]; !ok {
		t.Errorf("expected <m1@x> in seen set")
	}
	if _, ok := got["<m2@x>"]; ok {
		t.Errorf("did not expect <m2@x> in seen set")
	}
	if _, ok := got["<m3@x>"]; !ok {
		t.Errorf("expected <m3@x> in seen set")
	}
}

// TestAlreadySeeded_EmptyInputShortcircuit — saves a round-trip when
// the caller passes an empty slice (e.g. all rows were classified
// without Message-IDs).
func TestAlreadySeeded_EmptyInputShortcircuit(t *testing.T) {
	db, _ := newMock(t)
	got, err := New(db).AlreadySeeded(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map; got %v", got)
	}
}

// TestAlreadySeeded_MissingTableSwallowed — fresh dev DB without the
// seed-log table is treated as "nothing seeded yet" so the very first
// cron run on a new env still works.
func TestAlreadySeeded_MissingTableSwallowed(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery("SELECT message_id FROM operator_practice_seed_log WHERE message_id IN ($1)").
		WithArgs("<m@x>").
		WillReturnError(errors.New(`pq: relation "operator_practice_seed_log" does not exist`))

	got, err := New(db).AlreadySeeded(context.Background(), []string{"<m@x>"})
	if err != nil {
		t.Fatalf("missing-table should not surface: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map; got %v", got)
	}
}

// TestRecordSeeded_Insert covers the success path + the upsert
// semantics.
func TestRecordSeeded_Insert(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectExec(`INSERT INTO operator_practice_seed_log (message_id, batch_id, category, lab_mailbox)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (message_id) DO NOTHING`).
		WithArgs("<m@x>", "batch-1", "interested", "op@gmail.lab").
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := New(db).RecordSeeded(context.Background(), "<m@x>", "batch-1", "interested", "op@gmail.lab"); err != nil {
		t.Fatalf("record: %v", err)
	}
}

// TestRecordSeeded_RejectsEmptyID prevents a misconfigured caller from
// inserting useless rows.
func TestRecordSeeded_RejectsEmptyID(t *testing.T) {
	db, _ := newMock(t)
	if err := New(db).RecordSeeded(context.Background(), "", "b", "c", "lab"); err == nil {
		t.Fatalf("expected error for empty messageID")
	}
}

// TestFilterUnseen_RemovesDuplicates is the aggregate idempotency
// helper used by labseed.Run. Combines AlreadySeeded + slice filter.
func TestFilterUnseen_RemovesDuplicates(t *testing.T) {
	db, mock := newMock(t)
	rows := sqlmock.NewRows([]string{"message_id"}).AddRow("<a>")
	mock.ExpectQuery("SELECT message_id FROM operator_practice_seed_log WHERE message_id IN ($1,$2)").
		WithArgs("<a>", "<b>").
		WillReturnRows(rows)

	got, err := New(db).FilterUnseen(context.Background(), []op.Message{
		{MessageID: "<a>"},
		{MessageID: "<b>"},
	})
	if err != nil {
		t.Fatalf("filter: %v", err)
	}
	if len(got) != 1 || got[0].MessageID != "<b>" {
		t.Fatalf("expected only <b>; got %+v", got)
	}
}

// TestNormalizeCategory covers the reply_type → fixture-category map.
// New reply types added upstream MUST get a row here so they don't
// fall through into "ambiguous" silently.
func TestNormalizeCategory(t *testing.T) {
	cases := map[string]string{
		"interested":   "interested",
		"meeting":      "interested",
		"OOO":          "ooo",
		"auto_ooo":     "ooo",
		"negative":     "not-interested",
		"objection":    "objection",
		"wrong_person": "wrong-person",
		"later":        "later",
		"spam":         "spam",
		"":             "ambiguous",
		"unknown_xyz":  "unknown_xyz",
	}
	for in, want := range cases {
		if got := normalizeCategory(in); got != want {
			t.Errorf("normalize(%q) = %q; want %q", in, got, want)
		}
	}
}

// keep time import live in case future tests need timestamps
var _ = time.Now
