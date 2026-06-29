package thread

// Tests for the reply-attribution fallback ladder (#873).
//
// Coverage:
//  1.  Happy path: Message-ID (In-Reply-To) match — unchanged existing path
//  2.  Happy path: References header match
//  3.  Fallback 1: exact email match → single active thread
//  4.  Fallback 1: exact email match → zero threads → unattributed
//  5.  Fallback 1: exact email match → multiple threads → unattributed (ambiguous)
//  6.  Fallback 2: domain match → single corporate domain, single ICO
//  7.  Fallback 2: domain match → webmail domain (gmail.com) → skipped → unattributed
//  8.  Fallback 2: domain match → multiple ICOs share domain → skipped → unattributed
//  9.  Fallback 2: domain match → unknown domain (zero contacts) → unattributed
// 10.  extractEmail: display-name form
// 11.  extractEmail: bare address form
// 12.  extractEmail: empty / no @ → empty
// 13.  domainFromEmail: valid email
// 14.  domainFromEmail: no @ → empty
// 15.  isFreemailDomain: known freemail (gmail.com)
// 16.  isFreemailDomain: known CZ freemail (seznam.cz)
// 17.  isFreemailDomain: corporate domain → false
// 18.  parkUnattributed: DB error is logged but not propagated

import (
	"context"
	"errors"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ─── 1. Message-ID match (In-Reply-To) ──────────────────────────────────────

func TestMatchToThread_InReplyTo_Match(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	threadRow := sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(10, 20)
	mock.ExpectQuery(`SELECT m.thread_id, t.contact_id`).
		WithArgs("msg-abc@host.cz").
		WillReturnRows(threadRow)

	raw := RawInbound{
		InReplyTo:  "<msg-abc@host.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 10 || cid != 20 {
		t.Errorf("tid=%d cid=%d, want 10/20", tid, cid)
	}
	if by != "message_id" {
		t.Errorf("matched_by=%q, want message_id", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 2. References header match ─────────────────────────────────────────────

func TestMatchToThread_References_Match(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// R2 (rfc_message_id rung) — each Message-ID lookup now consults
	// BOTH outreach_messages and send_events. Misses fall through.

	// In-Reply-To miss — outreach_messages + send_events.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("unknown@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("unknown@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// References first token miss.
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("ref-one@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "contact_id"}))
	mock.ExpectQuery(`FROM send_events se`).
		WithArgs("ref-one@host.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// References second token hits outreach_messages — send_events
	// query is NOT issued because lookupByMessageID returns on first hit.
	threadRow := sqlmock.NewRows([]string{"thread_id", "contact_id"}).AddRow(11, 21)
	mock.ExpectQuery(`FROM outreach_messages m`).
		WithArgs("ref-two@host.cz").
		WillReturnRows(threadRow)

	raw := RawInbound{
		InReplyTo:  "<unknown@host.cz>",
		References: "<ref-one@host.cz> <ref-two@host.cz>",
		From:       "boss@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 11 || cid != 21 {
		t.Errorf("tid=%d cid=%d, want 11/21", tid, cid)
	}
	if by != "references" {
		t.Errorf("matched_by=%q, want references", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 3. Fallback 1: exact email match → single thread ───────────────────────

func TestMatchToThread_FallbackEmail_SingleThread(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No In-Reply-To, no References — both queries return no rows
	// (matchToThread skips the Message-ID paths when headers are empty)

	// matchByEmail: single thread
	emailRows := sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(12, 22)
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("boss@firma.cz").
		WillReturnRows(emailRows)

	raw := RawInbound{
		From:       "Boss Surname <boss@firma.cz>",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 12 || cid != 22 {
		t.Errorf("tid=%d cid=%d, want 12/22", tid, cid)
	}
	if by != "email_exact" {
		t.Errorf("matched_by=%q, want email_exact", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 4. Fallback 1: exact email match → no thread ───────────────────────────

func TestMatchToThread_FallbackEmail_NoThread_Unattributed(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchByEmail: no rows
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("newcontact@firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// matchByDomain: ico count = 0 (no contacts for this domain)
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	raw := RawInbound{
		From:       "newcontact@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 || cid != 0 {
		t.Errorf("tid=%d cid=%d, want 0/0", tid, cid)
	}
	if by != "" {
		t.Errorf("matched_by=%q, want empty", by)
	}
}

// ─── 5. Fallback 1: exact email match → multiple threads (ambiguous) ─────────

func TestMatchToThread_FallbackEmail_MultipleThreads_Ambiguous(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchByEmail: two rows → ambiguous
	emailRows := sqlmock.NewRows([]string{"id", "contact_id"}).
		AddRow(1, 10).
		AddRow(2, 10)
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("dup@firma.cz").
		WillReturnRows(emailRows)

	// matchByDomain will be tried — return 0 for ico count to keep it clean
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("firma.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	raw := RawInbound{
		From:       "dup@firma.cz",
		ReceivedAt: time.Now(),
	}
	tid, _, _, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 {
		t.Errorf("tid=%d, want 0 (ambiguous)", tid)
	}
}

// ─── 6. Fallback 2: domain match → single corporate domain, single ICO ───────

func TestMatchToThread_FallbackDomain_CorporateDomain_Match(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchByEmail: no rows (boss@ is a new address)
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("boss@strojirny.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// matchByDomain: single ICO
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("strojirny.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	// matchByDomain: single thread
	domainRows := sqlmock.NewRows([]string{"id", "contact_id"}).AddRow(13, 23)
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("strojirny.cz").
		WillReturnRows(domainRows)

	raw := RawInbound{
		From:       "Boss <boss@strojirny.cz>",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 13 || cid != 23 {
		t.Errorf("tid=%d cid=%d, want 13/23", tid, cid)
	}
	if by != "domain_match" {
		t.Errorf("matched_by=%q, want domain_match", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 7. Fallback 2: webmail domain → skipped ────────────────────────────────

func TestMatchToThread_FallbackDomain_Gmail_Skipped(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchByEmail: no rows
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("boss@gmail.com").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// isFreemailDomain("gmail.com") == true → matchByDomain is NOT called.
	// So we expect no more DB queries.

	raw := RawInbound{
		From:       "boss@gmail.com",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 || cid != 0 {
		t.Errorf("tid=%d cid=%d, want 0/0 (gmail skipped)", tid, cid)
	}
	if by != "" {
		t.Errorf("matched_by=%q, want empty", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 8. Fallback 2: multiple ICOs share domain → skipped ─────────────────────

func TestMatchToThread_FallbackDomain_MultipleICOs_Skipped(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchByEmail: no rows
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("office@shared-isp.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// matchByDomain: 2 ICOs → ambiguous, skip
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("shared-isp.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	raw := RawInbound{
		From:       "office@shared-isp.cz",
		ReceivedAt: time.Now(),
	}
	tid, cid, by, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 || cid != 0 {
		t.Errorf("tid=%d cid=%d, want 0/0 (multi-ICO)", tid, cid)
	}
	if by != "" {
		t.Errorf("matched_by=%q, want empty", by)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ─── 9. Fallback 2: unknown domain (0 contacts) → unattributed ───────────────

func TestMatchToThread_FallbackDomain_UnknownDomain_Unattributed(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// matchByEmail: no rows
	mock.ExpectQuery(`SELECT t\.id, t\.contact_id`).
		WithArgs("fwd@otherfirm.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id", "contact_id"}))

	// matchByDomain: 0 ICOs → skip
	mock.ExpectQuery(`SELECT COUNT\(DISTINCT`).
		WithArgs("otherfirm.cz").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))

	raw := RawInbound{
		From:       "fwd@otherfirm.cz",
		ReceivedAt: time.Now(),
	}
	tid, _, _, err := p.matchToThread(context.Background(), raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tid != 0 {
		t.Errorf("tid=%d, want 0 (unknown domain)", tid)
	}
}

// ─── 10. extractEmail: display-name form ──────────────────────────────────────

func TestExtractEmail_DisplayName(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"Boss Name <boss@firma.cz>", "boss@firma.cz"},
		{"  Boss  <BOSS@FIRMA.CZ>  ", "boss@firma.cz"},
		{"<info@firma.cz>", "info@firma.cz"},
	}
	for _, tt := range tests {
		got := extractEmail(tt.in)
		if got != tt.want {
			t.Errorf("extractEmail(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ─── 11. extractEmail: bare address form ──────────────────────────────────────

func TestExtractEmail_Bare(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"boss@firma.cz", "boss@firma.cz"},
		{"  BOSS@FIRMA.CZ  ", "boss@firma.cz"},
	}
	for _, tt := range tests {
		got := extractEmail(tt.in)
		if got != tt.want {
			t.Errorf("extractEmail(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ─── 12. extractEmail: empty / no @ ──────────────────────────────────────────

func TestExtractEmail_Empty(t *testing.T) {
	cases := []string{"", "No Name At All", "not-an-email"}
	for _, c := range cases {
		if got := extractEmail(c); got != "" {
			t.Errorf("extractEmail(%q) = %q, want empty", c, got)
		}
	}
}

// ─── 13. domainFromEmail: valid email ────────────────────────────────────────

func TestDomainFromEmail_Valid(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"boss@strojirny.cz", "strojirny.cz"},
		{"BOSS@FIRMA.CZ", "firma.cz"},
		{"info@sub.domain.com", "sub.domain.com"},
	}
	for _, tt := range tests {
		got := domainFromEmail(tt.in)
		if got != tt.want {
			t.Errorf("domainFromEmail(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ─── 14. domainFromEmail: no @ → empty ───────────────────────────────────────

func TestDomainFromEmail_NoAt(t *testing.T) {
	cases := []string{"", "notanemail", "foo"}
	for _, c := range cases {
		if got := domainFromEmail(c); got != "" {
			t.Errorf("domainFromEmail(%q) = %q, want empty", c, got)
		}
	}
}

// ─── 15. isFreemailDomain: known global freemail ─────────────────────────────

func TestIsFreemailDomain_Gmail(t *testing.T) {
	for _, d := range []string{"gmail.com", "GMAIL.COM", "  gmail.com  "} {
		if !isFreemailDomain(d) {
			t.Errorf("isFreemailDomain(%q) = false, want true", d)
		}
	}
}

// ─── 16. isFreemailDomain: known CZ freemail ─────────────────────────────────

func TestIsFreemailDomain_SeznamCz(t *testing.T) {
	czFreemail := []string{
		"seznam.cz", "email.cz", "centrum.cz",
		"volny.cz", "atlas.cz", "azet.cz",
	}
	for _, d := range czFreemail {
		if !isFreemailDomain(d) {
			t.Errorf("isFreemailDomain(%q) = false, want true", d)
		}
	}
}

// ─── 17. isFreemailDomain: corporate domain → false ──────────────────────────

func TestIsFreemailDomain_Corporate(t *testing.T) {
	corporate := []string{
		"strojirny.cz", "firma.cz", "kovarna.cz",
		"example.com", "company.de",
	}
	for _, d := range corporate {
		if isFreemailDomain(d) {
			t.Errorf("isFreemailDomain(%q) = true, want false", d)
		}
	}
}

// ─── 18. parkUnattributed: DB error logged AND propagated (poller-retry guard) ─
// ─── 19. insertReplyInbox: MailboxAddr fallback resolves mailbox_id ──────────
//
// G3.1 fix: when matchToReplyInbox returns MailboxID=0 (no send_events row for
// a legacy contact), insertReplyInbox must issue a secondary lookup using
// raw.MailboxAddr so the polling mailbox is still recorded.
//
// Coverage:
//  19a. MailboxAddr provided + outreach_mailboxes hit → mailbox_id resolved
//  19b. MailboxAddr provided + outreach_mailboxes miss → mailbox_id stays NULL
//  19c. MailboxAddr empty → secondary lookup never issued (no extra query)

func TestInsertReplyInbox_MailboxAddrFallback_Hit(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// Fallback lookup: outreach_mailboxes by from_address.
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes WHERE from_address`).
		WithArgs("hozan.taher.75@post.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1180)))

	// INSERT with mailbox_id=1180 (resolved via fallback).
	// Arg order matches insertReplyInbox: campaign_id, contact_id, mailbox_id,
	// send_event_id, from_email, subject, received_at, body_text, body_html,
	// attachments_meta, headers_json, dedup_message_id.
	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WithArgs(
			int64(457),       // $1 campaign_id
			int64(99),        // $2 contact_id
			int64(1180),      // $3 mailbox_id (fallback)
			nil,              // $4 send_event_id
			"x@firma.cz",    // $5 from_email (rb.FromEmail)
			"Re: test",      // $6 subject
			sqlmock.AnyArg(), // $7 received_at
			nil,              // $8 body_text (parsed=nil)
			nil,              // $9 body_html
			nil,              // $10 attachments_meta
			nil,              // $11 headers_json
			"",               // $12 dedup message-id (empty: parsed=nil → received_at key)
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	raw := RawInbound{
		From:        "x@firma.cz",
		Subject:     "Re: test",
		ReceivedAt:  time.Now(),
		MailboxAddr: "hozan.taher.75@post.cz",
	}
	rb := replyInboxMatch{
		ContactID:  99,
		CampaignID: 457,
		MailboxID:  0,        // no send_events row — fallback must kick in
		FromEmail:  "x@firma.cz",
	}
	if err := p.insertReplyInbox(context.Background(), raw, rb, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestInsertReplyInbox_MailboxAddrFallback_Miss(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// Fallback lookup: no matching mailbox row.
	mock.ExpectQuery(`SELECT id FROM outreach_mailboxes WHERE from_address`).
		WithArgs("unknown@post.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id"}))

	// INSERT with mailbox_id=NULL (fallback missed).
	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WithArgs(
			int64(457),
			int64(99),
			nil,              // mailbox_id stays NULL
			nil,
			"x@firma.cz",
			"Re: test",
			sqlmock.AnyArg(),
			nil,              // body_text
			nil,              // body_html
			nil,              // attachments_meta
			nil,              // headers_json
			"",               // dedup message-id (empty: parsed=nil → received_at key)
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	raw := RawInbound{
		From:        "x@firma.cz",
		Subject:     "Re: test",
		ReceivedAt:  time.Now(),
		MailboxAddr: "unknown@post.cz",
	}
	rb := replyInboxMatch{ContactID: 99, CampaignID: 457, FromEmail: "x@firma.cz"}
	if err := p.insertReplyInbox(context.Background(), raw, rb, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestInsertReplyInbox_NoMailboxAddr_SkipsFallback(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	// No MailboxAddr → no fallback query issued.
	mock.ExpectExec(`INSERT INTO reply_inbox`).
		WithArgs(
			int64(457),
			int64(99),
			nil, nil,
			"x@firma.cz",
			"Re: test",
			sqlmock.AnyArg(),
			nil,              // body_text
			nil,              // body_html
			nil,              // attachments_meta
			nil,              // headers_json
			"",               // dedup message-id (empty: parsed=nil → received_at key)
		).
		WillReturnResult(sqlmock.NewResult(1, 1))

	raw := RawInbound{
		From:       "x@firma.cz",
		Subject:    "Re: test",
		ReceivedAt: time.Now(),
		// MailboxAddr intentionally empty
	}
	rb := replyInboxMatch{ContactID: 99, CampaignID: 457, FromEmail: "x@firma.cz"}
	if err := p.insertReplyInbox(context.Background(), raw, rb, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestParkUnattributed_DBError_Propagated(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WillReturnError(errors.New("connection lost"))

	// RCA 2026-06-01: a persist failure here MUST be returned (not swallowed)
	// so the caller propagates it and the poller keeps the message below the
	// UID watermark for retry, instead of advancing past a never-stored reply.
	err := p.parkUnattributed(context.Background(), RawInbound{
		MessageID:  "test-msg-id",
		From:       "x@y.cz",
		ReceivedAt: time.Now(),
	}, "", nil)
	if err == nil {
		t.Fatal("expected park insert error to be propagated, got nil")
	}
}
