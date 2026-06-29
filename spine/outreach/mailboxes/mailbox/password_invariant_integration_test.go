//go:build integration
// +build integration

package mailbox_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"

	"mailboxes/mailbox"
)

// TestInvariant_NoPlaceholderPasswordsInDB is an opt-in integration test
// that guards the outreach_mailboxes table against rows carrying
// placeholder credentials (see 2026-04-22 SEND-S6.1 debug: 4 Seznam rows
// held the literal value "123p123p123p123" which caused SMTP 535 5.7.8
// and blocked the send pipeline).
//
// Run with:
//
//	DATABASE_URL=postgres://... go test -tags=integration \
//	  -run Invariant_NoPlaceholderPasswordsInDB \
//	  ./internal/mailbox/ -count=1
//
// Safety: the test NEVER logs the password value. On failure it reports
// only the mailbox id, the from_address, the length of the offending
// password, and its first two characters, which is enough to identify the
// row in the Railway dashboard without leaking the secret to CI logs.
func TestInvariant_NoPlaceholderPasswordsInDB(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping placeholder-password invariant")
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("db.Ping: %v", err)
	}

	rows, err := db.QueryContext(ctx, `
		SELECT id, from_address, password
		FROM outreach_mailboxes
		WHERE password IS NOT NULL
	`)
	if err != nil {
		t.Fatalf("query outreach_mailboxes: %v", err)
	}
	defer rows.Close()

	type offender struct {
		id       int64
		fromAddr string
		pwLen    int
		pwHead   string // first 2 chars only, never the full value
	}
	var offenders []offender
	var total int

	for rows.Next() {
		var (
			id       int64
			fromAddr string
			password string
		)
		if err := rows.Scan(&id, &fromAddr, &password); err != nil {
			t.Fatalf("scan: %v", err)
		}
		total++
		if mailbox.IsPlaceholderPassword(password) {
			head := password
			if len(head) > 2 {
				head = head[:2]
			}
			offenders = append(offenders, offender{
				id:       id,
				fromAddr: fromAddr,
				pwLen:    len(password),
				pwHead:   head,
			})
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}

	if total == 0 {
		t.Skip("no rows in outreach_mailboxes; nothing to validate")
	}

	if len(offenders) > 0 {
		var sb strings.Builder
		fmt.Fprintf(&sb,
			"found %d/%d mailbox rows with placeholder passwords (never logged; see head/len only):\n",
			len(offenders), total)
		for _, o := range offenders {
			fmt.Fprintf(&sb,
				"  - id=%d from=%s pw_len=%d pw_head=%q…\n",
				o.id, o.fromAddr, o.pwLen, o.pwHead)
		}
		t.Fatal(sb.String())
	}
}
