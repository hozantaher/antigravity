package seed

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
)

const sourceTag = "e2e-seed"

// SeedResult holds the outcome of a seeding run.
type SeedResult struct {
	ContactsSchemaA int
	ContactsSchemaB int
	Domains         int
	FirmyCompanies  int
	CampaignID      int64
	CampaignName    string
	Enrolled        int
}

// SeedAll populates both database schemas with test data for full E2E testing.
// Schema A: contacts table (used by campaign pipeline)
// Schema B: outreach_contacts + outreach_domains (used by enrichment/intel)
// Seeds 60 contacts across 20 .test domains (3 contacts per domain).
// firmyDB is optional — pass nil to skip firmy_cz_businesses seeding.
func SeedAll(ctx context.Context, db *sql.DB, firmyDB *sql.DB) (*SeedResult, error) {
	result := &SeedResult{}

	// Idempotency: skip if already seeded
	var existing int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM contacts WHERE source = $1`, sourceTag,
	).Scan(&existing); err != nil {
		return nil, fmt.Errorf("check existing seed: %w", err)
	}
	if existing > 0 {
		return result, nil
	}

	data := testData()
	domains := uniqueDomains()

	// --- Schema B: outreach_domains ---
	domainIDs := make(map[string]int)
	for _, d := range domains {
		var id int
		err := db.QueryRowContext(ctx, `
			INSERT INTO outreach_domains (domain, domain_type, mx_verified, active_contacts, daily_send_cap)
			VALUES ($1, 'corporate', true, 3, 10)
			ON CONFLICT (domain) DO UPDATE SET domain_type = EXCLUDED.domain_type
			RETURNING id
		`, d).Scan(&id)
		if err != nil {
			return nil, fmt.Errorf("insert domain %s: %w", d, err)
		}
		domainIDs[d] = id
		result.Domains++
	}

	// --- Schema A: contacts (for campaign pipeline) ---
	// --- Schema B: outreach_contacts (for enrichment/intel) ---
	for _, c := range data {
		hash := emailHash(c.email)

		// Schema A
		_, err := db.ExecContext(ctx, `
			INSERT INTO contacts (email, email_hash, first_name, last_name, company_name, ico, region, industry, company_size, score, status, source)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'valid', $10)
			ON CONFLICT (email_hash) DO NOTHING
		`, c.email, hash, c.firstName, c.lastName, c.companyName, c.ico, c.region, c.industry, c.companySize, sourceTag)
		if err != nil {
			return nil, fmt.Errorf("insert contact-A %s: %w", c.email, err)
		}
		result.ContactsSchemaA++

		// Schema B
		industryTags := "{" + c.industry + "}"
		domainID := domainIDs[c.domain]
		_, err = db.ExecContext(ctx, `
			INSERT INTO outreach_contacts (
				email, email_hash, domain_id, first_name, last_name,
				company_name, ico, region, industry_tags, industry_confidence,
				company_size, targeting_score, status, source
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0.85, $10, 0.75, 'active', $11)
			ON CONFLICT (email_hash) DO NOTHING
		`, c.email, hash, domainID, c.firstName, c.lastName,
			c.companyName, c.ico, c.region, industryTags,
			c.companySize, sourceTag)
		if err != nil {
			return nil, fmt.Errorf("insert contact-B %s: %w", c.email, err)
		}
		result.ContactsSchemaB++
	}

	// --- firmy_cz_businesses (optional) ---
	if firmyDB != nil {
		for _, fc := range firmyCompanies() {
			_, err := firmyDB.ExecContext(ctx, `
				INSERT INTO firmy_cz_businesses (name, email, ico, address_locality, velikost_firmy, category_path)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT DO NOTHING
			`, fc.name, fc.email, fc.ico, fc.region, fc.size, fc.category)
			if err != nil {
				slog.Warn("firmy seed insert failed", "op", "SeedAll/firmyInsert", "name", fc.name, "error", err)
				continue
			}
			result.FirmyCompanies++
		}
	}

	// --- Campaign ---
	campaignName := "E2E Test Campaign"
	steps := []map[string]any{
		{"step": 0, "delay_days": 0, "template": "initial"},
		{"step": 1, "delay_days": 5, "template": "followup1"},
		{"step": 2, "delay_days": 12, "template": "final"},
	}
	seqJSON, _ := json.Marshal(steps)
	sendJSON, _ := json.Marshal(map[string]any{})

	var campaignID int64
	err := db.QueryRowContext(ctx, `
		INSERT INTO campaigns (name, status, sequence_config, sending_config)
		VALUES ($1, 'draft', $2, $3)
		RETURNING id
	`, campaignName, seqJSON, sendJSON).Scan(&campaignID)
	if err != nil {
		return nil, fmt.Errorf("create campaign: %w", err)
	}
	result.CampaignID = campaignID
	result.CampaignName = campaignName

	// Enroll all e2e-seed contacts
	res, err := db.ExecContext(ctx, `
		INSERT INTO campaign_contacts (campaign_id, contact_id, status)
		SELECT $1, id, 'pending' FROM contacts WHERE source = $2
	`, campaignID, sourceTag)
	if err != nil {
		return nil, fmt.Errorf("enroll contacts: %w", err)
	}
	enrolled, _ := res.RowsAffected()
	result.Enrolled = int(enrolled)

	return result, nil
}

// ClearAll removes all e2e-seed data from both schemas.
func ClearAll(ctx context.Context, db *sql.DB, firmyDB *sql.DB) error {
	queries := []struct {
		desc  string
		query string
	}{
		{"send_events", `DELETE FROM send_events WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE 'E2E Test%')`},
		{"campaign_contacts", `DELETE FROM campaign_contacts WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE 'E2E Test%')`},
		{"campaigns", `DELETE FROM campaigns WHERE name LIKE 'E2E Test%'`},
		{"tracking_events", `DELETE FROM tracking_events WHERE send_event_id IN (SELECT id FROM send_events WHERE contact_id IN (SELECT id FROM contacts WHERE source = 'e2e-seed'))`},
		{"contacts", `DELETE FROM contacts WHERE source = 'e2e-seed'`},
		{"outreach_events", `DELETE FROM outreach_events WHERE thread_id IN (SELECT id FROM outreach_threads WHERE contact_id IN (SELECT id FROM outreach_contacts WHERE source = 'e2e-seed'))`},
		{"outreach_messages", `DELETE FROM outreach_messages WHERE thread_id IN (SELECT id FROM outreach_threads WHERE contact_id IN (SELECT id FROM outreach_contacts WHERE source = 'e2e-seed'))`},
		{"outreach_threads", `DELETE FROM outreach_threads WHERE contact_id IN (SELECT id FROM outreach_contacts WHERE source = 'e2e-seed')`},
		{"honeypot_signals", `DELETE FROM outreach_honeypot_signals WHERE contact_id IN (SELECT id FROM outreach_contacts WHERE source = 'e2e-seed')`},
		{"score_history", `DELETE FROM outreach_score_history WHERE contact_id IN (SELECT id FROM outreach_contacts WHERE source = 'e2e-seed')`},
		{"outreach_contacts", `DELETE FROM outreach_contacts WHERE source = 'e2e-seed'`},
		{"outreach_domains", `DELETE FROM outreach_domains WHERE domain LIKE '%.test' AND domain NOT LIKE '%validation-seed%' AND NOT EXISTS (SELECT 1 FROM outreach_contacts WHERE domain_id = outreach_domains.id)`},
	}

	for _, q := range queries {
		if _, err := db.ExecContext(ctx, q.query); err != nil {
			return fmt.Errorf("clear %s: %w", q.desc, err)
		}
	}

	if firmyDB != nil {
		if _, err := firmyDB.ExecContext(ctx, `DELETE FROM firmy_cz_businesses WHERE email LIKE '%@%.test'`); err != nil {
			slog.Warn("clear firmy data failed", "op", "SeedAll/clearFail", "error", err)
		}
	}

	return nil
}

// FormatResult returns a human-readable summary with next-steps checklist.
func FormatResult(r *SeedResult) string {
	var b strings.Builder
	b.WriteString("=== E2E Test Data Seeded ===\n")
	fmt.Fprintf(&b, "Contacts (Schema A):     %d (status=valid)\n", r.ContactsSchemaA)
	fmt.Fprintf(&b, "Outreach contacts (B):   %d\n", r.ContactsSchemaB)
	fmt.Fprintf(&b, "Outreach domains:        %d\n", r.Domains)
	if r.FirmyCompanies > 0 {
		fmt.Fprintf(&b, "Firmy companies:         %d\n", r.FirmyCompanies)
	} else {
		b.WriteString("Firmy companies:         skipped (FIRMY_DSN not set)\n")
	}
	fmt.Fprintf(&b, "Campaign created:        \"%s\" (ID: %d, draft)\n", r.CampaignName, r.CampaignID)
	fmt.Fprintf(&b, "Contacts enrolled:       %d\n", r.Enrolled)

	b.WriteString("\n=== Environment (copy-paste) ===\n")
	b.WriteString("export DB_HOST=localhost DB_PORT=5433 DB_NAME=outreach DB_USER=outreach DB_PASSWORD=outreach DB_SSL_MODE=disable\n")
	b.WriteString("export MAILBOX_1_ADDRESS=test@local.dev MAILBOX_1_SMTP_HOST=localhost MAILBOX_1_SMTP_PORT=1025\n")
	b.WriteString("export MAILBOX_1_IMAP_HOST=localhost MAILBOX_1_IMAP_PORT=1143 MAILBOX_1_DAILY_LIMIT=100\n")
	b.WriteString("export DEV_MODE=1 SKIP_CALENDAR_CHECK=1\n")

	b.WriteString("\n=== Next Steps ===\n")
	fmt.Fprintf(&b, "1. Start campaign:\n")
	fmt.Fprintf(&b, "   go run ./cmd/outreach campaign-run %d\n\n", r.CampaignID)
	b.WriteString("2. Poll for replies (after sending):\n")
	b.WriteString("   go run ./cmd/outreach poll\n\n")
	b.WriteString("3. Run intelligence loop:\n")
	b.WriteString("   go run ./cmd/outreach intel --once\n\n")
	b.WriteString("4. Validate scores:\n")
	b.WriteString("   go run ./cmd/outreach validate-consent\n")
	b.WriteString("   go run ./cmd/outreach validate-honeypot\n\n")
	b.WriteString("5. Clear test data when done:\n")
	b.WriteString("   go run ./cmd/outreach seed --clear\n")

	return b.String()
}

func emailHash(email string) string {
	h := sha256.Sum256([]byte(strings.ToLower(email)))
	return fmt.Sprintf("%x", h[:8])
}
