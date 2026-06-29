package thread

import (
	"context"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// Incident 2026-06-23 — a degraded wgpool (8 mailboxes vs 6 SOCKS5 endpoints
// after the .79-.82 fleet expansion) produced ~30 partial/empty IMAP fetches
// that landed in unmatched_inbound as empty "Neznámý odesílatel / (bez
// předmětu)" rows. isEmptyFailedFetch is the guard that recognises that
// signature (no From + synthetic/empty Message-ID + no Subject) so
// parkUnattributed skips the INSERT instead of surfacing operator noise.

func TestIsEmptyFailedFetch(t *testing.T) {
	tests := []struct {
		name string
		raw  RawInbound
		want bool
	}{
		// --- failed-fetch signatures (skip) ---
		{"all empty", RawInbound{From: "", Subject: "", MessageID: ""}, true},
		{"synthetic uid id (the incident shape)", RawInbound{From: "", Subject: "", MessageID: "uid:3947@imap.post.cz"}, true},
		{"whitespace-only fields", RawInbound{From: "   ", Subject: "\t", MessageID: "  "}, true},
		{"synthetic id + whitespace from/subject", RawInbound{From: " ", Subject: "  ", MessageID: "uid:1@imap.post.cz"}, true},
		{"base64 image body but empty headers", RawInbound{From: "", Subject: "", MessageID: "uid:7071@imap.post.cz", BodyPlain: "/9j/4TTWRXhpZgAA"}, true},

		// --- real / recoverable messages (keep) ---
		{"real reply", RawInbound{From: "boss@strojirny.cz", Subject: "Re: nabídka rýpadla", MessageID: "<a1@firma.cz>"}, false},
		{"real From, empty subject + synthetic id", RawInbound{From: "boss@strojirny.cz", Subject: "", MessageID: "uid:5@imap.post.cz"}, false},
		{"real Subject, empty From + synthetic id", RawInbound{From: "", Subject: "Re: ahoj", MessageID: "uid:5@imap.post.cz"}, false},
		{"real Message-ID, empty From + subject", RawInbound{From: "", Subject: "", MessageID: "<real@host.cz>"}, false},
		{"bounce sender, empty subject + synthetic id", RawInbound{From: "MAILER-DAEMON@seznam.cz", Subject: "", MessageID: "uid:9@imap.post.cz"}, false},
		{"From with display name", RawInbound{From: "Jan Novák <jan@x.cz>", Subject: "", MessageID: "uid:1@imap.post.cz"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isEmptyFailedFetch(tt.raw); got != tt.want {
				t.Errorf("isEmptyFailedFetch(%+v) = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
}

// A failed-fetch artifact must NOT INSERT into unmatched_inbound: the sqlmock
// has zero expectations, so any query at all fails ExpectationsWereMet, and the
// guard must return nil (skip, watermark advances — no retry storm).
func TestParkUnattributed_SkipsEmptyFailedFetch(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	raw := RawInbound{
		MessageID:   "uid:3947@imap.post.cz", // synthetic
		From:        "",
		Subject:     "",
		BodyPlain:   "/9j/4TTWRXhpZgAATU0AKgAA", // stray base64 image
		MailboxAddr: "hozan.taher.75@post.cz",
		ReceivedAt:  time.Date(2026, 6, 23, 17, 33, 0, 0, time.UTC),
	}

	if err := p.parkUnattributed(context.Background(), raw, "", nil); err != nil {
		t.Errorf("parkUnattributed should skip empty fetch and return nil, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("no DB query expected for an empty fetch: %v", err)
	}
}

// Guard must be narrow: a real From with an empty subject + synthetic id is a
// recoverable (if odd) message and MUST still be persisted — losing it would be
// a regression worse than the noise we are removing.
func TestParkUnattributed_RealFromEmptySubjectStillInserts(t *testing.T) {
	db, mock := newMockDB(t)
	p := NewInboundProcessor(db)

	receivedAt := time.Date(2026, 6, 23, 18, 0, 0, 0, time.UTC)
	raw := RawInbound{
		MessageID:  "uid:42@imap.post.cz", // synthetic, but From is real
		From:       "boss@strojirny.cz",
		Subject:    "",
		BodyPlain:  "Máme zájem o ten bagr",
		ReceivedAt: receivedAt,
	}

	mock.ExpectQuery(`INSERT INTO unmatched_inbound`).
		WithArgs(
			raw.MessageID,
			"",
			raw.From,
			"",
			raw.BodyPlain,
			"",
			receivedAt,
			sqlmock.AnyArg(),
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(303)))

	if err := p.parkUnattributed(context.Background(), raw, "", nil); err != nil {
		t.Errorf("real-From message must still INSERT, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}
