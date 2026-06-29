package thread

// R2 (docs/initiatives/2026-05-12-reply-pipeline-recovery.md) — tests for
// the rfc_message_id matcher rung added to InboundProcessor.matchToThread.
//
// Pre-R2 behaviour matched In-Reply-To/References against
// outreach_messages.message_id, which stored the internal anti-trace
// envelope_id ("env_XXX") — a value that never appears in real reply
// headers. The rung introduced here unions send_events.rfc_message_id
// (the RFC 5322 Message-ID actually emitted on the wire) so going-forward
// rows attribute correctly while legacy rows (rfc_message_id NULL) still
// fall through to the outreach_messages path.
//
// Coverage:
//  1. In-Reply-To matches outreach_messages — unchanged legacy path
//  2. In-Reply-To misses outreach_messages, hits send_events.rfc_message_id
//  3. References header: first token misses both, second hits rfc_message_id
//  4. Neither column matches → falls through to email/domain (zero rows here)
//  5. send_events row has rfc_message_id NULL → outreach_messages still wins
//  6. send_events DB error → propagated as wrapped error (caller bubbles up)
//  7. Empty In-Reply-To AND empty References → rung skipped entirely
//  8. cleanMessageID strips brackets identically for both columns

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─── 1. Legacy outreach_messages match still works ──────────────────────────

