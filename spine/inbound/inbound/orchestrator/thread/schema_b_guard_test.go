package thread

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/lib/pq"
)

// TestSchemaBUnavailable locks the guard that fixed the 2026-05-24 inbound
// drought: when the legacy Schema-B tables (outreach_threads/outreach_contacts)
// were dropped, matchToThread's Schema-B rungs returned a Postgres
// undefined_table error (42P01). ProcessReply must treat that (and
// undefined_column, 42703) as "no Schema-B match" and degrade to the Schema-A
// reply_inbox fallback — NOT abort and drop the reply. Any OTHER error must
// still propagate so real failures aren't masked.
func TestSchemaBUnavailable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"undefined_table 42P01", &pq.Error{Code: "42P01", Message: `relation "outreach_contacts" does not exist`}, true},
		{"undefined_column 42703", &pq.Error{Code: "42703", Message: `column "mailbox_id" does not exist`}, true},
		{"wrapped undefined_table", fmt.Errorf("match by domain: %w", &pq.Error{Code: "42P01"}), true},
		{"other pq error (syntax)", &pq.Error{Code: "42601", Message: "syntax error"}, false},
		{"sql.ErrNoRows", sql.ErrNoRows, false},
		{"plain error", errors.New("connection refused"), false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := schemaBUnavailable(tc.err); got != tc.want {
				t.Fatalf("schemaBUnavailable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
