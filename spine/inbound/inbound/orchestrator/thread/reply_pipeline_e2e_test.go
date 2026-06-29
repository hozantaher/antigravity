package thread

// TestReplyPipeline_Roundtrip — Sprint R6 of the reply-pipeline-recovery
// initiative (docs/initiatives/2026-05-13-reply-pipeline-recovery.md).
//
// Goal: a single regression-safe suite that exercises the FULL inbound
// reply pipeline against an in-memory PostgreSQL mock (sqlmock) so any
// future change to inbound.go, bounce.go, or the reply-matching ladder
// that breaks one of the five canonical scenarios fails this test.
//
// The five main scenarios mirror the initiative's R6 acceptance:
//
//   1. Real reply — RFC 5322 In-Reply-To matches send_events.rfc_message_id
//      (R2). The reply lands in outreach_messages with a non-zero
//      thread_id; no unmatched_inbound INSERT.
//   2. Bounce DSN — From: MAILER-DAEMON + Final-Recipient body parses
//      to a known contact (R3). contacts.email_status flips to
//      bounce_hold; send_events.status to bounced; operator_audit_log
//      receives a row; NO reply_inbox and NO unmatched_inbound INSERT.
//   3. Test message — Subject "[smoke] hello" hits R5 filter; no DB
//      writes anywhere; ProcessReply returns nil.
//   4. Unmatched fallback — In-Reply-To references an unknown
//      message-id, no email/domain match, no bounce → unmatched_inbound
//      INSERT, no contact or send_events mutation.
//   5. Threading — Re: Re: chain. The second reply's In-Reply-To points
//      at the first reply's Message-ID which itself was previously
//      stored in outreach_messages; lookupByMessageID matches via the
//      outreach_messages.message_id column and the reply records on the
//      same thread_id as the first.
//
// Plus five edge cases per HARD rule feedback_extreme_testing — the
// reply pipeline is state-mutating + security-sensitive so a single
// happy-path table is not enough.
//
// Citations:
//   - RFC 5322 §3.6.4 (In-Reply-To / References) — reply attribution
//     fields driving scenarios 1, 4, 5, and the References-fallback
//     edge case.
//   - RFC 3464 §2.3.2 (Final-Recipient) — DSN field driving scenarios
//     2 and the "no extractable recipient" edge case.
//   - feedback_schema_verify_before_sql T0 — every INSERT/UPDATE/Scan
//     here mirrors the column tuple emitted by inbound.go (verified
//     against the live regex matchers in inbound_rfc_match_test.go
//     and unmatched_bounce_test.go).
//   - feedback_audit_log_on_mutations T0 — scenario 2 expects an
//     operator_audit_log INSERT in the same path as the contact UPDATE.
//   - feedback_no_speculation T0 — no synthesized DB columns; every
//     mocked query lifts the live SQL string from inbound.go.

import (
	"context"
	"strings"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─── Scenario 1: Real reply — RFC 5322 matching via send_events.rfc_message_id

// TestReplyPipeline_RealReply_MatchesSendEventByRfcMessageID exercises the
// post-R2 path: outreach_messages misses, send_events.rfc_message_id hits,
// the inbound is recorded against the matched thread, and the reply-event
// counters increment.
func TestReplyPipeline_RealReply_MatchesSendEventByRfcMessageID(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchToThread → lookupByMessageID:
	//   1. outreach_messages.message_id → miss (zero rows).
	//   2. send_events.rfc_message_id → hit (R2 canonical lookup).
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("abc123@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("abc123@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(501, 901))

	// RecordInbound: INSERT into outreach_messages (no attachments path).
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7001))
	// notifyInbound → pg_notify.
	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// EventLogger.LogReplied → outreach_events INSERT + counter UPDATE.
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET total_replied`).
		WithArgs(901).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// "Ano, pošlete prosím detaily" → humanize.ReplyInterested →
	// Manager.MarkReplied + leads UPSERT.
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(string(ActionWaitReply), int64(501)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO leads`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "<reply-from-customer@firma.cz>",
		InReplyTo:  "<abc123@seznam.cz>",
		From:       "Zákazník <kontakt@firma.cz>",
		Subject:    "Re: Vaše nabídka",
		BodyPlain:  "Ano, pošlete prosím detaily k té nabídce.",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Scenario 2: Bounce DSN — unmatched bounce flips contact to bounce_hold