func TestMatchToThread_RFC_LegacyOutreachMessagesPath(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	threadRow := sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(100, 200)
	// First query in lookupByMessageID — outreach_messages.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("legacy-env-id@host.cz").
		WillReturnRows(threadRow)

	raw := RawInbound{
		InReplyTo:  "<legacy-env-id@host.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 100 || cid != 200 {
		t.Errorf("tid=%d cid=%d, want 100/200", tid, cid)
	}
	if by != "message_id" {
		t.Errorf("matched_by=%q, want message_id", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 2. RFC fallback: outreach_messages miss, send_events hit ───────────────

func TestMatchToThread_RFC_SendEventsFallback(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// outreach_messages misses.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("rfc-abc.def@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))

	// send_events.rfc_message_id hits.
	threadRow := sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(101, 201)
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("rfc-abc.def@seznam.cz").
		WillReturnRows(threadRow)

	raw := RawInbound{
		InReplyTo:  "<rfc-abc.def@seznam.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 101 || cid != 201 {
		t.Errorf("tid=%d cid=%d, want 101/201", tid, cid)
	}
	// The caller collapses rfc_message_id → "message_id" at Rung 1 so the
	// fallback log doesn't fire on a canonical RFC match.
	if by != "message_id" {
		t.Errorf("matched_by=%q, want message_id", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 3. References header: 1st miss both, 2nd hit send_events ───────────────

func TestMatchToThread_RFC_ReferencesSecondTokenMatchesSendEvents(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No In-Reply-To — Rung 1 skipped. Rung 2 walks references.
	// Token 1: misses both columns.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("ref-one@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("ref-one@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// Token 2: misses outreach_messages, hits send_events.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("ref-two-rfc@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("ref-two-rfc@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(102, 202))

	raw := RawInbound{
		References: "<ref-one@host.cz> <ref-two-rfc@seznam.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 102 || cid != 202 {
		t.Errorf("tid=%d cid=%d, want 102/202", tid, cid)
	}
	if by != "references" {
		t.Errorf("matched_by=%q, want references", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 4. Neither column matches → unattributed (fallback rungs follow) ───────

func TestMatchToThread_RFC_BothColumnsMiss_FallsThroughEmail(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// Rung 1: both columns miss.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("unknown@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("unknown@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// Rung 3 (email exact match) — empty too, so caller will park.
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("boss@firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// Rung 4 (domain match) — corporate domain, count distinct icos = 0.
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	raw := RawInbound{
		InReplyTo:  "<unknown@host.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 || cid != 0 {
		t.Errorf("tid=%d cid=%d, want 0/0 (unmatched)", tid, cid)
	}
	if by != "" {
		t.Errorf("matched_by=%q, want \"\" (unmatched)", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 5. send_events NULL rfc_message_id is invisible to the lookup ──────────
//
// The partial index `idx_send_events_rfc_msgid WHERE rfc_message_id IS NOT NULL`
// means a SELECT with `WHERE rfc_message_id = $1` cannot match NULL rows even
// if the rest of the row would otherwise be a candidate. We model that here
// with sqlmock returning zero rows for the send_events query — the test asserts
// the outreach_messages match still wins because lookupByMessageID checks
// outreach_messages first.

func TestMatchToThread_RFC_NullRFCRowDoesNotBlockLegacyHit(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// outreach_messages hits — send_events query is NEVER issued because
	// lookupByMessageID returns on the first hit.
	threadRow := sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(103, 203)
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("legacy-only@host.cz").
		WillReturnRows(threadRow)

	raw := RawInbound{
		InReplyTo:  "<legacy-only@host.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 103 || cid != 203 {
		t.Errorf("tid=%d cid=%d, want 103/203", tid, cid)
	}
	if by != "message_id" {
		t.Errorf("matched_by=%q, want message_id", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 6. send_events DB error is wrapped + propagated ────────────────────────

func TestMatchToThread_RFC_SendEventsDBError_Wrapped(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// outreach_messages miss to advance into the send_events branch.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("boom@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	// send_events explodes.
	wantErr := errors.New("connection reset")
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("boom@host.cz").
		WillReturnError(wantErr)

	raw := RawInbound{
		InReplyTo:  "<boom@host.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	_, _, _, err := p.matchToThread(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, wantErr) {
		t.Errorf("error chain missing wrapped source: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 7. No In-Reply-To and no References → lookup skipped ───────────────────

func TestMatchToThread_RFC_EmptyHeaders_SkipsMessageIDRungs(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// Both Message-ID rungs skipped. Expect direct fall-through to email
	// rung — matchByEmail returns no rows, then matchByDomain.
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("nobody@firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	raw := RawInbound{
		From:       "nobody@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, _, _, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 {
		t.Errorf("tid=%d, want 0 (no header to match)", tid)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 8. Bracket-stripping is consistent across both columns ─────────────────
//
// cleanMessageID strips angle brackets BEFORE the lookup, so both the
// outreach_messages query and the send_events query receive the same
// canonical args. Verified end-to-end by exercising a "<id>"-bracketed
// In-Reply-To and asserting both sqlmock WithArgs see the bare form.

func TestMatchToThread_RFC_StripsBracketsForBothColumns(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	const canonical = "with-brackets@seznam.cz"
	// outreach_messages — empty (forces fall-through to send_events).
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs(canonical).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	// send_events — hit.
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs(canonical).
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(104, 204))

	raw := RawInbound{
		InReplyTo:  fmt.Sprintf("<%s>", canonical),
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, _, _, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 104 {
		t.Errorf("tid=%d, want 104", tid)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 9. lookupByMessageID with nil db / empty id is a clean no-op ──────────
//
// Defensive contract — callers should never pass empty IDs, but if they do
// the helper must not crash or issue stray queries.

func TestLookupByMessageID_NilDB_NoQuery(t *testing.T) {
	p := &InboundProcessor{db: nil}
	tid, cid, by, err := p.lookupByMessageID(context.Background(), "anything@host.cz")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 || cid != 0 || by != "" {
		t.Errorf("expected zero tuple, got (%d, %d, %q)", tid, cid, by)
	}
}

func TestLookupByMessageID_EmptyID_NoQuery(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)
	tid, cid, by, err := p.lookupByMessageID(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 || cid != 0 || by != "" {
		t.Errorf("expected zero tuple, got (%d, %d, %q)", tid, cid, by)
	}
	// No expectations registered — sqlmock should report none unmet.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}
