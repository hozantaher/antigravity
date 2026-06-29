package thread

import (
	"context"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// TestExtractBouncedRecipient covers the R3 helper that pulls a failed
// recipient address out of a DSN. The function must prefer the parsed
// Final-Recipient field, fall back to a body regex, and stay quiet on
// genuinely unparseable input.
func TestExtractBouncedRecipient(t *testing.T) {
	tests := []struct {
		name    string
		bounce  BounceInfo
		body    string
		want    string
	}{
		{
			name:   "structured final-recipient wins",
			bounce: BounceInfo{FailedRecipient: "jan@nezijici.cz"},
			body:   "irrelevant body <other@example.com>",
			want:   "jan@nezijici.cz",
		},
		{
			name:   "final-recipient lowercased + trimmed",
			bounce: BounceInfo{FailedRecipient: "  JAN@Nezijici.CZ  "},
			body:   "",
			want:   "jan@nezijici.cz",
		},
		{
			name:   "angle-bracket strip on FailedRecipient",
			bounce: BounceInfo{FailedRecipient: "<bob@bounce.test>"},
			body:   "",
			want:   "bob@bounce.test",
		},
		{
			name:   "body fallback when DSN field empty",
			bounce: BounceInfo{},
			body:   "Could not deliver to <pavel@firma.cz> at this time.",
			want:   "pavel@firma.cz",
		},
		{
			// 2026-05-18 hardening: previously this returned "" (false negative,
			// dropping ~110 bounces/day). New extractor recognizes plain
			// "Could not deliver to <addr>" patterns via plainRecipientLine.
			name:   "body fallback matches plain delivery-to mentions (extended 2026-05-18)",
			bounce: BounceInfo{},
			body:   "Could not deliver to pavel@firma.cz at this time.",
			want:   "pavel@firma.cz",
		},
		{
			name:   "no recipient extractable",
			bounce: BounceInfo{},
			body:   "Temporary failure, try again later.",
			want:   "",
		},
		{
			name:   "DSN diagnostic with smtp prefix doesn't confuse fallback",
			bounce: BounceInfo{FailedRecipient: "x@y.test"},
			body:   "Status: 5.1.1\r\nDiagnostic-Code: smtp;550 user unknown",
			want:   "x@y.test",
		},
		// 2026-05-18 hardening — additional fallback patterns
		{
			name:   "X-Failed-Recipients header (qmail / some MTAs)",
			bounce: BounceInfo{},
			body:   "From: postmaster@x.cz\r\nX-Failed-Recipients: lost.user@target.cz\r\nStatus: 5.1.1",
			want:   "lost.user@target.cz",
		},
		{
			name:   "Original-Recipient line (RFC 3464 §2.3.1)",
			bounce: BounceInfo{},
			body:   "Original-Recipient: rfc822; orig@bounce.cz\r\nStatus: 5.1.1",
			want:   "orig@bounce.cz",
		},
		{
			name:   "Embedded To: header of bounced message",
			bounce: BounceInfo{},
			body:   "Mail Delivery Subsystem: undelivered\r\n\r\n--- original ---\r\nTo: <victim@firma.cz>\r\nSubject: Dotaz\r\n",
			want:   "victim@firma.cz",
		},
		{
			name:   "Plain 'failed to deliver to <addr>' pattern",
			bounce: BounceInfo{},
			body:   "We have failed to deliver to lost@somewhere.cz: 550 mailbox full.",
			want:   "lost@somewhere.cz",
		},
		{
			name:   "Czech 'na adresu' phrasing",
			bounce: BounceInfo{},
			body:   "Doručení na adresu klient@firma.cz selhalo z důvodu...",
			want:   "klient@firma.cz",
		},
		{
			name:   "skip mailer-daemon / postmaster in any-email fallback",
			bounce: BounceInfo{},
			body:   "From: postmaster@seznam.cz\r\nReturn-Path: <>\r\nDelivery failed for the real-customer@target.cz address.",
			want:   "real-customer@target.cz",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractBouncedRecipient(tt.bounce, tt.body)
			if got != tt.want {
				t.Errorf("extractBouncedRecipient = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestProcessUnmatchedBounce_FlipsContact verifies the happy path:
// recipient extracted from DSN, contact row UPDATEd to bounce_hold,
// send_events flipped to 'bounced', audit row written. Returns
// handled=true so the caller skips parking.
func TestProcessUnmatchedBounce_FlipsContact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// 1. UPDATE contacts SET email_status='bounce_hold' RETURNING id
	mock.ExpectQuery(`UPDATE contacts\s+SET email_status = 'bounce_hold'`).
		WithArgs("jan@nezijici.cz").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(42)))

	// 2. UPDATE send_events SET status='bounced' WHERE contact_id=42
	mock.ExpectExec(`UPDATE send_events SET status = 'bounced'`).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 2))

	// 3. audit.Log INSERT
	mock.ExpectExec(`INSERT INTO operator_audit_log`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID: "<bounce-1@mta.test>",
		From:      "MAILER-DAEMON@mta.test",
		Subject:   "Undelivered Mail Returned to Sender",
		BodyPlain: "Status: 5.1.1",
	}
	bounce := BounceInfo{
		Kind:            BounceHard,
		DSNCode:         "5.1.1",
		Diagnostic:      "User unknown",
		FailedRecipient: "jan@nezijici.cz",
	}

	handled := p.processUnmatchedBounce(context.Background(), raw, bounce)
	if !handled {
		t.Fatalf("expected handled=true on contact flip")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestProcessUnmatchedBounce_NoRecipientExtractable falls through to
// the caller's parking path: no DB writes when extraction returns "".
func TestProcessUnmatchedBounce_NoRecipientExtractable(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// No queries expected — extraction fails immediately.

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID: "<bounce-2@mta.test>",
		BodyPlain: "Temporary failure, no recipient block.",
	}
	bounce := BounceInfo{
		Kind:    BounceHard,
		DSNCode: "5.0.0",
		// FailedRecipient empty + body has no <email>
	}

	handled := p.processUnmatchedBounce(context.Background(), raw, bounce)
	if handled {
		t.Fatalf("expected handled=false on empty recipient, got true")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestProcessUnmatchedBounce_ContactMissing falls through when the
// recipient doesn't exist in contacts (sql.ErrNoRows from RETURNING).
func TestProcessUnmatchedBounce_ContactMissing(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`UPDATE contacts\s+SET email_status = 'bounce_hold'`).
		WithArgs("ghost@nowhere.test").
		WillReturnRows(sqlmock.NewRows([]string{"id"})) // empty → ErrNoRows on Scan

	p := NewInboundProcessor(db)
	raw := RawInbound{
		MessageID: "<bounce-3@mta.test>",
		BodyPlain: "Status: 5.1.1",
	}
	bounce := BounceInfo{
		Kind:            BounceHard,
		DSNCode:         "5.1.1",
		FailedRecipient: "ghost@nowhere.test",
	}

	handled := p.processUnmatchedBounce(context.Background(), raw, bounce)
	if handled {
		t.Fatalf("expected handled=false on missing contact, got true")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// TestProcessUnmatchedBounce_NilDB returns false without panicking when
// the processor was constructed without a db (defensive — matches the
// pattern used by matchByEmail / matchByDomain).
func TestProcessUnmatchedBounce_NilDB(t *testing.T) {
	p := &InboundProcessor{}
	bounce := BounceInfo{Kind: BounceHard, FailedRecipient: "x@y.test"}
	if p.processUnmatchedBounce(context.Background(), RawInbound{}, bounce) {
		t.Fatalf("nil-db processor must return false")
	}
}