// TestReplyPipeline_Bounce_FlipsContactToBounceHold mirrors the R3 path
// for a DSN that lookupByMessageID can't attribute. The processor must
// extract the recipient from Final-Recipient, flip contacts.email_status
// to bounce_hold, mark send_events bounced, and write operator_audit_log
// — without ever inserting into unmatched_inbound.
func TestReplyPipeline_Bounce_FlipsContactToBounceHold(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchToThread misses (legacy DSN — no rfc_message_id link).
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("orig-out-123@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("orig-out-123@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	// From: MAILER-DAEMON@seznam.cz → extractEmail lowercases. matchByEmail
	// runs and misses; matchByDomain is skipped because seznam.cz is freemail.
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("mailer-daemon@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// processUnmatchedBounce:
	//   1. UPDATE contacts → bounce_hold, RETURNING id.
	//   2. UPDATE send_events status → bounced.
	//   3. audit.Log → INSERT operator_audit_log.
	mock.ExpectQuery(`UPDATE contacts\s+SET email_status = 'bounce_hold'`).
		WithArgs("jan@nezijici.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(42)))
	mock.ExpectExec(`UPDATE send_events SET status = 'bounced'`).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Real-world Postfix DSN bytes: From MAILER-DAEMON, Status 5.1.1,
	// Final-Recipient rfc822;jan@nezijici.cz — RFC 3464 §2.3.2.
	raw := RawInbound{
		MessageID: "<dsn-bounce-1@mta.seznam.cz>",
		InReplyTo: "<orig-out-123@seznam.cz>",
		From:      "MAILER-DAEMON@seznam.cz",
		Subject:   "Undelivered Mail Returned to Sender",
		BodyPlain: "Status: 5.1.1\r\n" +
			"Final-Recipient: rfc822;jan@nezijici.cz\r\n" +
			"Diagnostic-Code: smtp; 550 User unknown",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Scenario 3: Test message — R5 subject filter discards before any DB call

// TestReplyPipeline_TestMessage_FilteredBeforeAnyDBCall verifies the R5
// gate at the top of ProcessReply: a subject containing "[smoke]" must
// short-circuit; sqlmock will fail the test if ANY query is issued.
func TestReplyPipeline_TestMessage_FilteredBeforeAnyDBCall(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No mock.Expect* calls — any DB hit is a test failure.

	raw := RawInbound{
		MessageID:  "<smoke-1@self.test>",
		Subject:    "[smoke] hello",
		From:       "self@balkanmotors.cz",
		BodyPlain:  "synthetic probe",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply on test message must return nil, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("test-filter must skip ALL queries: %v", err)
	}
}

// ─── Scenario 4: Unmatched fallback — parks in unmatched_inbound

// TestReplyPipeline_Unmatched_ParksInUnmatchedInbound exercises the
// no-match path: legacy/unknown In-Reply-To, freemail sender so the
// domain rung is skipped, no bounce → parkUnattributed.
func TestReplyPipeline_Unmatched_ParksInUnmatchedInbound(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// Message-ID rung — both columns miss.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("neznáme@cosi.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("neznáme@cosi.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// Email rung — no thread.
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("nikdo@gmail.com").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	// Domain rung short-circuits — gmail.com is freemail.

	// parkUnattributed → INSERT INTO unmatched_inbound RETURNING id.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(8001)))

	raw := RawInbound{
		MessageID:  "<orphan-reply@gmail.com>",
		InReplyTo:  "<neznáme@cosi.cz>",
		From:       "nikdo@gmail.com",
		Subject:    "Re: ahoj",
		BodyPlain:  "Tohle je odpověď, ale nevíme komu patří.",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Scenario 5: Threading — Re: Re: chain matches original thread

// TestReplyPipeline_Threading_ReReChainKeepsThreadID — RFC 5322 §3.6.4
// threading. The customer's first reply was stored in outreach_messages
// (with message_id="reply-1@firma.cz"). A second reply comes in with
// In-Reply-To: <reply-1@firma.cz>. Attribution must hit the
// outreach_messages column (NOT a new send_events row) and record the
// second inbound on the SAME thread as the first.
func TestReplyPipeline_Threading_ReReChainKeepsThreadID(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// lookupByMessageID hits outreach_messages on the first try —
	// send_events query is NOT issued.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("reply-1@firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}).
			AddRow(601, 1601))

	// RecordInbound: same thread_id as the first reply.
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7002))
	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	// Event + counter for the replied event.
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(2)))
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET total_replied`).
		WithArgs(1601).
		WillReturnResult(sqlmock.NewResult(0, 1))

	// Body keyword "drahé" → humanize.ReplyObjection → Manager.MarkReplied
	// with ActionWaitReply and NO upsertLead (objection branch doesn't
	// fire the lead UPSERT). This keeps the test focused on the
	// threading invariant: same thread_id as the first reply.
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(string(ActionWaitReply), int64(601)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "<reply-2@firma.cz>",
		InReplyTo:  "<reply-1@firma.cz>",
		References: "<orig-out@seznam.cz> <reply-1@firma.cz>",
		From:       "Zákazník <kontakt@firma.cz>",
		Subject:    "Re: Re: Vaše nabídka",
		// "drahé" → ClassifyReply returns Objection (objKeywords runs
		// before posKeywords). Objection hits MarkReplied + no lead UPSERT.
		BodyPlain:  "Děkujeme za nabídku, ale je to pro nás moc drahé.",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Edge case A: Empty In-Reply-To, References hits send_events ───────────

// TestReplyPipeline_Edge_ReferencesFallbackMatches — the broken-chain
// pattern: clients (especially webmail) sometimes drop In-Reply-To but
// keep References. Per RFC 5322 §3.6.4 the most-recent token of
// References is the parent. The matcher must walk References when
// In-Reply-To is empty.
func TestReplyPipeline_Edge_ReferencesFallbackMatches(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// Walk references — first token misses, second hits send_events.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("ref-a@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("ref-a@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("ref-b@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("ref-b@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(701, 1701))

	// RecordInbound + counter + thread UPDATE. Body uses "konkurenc"
	// (objection branch) so we skip the upsertLead path that fires for
	// Interested/Meeting — keeps the test scoped to the References fallback.
	mock.ExpectQuery(`INSERT INTO outreach_messages`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7003))
	mock.ExpectExec(`SELECT pg_notify\('thread_inbound'`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`INSERT INTO outreach_events`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(3)))
	mock.ExpectExec(`UPDATE outreach_contacts\s+SET total_replied`).
		WithArgs(1701).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE outreach_threads`).
		WithArgs(string(ActionWaitReply), int64(701)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	raw := RawInbound{
		MessageID:  "<missing-irt@firma.cz>",
		References: "<ref-a@host.cz> <ref-b@seznam.cz>",
		From:       "boss@firma.cz",
		Subject:    "Re: Vaše nabídka",
		BodyPlain:  "Posíláme informaci, ale máme problém s konkurencí.",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Edge case B: Bounce with no extractable recipient → graceful park ─────

// TestReplyPipeline_Edge_BounceWithNoRecipient_FallsThroughToPark — the
// pipeline must never crash when a DSN body lacks both Final-Recipient
// AND any <email> token. The unmatched-bounce helper returns handled=false
// and the caller parks the message in unmatched_inbound for operator
// review.
func TestReplyPipeline_Edge_BounceWithNoRecipient_FallsThroughToPark(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchToThread misses everywhere.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("phantom-out@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("phantom-out@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("mailer-daemon@mta.local").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("mta.local").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// DetectBounce → BounceHard via subject. processUnmatchedBounce
	// extracts nothing (no Final-Recipient, no <addr>) → handled=false,
	// caller falls through to parkUnattributed.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(8002)))

	raw := RawInbound{
		MessageID:  "<mystery-dsn@mta.local>",
		InReplyTo:  "<phantom-out@seznam.cz>",
		From:       "MAILER-DAEMON@mta.local",
		Subject:    "Undelivered Mail Returned to Sender",
		BodyPlain:  "Status: 5.0.0\r\nTemporary mail server problem. No address parseable.",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Edge case C: Test filter is case-insensitive ──────────────────────────

// TestReplyPipeline_Edge_TestMessage_CaseInsensitive — operators
// hand-craft smoke subjects like "[SMOKE] foo" and "[Test-A] bar".
// The R5 filter must match all-cap variants.
func TestReplyPipeline_Edge_TestMessage_CaseInsensitive(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	for _, subj := range []string{
		"[SMOKE] uppercase pre-flight",
		"[SmOkE] mixed case ping",
		"[Test-A] variant A",
		"PROBE upper-case",
	} {
		raw := RawInbound{
			MessageID:  "<smoke-edge@self.test>",
			Subject:    subj,
			From:       "self@balkanmotors.cz",
			BodyPlain:  "synthetic",
			ReceivedAt: time.Now(),
		}
		if err := p.ProcessReply(context.Background(), raw); err != nil {
			t.Fatalf("ProcessReply on %q: %v", subj, err)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("case-insensitive filter must skip ALL queries: %v", err)
	}
}

// ─── Edge case D: Orphan In-Reply-To, broken chain → unmatched ─────────────

// TestReplyPipeline_Edge_OrphanInReplyTo_ParksUnmatched — broken
// References chain (none of the chain tokens match) and the From
// address is unknown to us. End state: unmatched_inbound row.
func TestReplyPipeline_Edge_OrphanInReplyTo_ParksUnmatched(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// In-Reply-To miss + References tokens miss (three tokens — exercises
	// the loop body more than once).
	for _, ref := range []string{
		"orphan-irt@host.cz",
		"orphan-ref1@host.cz",
		"orphan-ref2@host.cz",
	} {
		mock.ExpectQuery(`FROM outreach_messages m`).
			WithArgs(ref).
			WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
		mock.ExpectQuery(`FROM send_events se`).
			WithArgs(ref).
			WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	}

	// Email rung — no thread.
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("orphan@cizí.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	// Domain rung — unknown domain (zero icos).
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("cizí.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	// parkUnattributed.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(8003)))

	raw := RawInbound{
		MessageID:  "<orphan-msg@cizí.cz>",
		InReplyTo:  "<orphan-irt@host.cz>",
		References: "<orphan-ref1@host.cz> <orphan-ref2@host.cz>",
		From:       "orphan@cizí.cz",
		Subject:    "Re: něco",
		BodyPlain:  "Není to z naší databáze.",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Edge case E: Bounce already-bounced contact is a no-op flip ────────────

// TestReplyPipeline_Edge_BounceAlreadyBouncedContact_NoOp — the WHERE
// clause in processUnmatchedBounce excludes contacts already in
// bounce_hold or spamtrap. sqlmock returns zero rows from RETURNING
// → ErrNoRows → handled=false → caller parks.
func TestReplyPipeline_Edge_BounceAlreadyBouncedContact_NoOp(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchToThread misses.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("orig-bounced@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("orig-bounced@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("postmaster@seznam.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))
	// seznam.cz is freemail — matchByDomain short-circuits, no COUNT.

	// processUnmatchedBounce — contact already in bounce_hold, so the
	// UPDATE matches zero rows → RETURNING is empty → ErrNoRows →
	// handled=false. No audit row, no send_events UPDATE.
	mock.ExpectQuery(`UPDATE contacts\s+SET email_status = 'bounce_hold'`).
		WithArgs("already@bounced.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id"})) // 0 rows

	// Falls through to parkUnattributed.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(8004)))

	raw := RawInbound{
		MessageID: "<dup-dsn@mta.seznam.cz>",
		InReplyTo: "<orig-bounced@seznam.cz>",
		From:      "postmaster@seznam.cz",
		Subject:   "Undelivered Mail Returned to Sender",
		BodyPlain: "Status: 5.1.1\r\n" +
			"Final-Recipient: rfc822;already@bounced.cz\r\n" +
			"Diagnostic-Code: smtp; 550 still bouncing",
		ReceivedAt: time.Now(),
	}
	if err := p.ProcessReply(context.Background(), raw); err != nil {
		t.Fatalf("ProcessReply: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// ─── Subject-prefix guard: sanity check on the constant list ───────────────

// TestReplyPipeline_TestSubjectPatternsCoverInitiativeR5 — the R5 spec
// pinned six prefixes; if a future refactor drops one this guard fails
// before the regression hits production traffic.
func TestReplyPipeline_TestSubjectPatternsCoverInitiativeR5(t *testing.T) {
	required := []string{
		"[smoke]",
		"[smoke-clean]",
		"[hdr-test]",
		"[test-A]",
		"[test-B]",
		"probe ",
	}
	have := map[string]bool{}
	for _, p := range TestSubjectPatterns {
		have[strings.ToLower(p)] = true
	}
	for _, r := range required {
		if !have[strings.ToLower(r)] {
			t.Errorf("R5 spec requires test prefix %q; missing from TestSubjectPatterns", r)
		}
	}
}
