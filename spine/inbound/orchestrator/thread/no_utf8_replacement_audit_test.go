package thread

import (
	"database/sql"
	"os"
	"testing"

	_ "github.com/lib/pq"
)

// TestNoUTF8ReplacementAudit is the AL-F3 audit ratchet: it asserts the
// number of stored rows containing U+FFFD (REPLACEMENT CHARACTER, chr(65533))
// in body_preview / body_html / body_text across unmatched_inbound +
// outreach_messages stays at or below the baseline. (reply_inbox does
// not persist body bytes, only headers — outreach_messages is the
// thread-attached body store.)
//
// Baseline (2026-05-18): 1 row in unmatched_inbound (id=504, real-world
// windows-1250 quoted-printable Outlook reply ingested before AL-F3
// landed). The raw IMAP message is no longer fetchable, so the row is
// unrecoverable — migration 119 marks it `classification='corrupted_charset'`
// so it disappears from the default operator inbox without us deleting
// historical evidence.
//
// New ingestions after AL-F3 must go through the charset-aware decoder
// in services/orchestrator/mime/parser.go::decodeBodyText, which
// transcodes windows-1250 / iso-8859-2 / latin1 → UTF-8 before
// stringifying. So the ratchet baseline is the count of pre-AL-F3
// corrupted rows; any regression bumps the count and fails CI.
//
// Skipped unless DATABASE_URL is set so the unit-test suite still runs
// offline (CI sets DATABASE_URL in the integration job).
func TestNoUTF8ReplacementAudit(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set — skipping AL-F3 corruption ratchet")
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatalf("db.Ping: %v", err)
	}

	const baseline = 1 // AL-F3 (2026-05-18): id=504 unrecoverable pre-fix row.

	queries := []struct {
		name  string
		query string
	}{
		{
			name: "unmatched_inbound",
			query: `
				SELECT count(*)
				  FROM unmatched_inbound
				 WHERE position(chr(65533) IN coalesce(body_preview, '')) > 0
				    OR position(chr(65533) IN coalesce(body_html, '')) > 0
			`,
		},
		{
			name: "outreach_messages",
			query: `
				SELECT count(*)
				  FROM outreach_messages
				 WHERE position(chr(65533) IN coalesce(body_preview, '')) > 0
				    OR position(chr(65533) IN coalesce(body_text, '')) > 0
			`,
		},
	}

	total := 0
	for _, q := range queries {
		var n int
		if err := db.QueryRow(q.query).Scan(&n); err != nil {
			// reply_inbox is optional; tolerate missing-table errors so
			// the ratchet still protects unmatched_inbound on environments
			// where reply_inbox has not yet been provisioned.
			t.Logf("scan %s: %v (treating as 0)", q.name, err)
			continue
		}
		t.Logf("%s: %d row(s) with U+FFFD", q.name, n)
		total += n
	}

	if total > baseline {
		t.Errorf("AL-F3 ratchet regression: %d rows with U+FFFD (baseline %d). "+
			"A new ingestion bypassed mime.decodeBodyText. "+
			"Suspect a new code path that calls string(bodyBytes) without charset transcoding, "+
			"or a fixture loader that bypasses services/orchestrator/mime/parser.go.",
			total, baseline)
	}
}
