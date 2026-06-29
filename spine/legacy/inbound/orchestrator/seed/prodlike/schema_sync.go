package prodlike

import (
	"context"
	"database/sql"
	"fmt"
)

// SyncSchemaA mirrors rows from outreach_contacts (Schema B) into
// contacts (Schema A) so campaign enrollment can find prodlike contacts
// without waiting for the intel-daemon startup backfill.
//
// This is the same upsert logic cmd/outreach/main.go:277-299 runs
// automatically on daemon start — lifted here so seed+scenarios can
// operate stand-alone. Idempotent via ON CONFLICT (email_hash).
//
// Returns the number of rows inserted/updated. The function does not
// transactionally wrap the upsert; large volumes are fine because the
// statement is a single bulk INSERT ... SELECT.
func SyncSchemaA(ctx context.Context, db *sql.DB) (int64, error) {
	res, err := db.ExecContext(ctx, `
		INSERT INTO contacts (
			email, email_hash, first_name, company_name, ico, region,
			industry, company_size, score, status, source
		)
		SELECT
			oc.email, oc.email_hash, oc.first_name, oc.company_name, oc.ico, oc.region,
			COALESCE(oc.industry_tags[1], ''), oc.company_size,
			LEAST(GREATEST(ROUND(oc.targeting_score * 100)::int, 0), 100),
			CASE
				WHEN oc.status IN ('bounced','unsubscribed','blacklisted','invalid') THEN oc.status
				ELSE 'valid'
			END,
			oc.source
		FROM outreach_contacts oc
		WHERE oc.source LIKE 'prodlike-%'
			AND oc.email != ''
		ON CONFLICT (email_hash) DO UPDATE SET
			score = EXCLUDED.score,
			status = CASE
				WHEN contacts.status IN ('bounced','unsubscribed','blacklisted') THEN contacts.status
				ELSE 'valid' END,
			company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
			region = COALESCE(EXCLUDED.region, contacts.region),
			industry = COALESCE(EXCLUDED.industry, contacts.industry),
			updated_at = now()
	`)
	if err != nil {
		return 0, fmt.Errorf("sync schema A: %w", err)
	}
	return res.RowsAffected()
}

// VerifySchemaParity returns true if every prodlike outreach_contacts
// row has a matching contacts row on email_hash, and vice versa (for
// the prodlike slice). Used by integration tests to assert the sync
// converged.
func VerifySchemaParity(ctx context.Context, db *sql.DB) (outreachCount, contactsCount int, parity bool, err error) {
	err = db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM outreach_contacts
		WHERE source LIKE 'prodlike-%' AND email != ''`,
	).Scan(&outreachCount)
	if err != nil {
		return
	}
	// contacts mirrors keyed by email_hash; count the overlap.
	err = db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM contacts c
		WHERE c.source LIKE 'prodlike-%'
			AND EXISTS (
				SELECT 1 FROM outreach_contacts oc
				WHERE oc.email_hash = c.email_hash
					AND oc.source LIKE 'prodlike-%'
			)`,
	).Scan(&contactsCount)
	if err != nil {
		return
	}
	parity = outreachCount == contactsCount
	return
}
