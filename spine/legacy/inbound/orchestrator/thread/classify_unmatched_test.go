package thread

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// AJ-bounce (2026-05-18) — classifyUnmatched recognises the canonical
// MAILER-DAEMON / postmaster sender shapes + the most common DSN +
// auto-reply subject lines so parkUnattributed can tag rows on INSERT.
// The BFF /api/replies endpoint then hides bounce-classified rows from
// the operator's default view.
//
// Coverage shape mirrors the regex constants:
//   - From-header shapes:    mailer-daemon variants, postmaster, mail
//                            delivery system/subsystem/service.
//   - Subject DSN hints:     undeliverable, undelivered, nedoručitelná,
//                            returned to sender, delivery status/failure/
//                            notification/problem, could not be delivered,
//                            rejected:.
//   - Auto-reply hints:      automatická odpověď (CS), out of office (EN),
//                            am abwesend (DE).
//   - Non-matching:          real customer replies must return "".

func TestClassifyUnmatched_BounceFromAddress(t *testing.T) {
	tests := []struct {
		name string
		from string
	}{
		{"canonical MAILER-DAEMON", "MAILER-DAEMON@seznam.cz"},
		{"lowercase mailer-daemon", "mailer-daemon@example.com"},
		{"mixed-case Mailer-Daemon", "Mailer-Daemon <mailer-daemon@gmail.com>"},
		{"postmaster", "postmaster@balkanmotors.cz"},
		{"Mail Delivery Subsystem", `"Mail Delivery Subsystem" <noreply@exchange.example>`},
		{"mail delivery system spaced", "mail-delivery-system@cisco.example"},
		{"mail delivery service", "Mail Delivery Service <bounce@yandex.example>"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyUnmatched(tt.from, "Re: schůzka")
			if got != ClassificationBounce {
				t.Errorf("classifyUnmatched(%q) = %q, want %q", tt.from, got, ClassificationBounce)
			}
		})
	}
}

func TestClassifyUnmatched_BounceSubject(t *testing.T) {
	tests := []struct {
		name    string
		subject string
	}{
		{"Undeliverable", "Undeliverable: Re: ahoj"},
		{"undelivered lowercase", "your message was undelivered"},
		{"czech nedoručitelná", "Nedoručitelná zpráva"},
		{"returned to sender", "Returned to sender"},
		{"delivery status notification", "Delivery Status Notification (Failure)"},
		{"delivery failure", "delivery failure notice"},
		{"delivery problem", "Delivery problem report"},
		{"mail delivery system", "Mail delivery system: failure"},
		{"mail delivery fail", "mail delivery failed: returning"},
		{"could not be delivered", "Your message could not be delivered"},
		{"rejected:", "rejected: spam policy"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Use a benign sender so only the subject hint can fire.
			got := classifyUnmatched("info@firma.cz", tt.subject)
			if got != ClassificationBounce {
				t.Errorf("classifyUnmatched(subject=%q) = %q, want %q", tt.subject, got, ClassificationBounce)
			}
		})
	}
}

func TestClassifyUnmatched_AutoReplySubject(t *testing.T) {
	tests := []struct {
		name    string
		subject string
	}{
		{"czech automaticka odpoved", "Automatická odpověď: Re: nabídka"},
		{"english out of office", "Out of office until 2026-06-01"},
		{"english i am out of", "I am out of the office this week"},
		{"english absence", "Absence — back next Monday"},
		{"german am abwesend", "Ich bin am abwesend"},
		{"english automatic reply", "Automatic reply: Re: dotaz"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyUnmatched("ivana@firma.cz", tt.subject)
			if got != ClassificationAutoReply {
				t.Errorf("classifyUnmatched(subject=%q) = %q, want %q", tt.subject, got, ClassificationAutoReply)
			}
		})
	}
}

func TestClassifyUnmatched_RealReply_NotMatched(t *testing.T) {
	tests := []struct {
		name    string
		from    string
		subject string
	}{
		{"normal CZ reply", "boss@strojirny.cz", "Re: nabídka prodeje rýpadla"},
		{"normal EN reply", "buyer@company.com", "Re: meeting next week"},
		{"empty subject", "boss@strojirny.cz", ""},
		{"empty from", "", "Re: hi"},
		{"forwarded message", "vladimir@example.cz", "Fwd: nabídka strojů"},
		{"similar but not match", "noreply@firma.cz", "Notification: 5 nových zpráv"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyUnmatched(tt.from, tt.subject)
			if got != ClassificationNone {
				t.Errorf("classifyUnmatched(%q, %q) = %q, want empty", tt.from, tt.subject, got)
			}
		})
	}
}

// Bounce sender wins over auto-reply subject — a forwarded DSN whose
// body opened with "Automatická odpověď" must still classify as bounce.
func TestClassifyUnmatched_BounceFromBeatsAutoReplySubject(t *testing.T) {
	got := classifyUnmatched("MAILER-DAEMON@seznam.cz", "Automatická odpověď: dovolená")
	if got != ClassificationBounce {
		t.Errorf("classifyUnmatched(MAILER-DAEMON, auto-reply subject) = %q, want %q", got, ClassificationBounce)
	}
}

// parkUnattributed INSERT carries the classification arg in slot 8.
// We assert with WithArgs so a future drift (e.g. moving the column
// before received_at) breaks the test immediately rather than at
// production runtime.
func TestParkUnattributed_PersistsClassification(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	receivedAt := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	raw := RawInbound{
		MessageID:  "bounce-msg-id@seznam.cz",
		InReplyTo:  "<orig@example.com>",
		From:       "MAILER-DAEMON@seznam.cz",
		Subject:    "Undeliverable: Re: ahoj",
		BodyPlain:  "Your message could not be delivered",
		ReceivedAt: receivedAt,
	}

	// classification arg is sql.NullString{Valid:true, String:"bounce"}.
	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WithArgs(
			raw.MessageID,
			raw.InReplyTo,
			raw.From,
			raw.Subject,
			raw.BodyPlain,
			"",
			receivedAt,
			sqlmock.AnyArg(), // sql.NullString — exact equality is fragile across pq versions
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(101)))

	p.parkUnattributed(context.Background(), raw, "", nil)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// Real reply (no bounce signal) must pass an explicit non-Valid
// classification arg so the DB stores NULL — preserving the existing
// operator-set classification when the dashboard later annotates.
func TestParkUnattributed_RealReplyClassifiesAsNull(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	receivedAt := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	raw := RawInbound{
		MessageID:  "real-reply-id@firma.cz",
		From:       "boss@strojirny.cz",
		Subject:    "Re: nabídka prodeje rýpadla",
		BodyPlain:  "Máme zájem",
		ReceivedAt: receivedAt,
	}

	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WithArgs(
			raw.MessageID,
			"",
			raw.From,
			raw.Subject,
			raw.BodyPlain,
			"",
			receivedAt,
			sqlmock.AnyArg(),
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(202)))

	p.parkUnattributed(context.Background(), raw, "", nil)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}
